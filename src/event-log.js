// The account event log the dashboard's Logs page reads (GET /teamclaude/logs).
//
// The terminal already shows what the proxy is doing, but only to whoever is
// watching that terminal: a browser on another machine sees counters, not the
// story behind them. This keeps the last few thousand things that happened to
// the accounts — requests served, sign-ins, sign-outs, rotation decisions,
// operator changes — as structured entries a page can filter by kind, provider
// and account.
//
// Memory only, on purpose. A restart starts a fresh log: the file logs
// (`--activity-log`, `logDir`) are the durable record, and a second copy on
// disk would be one more file holding account names to keep private.
//
// What an entry may carry is narrow, because GET /teamclaude/logs answers
// anyone who may read /teamclaude/status, client keys included: an account's
// configured name (never an email the upstream reported, a token or an org
// id), a model, a status code, token counts and latency, and a short reason.
// Reasons are codes or one-line messages written here, never a response body.
// A request entry also names the client that sent it: the client key's name
// and the first token of its User-Agent (`claude-cli/2.1.3`). The prompt it
// carried is kept only when the operator opted in (`proxy.logPrompts`): it is
// the one field that holds what a person wrote, and every key holder reads it.

import { randomUUID } from 'node:crypto';
import { safeLine } from './safe-text.js';

/** How many entries are kept before the oldest are dropped. */
export const EVENT_LOG_CAPACITY = 2000;

/** The most entries one read returns, so a first poll of a full log stays small. */
export const EVENT_LOG_PAGE = 500;

/**
 * The filter groups the Logs page offers. `usage` is a request served,
 * `signin` an interactive sign-in (started, succeeded, failed, timed out,
 * cancelled), `auth` an account losing its credentials, `rotation` the router
 * moving off an account or holding, `control` an operator change made from
 * the dashboard or the CLI.
 * @typedef {'usage'|'signin'|'auth'|'rotation'|'control'} EventKind
 */
export const EVENT_KINDS = /** @type {const} */ (['usage', 'signin', 'auth', 'rotation', 'control']);

/**
 * @typedef {Object} LogEvent
 * @property {number} id         increasing; a reader asks for entries after the last id it saw
 * @property {string} at         ISO time the event was recorded
 * @property {EventKind} kind
 * @property {string} type       what happened, e.g. 'request', 'signin_failed', 'signed_out', 'switch'
 * @property {string|null} provider
 * @property {string|null} account
 * @property {string} message    one line, for people
 * @property {string|null} [model]
 * @property {number|null} [status]
 * @property {number|null} [inputTokens]
 * @property {number|null} [outputTokens]
 * @property {number|null} [ms]
 * @property {string|null} [reason]  a short machine-readable code
 * @property {string|null} [client]  the client key's name, for a request
 * @property {string|null} [agent]   the first token of the client's User-Agent
 * @property {string|null} [prompt]  the request's last user text, with proxy.logPrompts on
 */

/** How much of a prompt an entry keeps: enough to tell requests apart. */
export const PROMPT_MAX = 300;

/** Fields an entry may carry beyond the fixed ones, and how each is kept. */
const NUMBER_FIELDS = /** @type {const} */ (['status', 'inputTokens', 'outputTokens', 'ms']);
const TEXT_FIELDS = /** @type {const} */ ([['model', 80], ['reason', 60], ['client', 80], ['agent', 60], ['prompt', PROMPT_MAX]]);

/**
 * A non-negative finite number, or null.
 * @param {unknown} value
 * @returns {number|null}
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * A sanitised single line, or null for an empty or absent value.
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function line(value, max) {
  if (value == null || value === '') return null;
  return safeLine(String(value), max);
}

export class EventLog {
  /**
   * @param {{ capacity?: number, now?: () => number }} [opts]
   */
  constructor({ capacity = EVENT_LOG_CAPACITY, now = Date.now } = {}) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.now = now;
    /** @type {LogEvent[]} */
    this.entries = [];
    this.lastId = 0;
    // Names this log. Ids restart at 1 with every process, so a reader that
    // held events from the last one cannot tell from ids alone whether it
    // missed the new one's first entries; a different generation says so.
    this.generation = randomUUID();
  }

  /**
   * Record one event. Unknown kinds are refused rather than stored, so the
   * page's filter groups always cover everything in the log.
   * @param {{ kind: EventKind, type: string, message: string, provider?: string|null, account?: string|null } & Record<string, any>} event
   * @returns {LogEvent|null}
   */
  add(event) {
    if (!event || !EVENT_KINDS.includes(event.kind)) return null;
    /** @type {LogEvent} */
    const entry = {
      id: ++this.lastId,
      at: new Date(this.now()).toISOString(),
      kind: event.kind,
      type: line(event.type, 40) ?? 'event',
      provider: line(event.provider, 20),
      account: line(event.account, 80),
      message: line(event.message, 200) ?? '',
    };
    for (const key of NUMBER_FIELDS) {
      if (event[key] != null) entry[key] = count(event[key]);
    }
    for (const [key, max] of TEXT_FIELDS) {
      if (event[key] != null) entry[key] = line(event[key], max);
    }
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return entry;
  }

  /**
   * Entries recorded after `after`, oldest first, at most `limit` of them —
   * the newest ones when there are more, so a reader that fell behind skips
   * to the present instead of paging through history it never saw.
   * @param {number} [after]
   * @param {number} [limit]
   * @returns {{ events: LogEvent[], lastId: number, capacity: number, generation: string }}
   */
  since(after = 0, limit = EVENT_LOG_PAGE) {
    const from = Number.isFinite(after) && after > 0 ? after : 0;
    const max = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : EVENT_LOG_PAGE, EVENT_LOG_PAGE));
    // Ids are dense and increasing, so the first entry newer than `from` is
    // found by offset from the oldest one kept rather than by scanning.
    const oldest = this.entries[0]?.id ?? this.lastId + 1;
    const start = Math.max(0, from + 1 - oldest);
    const newer = this.entries.slice(start);
    return { events: newer.slice(-max), lastId: this.lastId, capacity: this.capacity, generation: this.generation };
  }
}

/**
 * The event-log entry for a switch threshold that changed: one number, or a
 * per-bucket table. Built here so the reload that applies a CLI or dashboard
 * change and the TUI's settings screen word it the same way.
 * @param {unknown} threshold  the new switchThreshold
 * @returns {{ kind: 'control', type: 'threshold', message: string }}
 */
export function thresholdEvent(threshold) {
  const message = typeof threshold === 'number' && Number.isFinite(threshold)
    ? `Switch threshold set to ${Math.round(threshold * 1000) / 10}%`
    : 'Switch thresholds set per quota bucket';
  return { kind: 'control', type: 'threshold', message };
}

/**
 * Parse the `after` query of GET /teamclaude/logs: a non-negative integer, or 0.
 * @param {string|undefined} url
 * @returns {number}
 */
export function logsAfter(url) {
  const query = String(url || '').split('?')[1] || '';
  const value = new URLSearchParams(query).get('after');
  const n = value != null && /^\d{1,15}$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

/**
 * A sign-in failure as one line safe for anyone who may read the log. The
 * errors a login throws carry upstream text: a token endpoint's response body,
 * an OAuth error_description, a profile lookup's body. So the line is never
 * the error's own message. It is one of a few fixed phrases, keeping only an
 * HTTP status or an OAuth error code (`access_denied`) from it, unless the
 * thrower marked a message of its own as public (`publicMessage`).
 * @param {unknown} error
 * @returns {string}
 */
export function briefError(error) {
  const err = /** @type {any} */ (error);
  if (typeof err?.publicMessage === 'string' && err.publicMessage) return safeLine(err.publicMessage, 160);
  const message = String(err?.message ?? err ?? '');
  const refused = /^(?:The sign-in was refused|OpenAI refused the sign-in): ([a-z_]{1,40})\b/.exec(message);
  if (refused) return `the provider refused the sign-in (${refused[1]})`;
  if (/^Could not identify OAuth account/.test(message)) return 'the signed-in account\'s profile could not be read';
  const status = /(?:\(|HTTP )(\d{3})\b/.exec(message);
  if (status) return `the provider answered HTTP ${status[1]}`;
  if (/^That /.test(message)) return 'the pasted code or address could not be used';
  return 'the full reason is in the server\'s output';
}

/**
 * The event-log entry for one step of an interactive sign-in, from the
 * terminal's login panel or the dashboard. A failure is classified: an
 * AbortError is the operator cancelling, a "timed out" error the flow's own
 * deadline, anything else a failure.
 * @param {'started'|'succeeded'|'failed'} step
 * @param {{ provider: string, account?: string|null, via: string, error?: unknown, detail?: string|null }} info  `provider` 'claude' is recorded as 'anthropic'
 * @returns {{ kind: 'signin', type: string, provider: string, account: string|null, message: string, reason?: string }}
 */
export function signInEvent(step, { provider, account = null, via, error = null, detail = null }) {
  // Named the way every other entry names it (provider.js ids), so the Logs
  // page's provider filter finds a sign-in beside the requests it led to.
  const base = { kind: /** @type {const} */ ('signin'), provider: provider === 'claude' ? 'anthropic' : provider, account };
  if (step === 'started') return { ...base, type: 'signin_started', message: `Sign-in started (${via})` };
  if (step === 'succeeded') return { ...base, type: 'signin_succeeded', message: `Signed in (${via})${detail ? `: ${detail}` : ''}` };
  const err = /** @type {any} */ (error);
  if (err?.name === 'AbortError') return { ...base, type: 'signin_cancelled', reason: 'cancelled', message: `Sign-in cancelled (${via})` };
  if (/timed out/i.test(String(err?.message ?? ''))) return { ...base, type: 'signin_timeout', reason: 'timeout', message: `Sign-in timed out (${via})` };
  return { ...base, type: 'signin_failed', reason: 'failed', message: `Sign-in failed (${via}): ${briefError(error)}` };
}

/**
 * The client's name for itself, from its User-Agent: the first token only
 * (`claude-cli/2.1.3`, `codex_cli_rs/0.46.0`). The rest is the OS and
 * terminal, which says more about the machine than the log needs to.
 * @param {unknown} userAgent
 * @returns {string|null}
 */
export function clientAgent(userAgent) {
  return typeof userAgent === 'string' ? userAgent.trim().split(/\s+/)[0] || null : null;
}

// Text a client wraps around a prompt rather than text a person wrote: Claude
// Code's reminders and Codex's environment and instructions preambles. Cut
// out span by span, since a client may put one in the same block as the prompt.
const WRAPPER = /<(system-reminder|environment_context|user_instructions)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * The text of a message's content: a string, or the text of its text blocks
 * (`text` on Anthropic Messages, `input_text` on Codex Responses) that are
 * not client wrappers. Tool results and images carry no text here.
 * @param {unknown} content
 * @returns {string}
 */
function userText(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return blocks
    .filter((b) => (b?.type === 'text' || b?.type === 'input_text') && typeof b.text === 'string')
    .map((b) => b.text.replace(WRAPPER, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * What a request's prompt says: the last user message that holds text a
 * person wrote, from an Anthropic `messages` or a Codex `input` body. A tool
 * loop's later requests end in tool results, so this walks back to the
 * prompt that started the turn. Null for a body that is not JSON or names none.
 * @param {Buffer|string} body
 * @returns {string|null}
 */
export function requestPrompt(body) {
  let parsed;
  // ponytail: a full parse of a body that can run to megabytes; only done
  // with proxy.logPrompts on. A streaming finder like model.js's if it shows.
  try { parsed = JSON.parse(String(body)); } catch { return null; }
  if (typeof parsed?.input === 'string') return parsed.input.trim() || null;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : Array.isArray(parsed?.input) ? parsed.input : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const text = userText(messages[i].content);
    if (text) return text;
  }
  return null;
}
