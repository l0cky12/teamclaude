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
 */

/** Fields an entry may carry beyond the fixed ones, and how each is kept. */
const NUMBER_FIELDS = ['status', 'inputTokens', 'outputTokens', 'ms'];
const TEXT_FIELDS = /** @type {const} */ ([['model', 80], ['reason', 60]]);

/** A non-negative finite number, or null. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** A sanitised single line, or null for an empty or absent value. */
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
   * @returns {{ events: LogEvent[], lastId: number, capacity: number }}
   */
  since(after = 0, limit = EVENT_LOG_PAGE) {
    const from = Number.isFinite(after) && after > 0 ? after : 0;
    const max = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : EVENT_LOG_PAGE, EVENT_LOG_PAGE));
    // Ids are dense and increasing, so the first entry newer than `from` is
    // found by offset from the oldest one kept rather than by scanning.
    const oldest = this.entries[0]?.id ?? this.lastId + 1;
    const start = Math.max(0, from + 1 - oldest);
    const newer = this.entries.slice(start);
    return { events: newer.slice(-max), lastId: this.lastId, capacity: this.capacity };
  }
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
 * A sign-in failure as one line we can stand behind. Our own messages (a
 * pasted code that does not parse, a timeout) pass through; a token
 * endpoint's refusal ("Token exchange failed (400): <body>") is cut at its
 * status, because the body is the upstream's text, not ours.
 * @param {unknown} error
 * @returns {string}
 */
export function briefError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error ?? 'unknown error');
  const status = /^(.{1,80}?\(\d{3}\))\s*:/.exec(message);
  return safeLine(status ? status[1] : message, 160);
}

/**
 * The event-log entry for one step of an interactive sign-in, from the
 * terminal's login panel or the dashboard. A failure is classified: an
 * AbortError is the operator cancelling, a "timed out" error the flow's own
 * deadline, anything else a failure.
 * @param {'started'|'succeeded'|'failed'} step
 * @param {{ provider: string, account?: string|null, via: string, error?: unknown, detail?: string|null }} info
 * @returns {{ kind: 'signin', type: string, provider: string, account: string|null, message: string, reason?: string }}
 */
export function signInEvent(step, { provider, account = null, via, error = null, detail = null }) {
  const base = { kind: /** @type {const} */ ('signin'), provider, account };
  if (step === 'started') return { ...base, type: 'signin_started', message: `Sign-in started (${via})` };
  if (step === 'succeeded') return { ...base, type: 'signin_succeeded', message: `Signed in (${via})${detail ? `: ${detail}` : ''}` };
  const err = /** @type {any} */ (error);
  if (err?.name === 'AbortError') return { ...base, type: 'signin_cancelled', reason: 'cancelled', message: `Sign-in cancelled (${via})` };
  if (/timed out/i.test(String(err?.message ?? ''))) return { ...base, type: 'signin_timeout', reason: 'timeout', message: `Sign-in timed out (${via})` };
  return { ...base, type: 'signin_failed', reason: 'failed', message: `Sign-in failed (${via}): ${briefError(error)}` };
}
