// Signing accounts in from the web dashboard.
//
// `teamclaude login` and the TUI's login panel both need a terminal on the
// machine the proxy runs on. A proxy run as a service, in a container or on
// another machine often has nobody at that terminal, which left no way to add
// the first account, or sign one in again after its refresh token died,
// without a shell on the host. The dashboard's sign-in is that way. This module
// keeps the sign-ins it has started and not yet finished.
//
// Paste only, for both providers. The browser runs wherever the page was
// opened, so a redirect to a listener on this machine would not reach it:
// Claude's sign-in shows a code to paste back, and Codex's ends on a
// http://localhost:1455 address that will not load, which is pasted whole.
// Neither binds a port here. Codex's 1455 is fixed, so binding it would
// collide with a `codex login` or a CLI sign-in running on the same host.
//
// A pending sign-in lives in memory for five minutes at most, and at most four
// are open at once. Each holds a PKCE verifier and state inside its flow; none
// of it is written down, logged or returned, and a restart forgets it all,
// which costs the operator one more click.
//
// Who may reach this is server.js's decision (signInRefusal: the operator
// only), and where the tokens go is index.js's (hooks.saveWebSignIn, the same
// upsert `teamclaude login` writes through). This module runs the flows, checks
// what each request asks of them, and records every step on the event log.

import { randomUUID } from 'node:crypto';
import { startOAuthLogin } from './oauth.js';
import { startCodexLogin } from './codex-auth.js';
import { PANEL_LOGIN_TIMEOUT_MS } from './login-flow.js';
import { signInEvent, briefError } from './event-log.js';
import { checkNewAccountName, ConfigOpError } from './config-ops.js';
import { sameIdentity } from './identity.js';
import { providerOf } from './provider.js';
import { safeLine } from './safe-text.js';

/** How long a started sign-in waits for its paste: the TUI panel's wait, for
 *  the same slow case (a link opened on another device, a code carried back). */
export const WEB_LOGIN_TIMEOUT_MS = PANEL_LOGIN_TIMEOUT_MS;

/** How many sign-ins may be open at once. Each is a few hundred bytes, so the
 *  cap is not about memory: it stops a stuck page, or a script, from piling up
 *  flows nobody will finish. */
export const WEB_LOGIN_MAX_PENDING = 4;

/** How often the timer looks for expired sign-ins while any are open. Every
 *  request sweeps first as well, so this only bounds how late a timeout lands
 *  on the event log when nobody touches the page. */
const SWEEP_INTERVAL_MS = 30_000;

/** What the event log says the sign-in came through. */
const VIA = 'dashboard';

/** The reply for an id that is not open, whatever the reason. */
const GONE = 'This sign-in is no longer open: it expired, was cancelled or already finished. Start it again';

/** @typedef {'claude'|'codex'} WebLoginProvider */
/** @typedef {import('./account-routing.js').RoutingProxy} RoutingProxy */

/**
 * The existing account a re-login is for, as the start request found it in the
 * running pool.
 * @typedef {Object} SignInTarget
 * @property {string} name
 * @property {string} id     the config entry id, which is how the save finds its row
 * @property {RoutingProxy|null} routing  the account's own egress proxy: its sign-in goes that way too
 */

/**
 * A started provider flow, reduced to what the dashboard needs.
 * @typedef {Object} WebFlow
 * @property {string} url  the sign-in link to open on any device
 * @property {(text: string) => boolean} submit  see login-flow.js LoginPrompt.submit
 * @property {Promise<Record<string, any>>} credentials  the tokens, once a paste was exchanged
 * @property {boolean} listening  whether anything on this machine waits for a redirect (never, here)
 */

/**
 * What the save hook is given once a sign-in has its tokens.
 * @typedef {Object} WebSignIn
 * @property {WebLoginProvider} provider
 * @property {Record<string, any>} credentials
 * @property {SignInTarget|null} target  the account a re-login is for; null for a new account
 * @property {string|null} name  the name asked for a new account; null for automatic naming
 */

/**
 * @typedef {Object} PendingSignIn
 * @property {string} id
 * @property {WebLoginProvider} provider
 * @property {SignInTarget|null} target
 * @property {string|null} name
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {AbortController} controller
 * @property {WebFlow|null} flow  null only while the flow is starting
 * @property {boolean} finishing  a paste was taken and its exchange or save is running
 */

/**
 * @typedef {{ status: number, body: Record<string, any> }} WebLoginReply
 */

/**
 * @typedef {Object} WebLoginHooks
 * @property {(signIn: WebSignIn) => Promise<{ action: 'added'|'updated', name: string }>} [saveWebSignIn]
 * @property {() => Promise<unknown>} [reload]
 */

/** A refusal with its HTTP status and a message written for the operator. */
export class WebLoginError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'WebLoginError';
    this.status = status;
    // Every message here is written by this module (account names quoted,
    // never a provider's text), so the event log may carry it as it is.
    this.publicMessage = message;
  }
}

/**
 * An error for the server's own output. The shapes known to carry a
 * provider's text (a token or profile response body, an OAuth
 * error_description) are cut to briefError's fixed phrase, the same as on the
 * event log; anything else (a config write that failed, a reload) is our own
 * and is printed whole, since that is what the operator needs to fix it.
 * @param {unknown} error
 * @returns {string}
 */
export function operatorError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error ?? 'unknown error');
  const upstream = /^(?:The sign-in was refused|OpenAI refused the sign-in):|^Could not identify OAuth account|(?:\(|HTTP )\d{3}\)?\s*:/;
  return upstream.test(message) ? briefError(error) : safeLine(message, 300);
}

/**
 * Start one provider's paste-only flow.
 *
 * No timeout inside the flow (`timeoutMs: 0`): the pending sign-in's own
 * expiry, which a test can drive with a fake clock, is the one deadline.
 * `exchange` replaces the token endpoint, for tests.
 *
 * @param {WebLoginProvider} provider
 * @param {{ signal: AbortSignal, routing?: RoutingProxy|null, exchange?: Function }} opts
 * @returns {Promise<WebFlow>}
 */
export async function startWebFlow(provider, { signal, routing = null, exchange }) {
  if (provider === 'codex') {
    const flow = await startCodexLogin({
      listen: false, timeoutMs: 0, signal, routing,
      ...(exchange ? { exchange: /** @type {any} */ (exchange) } : {}),
    });
    return { url: flow.url, submit: flow.submit, credentials: flow.credentials, listening: flow.listening };
  }
  const flow = await startOAuthLogin({
    loopback: false, timeoutMs: 0, signal, routing,
    ...(exchange ? { exchange: /** @type {any} */ (exchange) } : {}),
  });
  return { url: flow.url, submit: flow.submit, credentials: flow.tokens, listening: Boolean(flow.browserUrl) };
}

/**
 * Whether a record carries an account identity the provider vouched for: a
 * ChatGPT account id, or an Anthropic account UUID.
 * @param {Record<string, any>|null|undefined} record
 */
function hasIdentity(record) {
  return Boolean(record?.accountId || record?.accountUuid);
}

/**
 * Same account on evidence, not on a name: both sides carry an identity and
 * sameIdentity agrees. sameIdentity alone falls back to comparing names.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
function provenSame(a, b) {
  return hasIdentity(a) && hasIdentity(b) && sameIdentity(a, b);
}

/** @param {unknown} name */
function quoted(name) {
  return `"${safeLine(String(name ?? ''), 80)}"`;
}

/**
 * The check a dashboard sign-in's save runs under the config lock, after the
 * upsert has chosen the row the tokens would land on (`idx`, -1 for a new row)
 * and before anything is written. It throws to refuse, and a refusal leaves
 * the file as it was.
 *
 * A re-login must land on the account it was started for. The TUI's panel
 * stores the tokens on whichever account the browser signed in as and says so
 * afterwards; the dashboard refuses instead, because its operator clicked one
 * card and a different account changing under it would be a surprise. The
 * message names the account it did match only by its configured name, and
 * otherwise says "a different account": the identity the provider reported
 * (an email) never goes into a reply or the event log.
 *
 * A new account's tokens may only update an existing row the identity proves
 * is the same account. The upsert's last resort is a match by name, and a
 * chosen name that another row took after the sign-in started must not hand
 * that row these tokens.
 *
 * @param {{ target: SignInTarget|null, name: string|null }} signIn
 * @returns {(accounts: Record<string, any>[], idx: number, incoming: Record<string, any>) => void}
 */
export function signInGuard({ target, name }) {
  return (accounts, idx, incoming) => {
    const hit = idx >= 0 ? accounts[idx] : null;
    if (target) {
      const row = accounts.find(a => a?.id === target.id);
      if (!row) throw new WebLoginError(409, `${quoted(target.name)} is no longer in the config file`);
      if (hit && hit === row) return;
      if (!hasIdentity(row) || !hasIdentity(incoming)) {
        throw new WebLoginError(409, `Could not confirm this sign-in is ${quoted(target.name)}: there is no account identity to compare. Sign it in with teamclaude login --name ${quoted(target.name)} instead`);
      }
      throw new WebLoginError(409, `Signed in as ${hit ? quoted(hit.name) : 'a different account'}, not ${quoted(target.name)}`);
    }
    if (hit && !provenSame(hit, incoming)) {
      throw new WebLoginError(409, name
        ? `${quoted(name)} already names another account`
        : `This sign-in matched ${quoted(hit.name)} by name only, so its tokens were not replaced`);
    }
    // A new row under a chosen name: the name was checked at start, but
    // another sign-in or a rename may have taken it since, and the upsert only
    // finds that row when the identities agree. Checked again here, under the
    // lock, so two accounts never end up sharing it.
    if (!hit && name) {
      try {
        checkNewAccountName(accounts, name);
      } catch (err) {
        if (err instanceof ConfigOpError) throw new WebLoginError(409, err.message);
        throw err;
      }
    }
  };
}

/**
 * What the reply says about a paste that could not be used. Our parsers'
 * own messages pass through. A pasted refusal (the address carried `error=`)
 * keeps only its OAuth error code: its error_description is the provider's
 * text, and nothing of the provider's goes into a reply.
 * @param {unknown} error
 * @returns {string}
 */
export function pasteError(error) {
  const message = String(/** @type {any} */ (error)?.message ?? error ?? '');
  if (/^(?:The sign-in was refused|OpenAI refused the sign-in):/.test(message)) {
    const code = /:\s*([a-z_]{1,40})\b/.exec(message);
    return `The provider refused the sign-in${code ? ` (${code[1]})` : ''}. Open the sign-in page again and approve access`;
  }
  return safeLine(message, 300);
}

/** @param {number} ms */
function describeWait(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const mins = Math.round(ms / 60_000);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/**
 * A reply that refuses.
 * @param {number} status
 * @param {string} error
 * @param {Record<string, any>} [extra]
 * @returns {WebLoginReply}
 */
function refuse(status, error, extra = {}) {
  return { status, body: { ok: false, error, ...extra } };
}

/**
 * The dashboard's open sign-ins, and the three steps of one: start, finish
 * with a paste, or cancel.
 *
 * Each step answers `{ status, body }` for server.js to send as it is, so the
 * rules live here and the route stays a dispatch. A paste the flow cannot use
 * answers 400 with `retry: true` and leaves the sign-in open, as the TUI panel
 * does. Anything after a paste was taken ends the sign-in either way.
 */
export class WebLogins {
  /**
   * @param {object} opts
   * @param {WebLoginHooks} opts.hooks  read at each use: index.js may wire them after the server exists
   * @param {() => Record<string, any>[]} opts.accounts  the running pool (AccountManager#accounts)
   * @param {() => Record<string, any>[]} opts.configAccounts  the configured entries, for the importFrom check
   * @param {{ add: (event: any) => unknown } | null} [opts.events]  the event log (AccountManager#events)
   * @param {() => number} [opts.now]
   * @param {(provider: WebLoginProvider, opts: { signal: AbortSignal, routing: RoutingProxy|null }) => Promise<WebFlow>} [opts.startFlow]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxPending]
   * @param {() => string} [opts.newId]
   * @param {boolean} [opts.timer]  sweep on an unref'd timer while anything is open; tests turn it off and call sweep()
   */
  constructor({
    hooks, accounts, configAccounts, events = null, now = Date.now, startFlow = startWebFlow,
    timeoutMs = WEB_LOGIN_TIMEOUT_MS, maxPending = WEB_LOGIN_MAX_PENDING, newId = randomUUID, timer = true,
  }) {
    this.hooks = hooks;
    this.accounts = accounts;
    this.configAccounts = configAccounts;
    this.events = events;
    this.now = now;
    this.startFlow = startFlow;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.newId = newId;
    this.useTimer = timer;
    /** @type {Map<string, PendingSignIn>} */
    this.pending = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  /** Whether this server can save a sign-in and make it live. */
  get available() {
    return typeof this.hooks.saveWebSignIn === 'function' && typeof this.hooks.reload === 'function';
  }

  /**
   * POST /teamclaude/login/start `{ provider, account?, name? }`.
   * @param {Record<string, any>} body
   * @returns {Promise<WebLoginReply>}
   */
  async start(body) {
    const provider = body.provider;
    if (provider !== 'claude' && provider !== 'codex') return refuse(400, 'provider must be "claude" or "codex"');
    /** @type {SignInTarget|null} */
    let target;
    /** @type {string|null} */
    let name;
    try {
      target = this._target(provider, body.account);
      if (target && !(body.name == null || (typeof body.name === 'string' && !body.name.trim()))) {
        return refuse(400, 'name is for a new account: signing an account in again keeps its name');
      }
      name = target ? null : this._newName(body.name);
    } catch (err) {
      if (err instanceof WebLoginError) return refuse(err.status, err.message);
      throw err;
    }

    this.sweep();
    if (this.pending.size >= this.maxPending) {
      return refuse(429, `${this.maxPending} sign-ins are already open. Finish or cancel one, or wait for one to expire (${describeWait(this.timeoutMs)})`);
    }

    const now = this.now();
    /** @type {PendingSignIn} */
    const entry = {
      id: this.newId(), provider, target, name,
      createdAt: now, expiresAt: now + this.timeoutMs,
      controller: new AbortController(), flow: null, finishing: false,
    };
    // Counted from here, not from when the flow is up, so two starts racing
    // for the last slot cannot both take it.
    this.pending.set(entry.id, entry);
    this._armTimer();
    try {
      const flow = await this.startFlow(provider, { signal: entry.controller.signal, routing: target?.routing ?? null });
      // Handled here as well as by whoever awaits it: a flow cancelled before
      // its paste rejects, and nobody else may be listening by then.
      flow.credentials.catch(() => {});
      entry.flow = flow;
    } catch (err) {
      this._forget(entry);
      this._event('failed', entry, { error: err });
      console.error(`[TeamClaude] Could not start a dashboard sign-in: ${operatorError(err)}`);
      return refuse(500, 'Could not start the sign-in; see the proxy log');
    }
    // close() ran while the flow was starting.
    if (entry.controller.signal.aborted) return refuse(503, 'The server is shutting down');
    this._event('started', entry);
    return { status: 200, body: { ok: true, id: entry.id, provider, url: entry.flow.url, expiresAt: entry.expiresAt } };
  }

  /**
   * POST /teamclaude/login/finish `{ id, input }`.
   * @param {Record<string, any>} body
   * @returns {Promise<WebLoginReply>}
   */
  async finish(body) {
    this.sweep();
    const entry = this._open(body.id);
    if (!entry?.flow) return refuse(404, GONE);
    if (entry.finishing) return refuse(409, 'This sign-in is already being finished');
    const flow = entry.flow;
    const again = entry.provider === 'codex'
      ? 'Paste the whole address the browser ended up on; it starts http://localhost:1455/auth/callback?code='
      : 'Paste the authorization code the page shows after you sign in';
    if (typeof body.input !== 'string') return refuse(400, again, { retry: true });

    // A paste that cannot be used is not the end of the sign-in, so it is not a
    // failure on the event log either: the operator corrects it and tries again.
    let taken;
    try {
      taken = flow.submit(body.input);
    } catch (err) {
      return refuse(400, pasteError(err), { retry: true });
    }
    if (!taken) return refuse(400, again, { retry: true });

    // The code is spent from here on: whatever happens next ends the sign-in.
    entry.finishing = true;
    /** @type {Record<string, any>} */
    let credentials;
    try {
      credentials = await flow.credentials;
    } catch (err) {
      this._forget(entry);
      this._event('failed', entry, { error: err });
      console.error(`[TeamClaude] Dashboard sign-in failed: ${operatorError(err)}`);
      return refuse(502, `Sign-in failed: ${briefError(err)}. Start it again`);
    }

    /** @type {{ action: 'added'|'updated', name: string }} */
    let outcome;
    try {
      const save = this.hooks.saveWebSignIn;
      if (typeof save !== 'function') throw new WebLoginError(501, 'This server cannot save a sign-in');
      outcome = await save({ provider: entry.provider, credentials, target: entry.target, name: entry.name });
    } catch (err) {
      this._forget(entry);
      this._event('failed', entry, { error: err });
      if (err instanceof WebLoginError) return refuse(err.status, err.message);
      console.error(`[TeamClaude] Dashboard sign-in could not be saved: ${operatorError(err)}`);
      return refuse(500, `Signed in, but the account could not be saved: ${briefError(err)}`);
    }
    this._forget(entry);
    this._event('succeeded', entry, {
      account: outcome.name,
      detail: entry.target ? null : outcome.action === 'added' ? 'added to the pool' : 'already in the pool, its tokens replaced',
    });
    console.log(`[TeamClaude] Signed in "${safeLine(outcome.name, 80)}" from the dashboard (${outcome.action})`);

    // On disk now; the reload is what puts it in the running pool. A failure
    // there is reported as such, as the other account controls do, since the
    // file did change.
    try {
      await this.hooks.reload?.();
    } catch (err) {
      console.error(`[TeamClaude] Reload after a dashboard sign-in failed: ${operatorError(err)}`);
      return refuse(500, 'Signed in and saved to the config file, but the reload failed; see the proxy log');
    }
    return { status: 200, body: { ok: true, account: outcome.name, action: outcome.action } };
  }

  /**
   * POST /teamclaude/login/cancel `{ id }`. An id that is not open is a 404,
   * so the page can tell a cancel that did something from one that did not;
   * the page treats both as closed.
   * @param {Record<string, any>} body
   * @returns {WebLoginReply}
   */
  cancel(body) {
    this.sweep();
    const entry = this._open(body.id);
    if (!entry) return refuse(404, GONE);
    if (entry.finishing) return refuse(409, 'This sign-in is already being finished and can no longer be cancelled');
    this._forget(entry);
    // A bare abort: the flow rejects with an AbortError, which is how
    // signInEvent tells the operator's own cancel from a failure.
    entry.controller.abort();
    const cancelled = new Error('Sign-in cancelled');
    cancelled.name = 'AbortError';
    this._event('failed', entry, { error: cancelled });
    return { status: 200, body: { ok: true } };
  }

  /**
   * End every open sign-in past its expiry: abort its flow and record the
   * timeout. One whose paste is being exchanged is left to finish. Returns how
   * many expired.
   * @returns {number}
   */
  sweep() {
    const now = this.now();
    let expired = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.finishing || now < entry.expiresAt) continue;
      this._forget(entry);
      const timeout = new Error(`Sign-in timed out after ${describeWait(this.timeoutMs)}`);
      entry.controller.abort(timeout);
      this._event('failed', entry, { error: timeout });
      expired++;
    }
    return expired;
  }

  /** Abort everything open, without logging: the server is going away, and
   *  the event log with it. */
  close() {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
    this._disarmTimer();
  }

  /**
   * The open sign-in with this id, or undefined.
   * @param {unknown} id
   */
  _open(id) {
    return typeof id === 'string' && id ? this.pending.get(id) : undefined;
  }

  /** @param {PendingSignIn} entry */
  _forget(entry) {
    this.pending.delete(entry.id);
    if (this.pending.size === 0) this._disarmTimer();
  }

  _armTimer() {
    if (!this.useTimer || this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  _disarmTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Record one step on the event log. The account is the re-login's target or,
   * once saved, the name it was saved under: a configured name, never what the
   * provider reported.
   * @param {'started'|'succeeded'|'failed'} step
   * @param {PendingSignIn} entry
   * @param {{ error?: unknown, account?: string|null, detail?: string|null }} [info]
   */
  _event(step, entry, { error = null, account = entry.target?.name ?? null, detail = null } = {}) {
    this.events?.add(signInEvent(step, { provider: entry.provider, account, via: VIA, error, detail }));
  }

  /**
   * The existing account a re-login names, checked as the TUI's login key
   * checks it: it must be in the running pool, be an OAuth account of this
   * provider, and own its tokens (an importFrom row re-reads them from its file
   * on every reload, so tokens saved onto the row would be ignored).
   * @param {WebLoginProvider} provider
   * @param {unknown} account
   * @returns {SignInTarget|null}
   */
  _target(provider, account) {
    if (account == null || account === '') return null;
    if (typeof account !== 'string') throw new WebLoginError(400, 'account must be an account name');
    const wanted = provider === 'codex' ? 'codex' : 'anthropic';
    const label = provider === 'codex' ? 'Codex' : 'Claude';
    const named = this.accounts().filter(a => a?.name === account);
    if (!named.length) throw new WebLoginError(404, `No account is named ${quoted(account)}`);
    const matches = named.filter(a => providerOf(a) === wanted);
    if (!matches.length) throw new WebLoginError(400, `${quoted(account)} is not a ${label} account`);
    if (matches.length > 1) throw new WebLoginError(409, `Several ${label} accounts are named ${quoted(account)}; rename one first`);
    const acct = matches[0];
    if (acct.type !== 'oauth') throw new WebLoginError(400, `${quoted(account)} is not an OAuth account, so there is nothing to sign in to`);
    const entry = acct.id ? this.configAccounts().find(c => c?.id === acct.id) : null;
    if (!entry) throw new WebLoginError(409, `${quoted(account)} is not in this server's config file, so a sign-in could not be saved to it`);
    if (entry.importFrom) throw new WebLoginError(409, `${quoted(account)} reads its tokens from a file (importFrom); sign in where that file comes from instead`);
    return { name: acct.name, id: acct.id, routing: acct.routing ?? null };
  }

  /**
   * The name asked for a new account: null for automatic naming, otherwise
   * held to the rules `teamclaude rename` applies.
   * @param {unknown} raw
   * @returns {string|null}
   */
  _newName(raw) {
    if (raw == null || (typeof raw === 'string' && !raw.trim())) return null;
    if (typeof raw !== 'string') throw new WebLoginError(400, 'name must be a string');
    try {
      return checkNewAccountName(this.configAccounts(), raw);
    } catch (err) {
      if (err instanceof ConfigOpError) throw new WebLoginError(400, err.message);
      throw err;
    }
  }
}
