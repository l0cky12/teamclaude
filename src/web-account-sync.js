// Account sync (callback.net) from the web dashboard.
//
// Keeping the same accounts signed in on several of your machines is what the
// callback.net credential sync does (credential-sync.js), and until now it was
// switched on per machine from a terminal: `teamclaude callback login`. The
// dashboard's Account sync card does the same from a browser, and through a
// linked instance (peers.js) it does it for that machine too, so one page can
// put every machine of yours on the same store.
//
// The sign-in is the same poll-token flow the CLI runs (callback-auth.js): the
// server asks for a poll token, the page shows the approval link, and the
// server polls until the link is approved in any browser. Nothing has to come
// back to this machine, so it works the same for a linked instance whose
// address the browser cannot reach. The page asks how it went with `status`.
//
// One sign-in at a time, and none while signed in: switching the store an
// install syncs with is done by signing out first, on purpose, so a sign-in
// can never quietly move an install's tokens to someone else's store.

import { randomBytes } from 'node:crypto';
import { loginCallback, loadCallbackToken, saveCallbackToken, callbackWhoami, logoutCallback } from './callback-auth.js';
import { safeLine } from './safe-text.js';

// The user's name and email are read from callback.net for the card. A page
// that cannot get them quickly still shows the rest.
const WHOAMI_TIMEOUT_MS = 5000;

/**
 * @typedef {{ email: string|null, name: string|null }} SyncUser
 * @typedef {'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'} SyncSignInState
 */

/**
 * @typedef {object} SyncSignIn
 * @property {string} id
 * @property {AbortController} controller
 * @property {Exclude<SyncSignInState, 'unknown'>} state
 * @property {string | null} error
 */

/** A refusal the page may show as it is. */
export class AccountSyncError extends Error {}

/**
 * A `sleep` for loginCallback that a cancel cuts short.
 * @param {AbortSignal} signal
 * @returns {(ms: number) => Promise<void>}
 */
function abortableSleep(signal) {
  return (ms) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One line for the page. callback-auth.js already strips what callback.net
 * says (safeLine); this bounds it and covers a network error's message.
 * @param {unknown} err
 */
function syncError(err) {
  return safeLine(String(/** @type {any} */ (err)?.message || err || 'unknown error'), 160);
}

function abortError() {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * A `fetch` for loginCallback that a cancel also aborts mid-request: the poll
 * is a long poll, and a cancel should not wait it out. Where AbortSignal.any
 * is missing (Node before 20.3) the request keeps its own timeout, and the
 * cancel takes effect at the next pause instead.
 * @param {typeof fetch} fetchImpl
 * @param {AbortSignal} signal
 * @returns {typeof fetch}
 */
function abortableFetch(fetchImpl, signal) {
  return (url, init = {}) => {
    const own = init.signal;
    const both = own && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, signal]) : (own || signal);
    return fetchImpl(url, { ...init, signal: both });
  };
}

export class WebAccountSync {
  /**
   * @param {object} opts
   * @param {{ summary: () => Record<string, any>, sync: (reason?: string) => Promise<Record<string, any>> }} opts.sync
   *   the running CredentialSync
   * @param {typeof loginCallback} [opts.login]
   * @param {typeof loadCallbackToken} [opts.load]
   * @param {typeof saveCallbackToken} [opts.save]
   * @param {typeof callbackWhoami} [opts.whoami]
   * @param {typeof logoutCallback} [opts.logout]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ sync, login = loginCallback, load = loadCallbackToken, save = saveCallbackToken, whoami = callbackWhoami, logout = logoutCallback, fetchImpl = fetch, log = (l) => console.log(l) }) {
    this._sync = sync;
    this._login = login;
    this._load = load;
    this._save = save;
    this._whoami = whoami;
    this._logout = logout;
    this._fetch = fetchImpl;
    this._log = log;
    /** @type {SyncSignIn | null} */
    this._current = null;
    // Who the stored session belongs to, read once per session: the card is
    // read on every visit to Settings, and the answer does not change while
    // the session lasts. Keyed by the refresh token, which a renewal of the
    // access token leaves as it is.
    /** @type {{ key: string, user: SyncUser } | null} */
    this._who = null;
  }

  /**
   * What the card shows: whether this install is signed in, as whom, what
   * the last pass found, and the dashboard sign-in in progress, if any.
   * @returns {Promise<{ signedIn: boolean, user: SyncUser | null, userError: string | null, sync: Record<string, any>, signIn: { id: string, state: SyncSignInState } | null }>}
   */
  async view() {
    const token = await this._load().catch(() => null);
    let user = null;
    let userError = null;
    if (token) {
      const key = token.refresh_token || token.access_token;
      if (this._who?.key === key) {
        user = this._who.user;
      } else {
        try {
          const me = await this._whoami({ timeoutMs: WHOAMI_TIMEOUT_MS });
          user = { email: me.email, name: me.name };
          this._who = { key, user };
        } catch (err) {
          userError = /** @type {any} */ (err)?.loginRequired
            ? 'the callback.net session has expired; sign out and sign in again'
            : syncError(err);
        }
      }
    }
    const cur = this._current;
    return {
      signedIn: !!token,
      user,
      userError,
      sync: this._sync.summary(),
      signIn: cur && cur.state === 'waiting' ? { id: cur.id, state: cur.state } : null,
    };
  }

  /**
   * Start a sign-in, cancelling one still waiting. Resolves once callback.net
   * has handed out the approval link; the approval itself is waited for in
   * the background, and `status` says how it went.
   * @returns {Promise<{ id: string, url: string, lifetimeSeconds: number }>}
   */
  async start() {
    if (await this._load().catch(() => null)) {
      throw new AccountSyncError('already signed in to callback.net; sign out first to use another callback.net account');
    }
    this.cancel(this._current?.id ?? '');
    const id = randomBytes(16).toString('hex');
    const controller = new AbortController();
    /** @type {SyncSignIn} */
    const entry = { id, controller, state: 'waiting', error: null };
    this._current = entry;

    /** @type {(v: { url: string, lifetimeSeconds: number }) => void} */
    let prompted = () => {};
    /** @type {Promise<{ url: string, lifetimeSeconds: number }>} */
    const prompt = new Promise((resolve) => { prompted = resolve; });
    const outcome = this._login({
      onUrl: (url, { lifetimeSeconds }) => prompted({ url, lifetimeSeconds }),
      sleep: abortableSleep(controller.signal),
      fetchImpl: abortableFetch(this._fetch, controller.signal),
    }).then(async (token) => {
      // Approved after a cancel: the page has moved on, so the grant is not kept.
      if (controller.signal.aborted) throw abortError();
      await this._save(token);
      this._who = null;
      return token;
    });
    outcome.then(
      () => {
        entry.state = 'succeeded';
        this._log('[TeamClaude] Signed in to callback.net from the dashboard; account sync is on');
        // The first pass brings the store's accounts here and this install's
        // freshly renewed ones there. Not awaited: the page polls the card.
        this._sync.sync('dashboard sign-in').catch(() => {});
      },
      (err) => {
        entry.state = err?.name === 'AbortError' || controller.signal.aborted ? 'cancelled' : 'failed';
        entry.error = entry.state === 'failed' ? syncError(err) : null;
        if (entry.state === 'failed') this._log(`[TeamClaude] callback.net sign-in from the dashboard failed: ${entry.error}`);
      },
    );

    // A failure before the link exists (callback.net unreachable, say) is this
    // request's to report. Both sides settle into a value, so the side that
    // loses the race is never an unhandled rejection.
    const first = await Promise.race([
      prompt.then((p) => ({ prompt: p, error: null })),
      outcome.then(() => ({ prompt: null, error: null }), (err) => ({ prompt: null, error: err })),
    ]);
    if (first.error) throw first.error;
    if (!first.prompt) throw new AccountSyncError('the sign-in ended before it started');
    return { id, url: first.prompt.url, lifetimeSeconds: first.prompt.lifetimeSeconds };
  }

  /**
   * @param {string} id
   * @returns {{ state: SyncSignInState, error?: string | null }}
   */
  status(id) {
    const entry = this._entry(id);
    if (!entry) return { state: 'unknown' };
    return { state: entry.state, error: entry.error };
  }

  /**
   * Stop waiting for the approval `id` names. Nothing to cancel is not an error.
   * @param {string} id
   * @returns {boolean}  whether a waiting sign-in was cancelled
   */
  cancel(id) {
    const entry = this._entry(id);
    if (!entry || entry.state !== 'waiting') return false;
    entry.controller.abort();
    entry.state = 'cancelled';
    return true;
  }

  /**
   * A pass now, rather than at the next reload or the daily one.
   * @returns {Promise<Record<string, any>>}  what the pass changed
   */
  async syncNow() {
    if (!await this._load().catch(() => null)) throw new AccountSyncError('not signed in to callback.net');
    return this._sync.sync('dashboard');
  }

  /**
   * Revoke the session and stop syncing. The accounts stay on this install;
   * only the link to the store goes.
   * @returns {Promise<{ wasSignedIn: boolean, revoked: boolean }>}
   */
  async signOut() {
    this.cancel(this._current?.id ?? '');
    const out = await this._logout();
    this._who = null;
    // A pass with no session forgets what the store held, so the card stops
    // counting its rows.
    await this._sync.sync('sign-out').catch(() => {});
    if (out.wasSignedIn) this._log(`[TeamClaude] Signed out of callback.net from the dashboard${out.revoked ? '' : ' (locally; the session could not be revoked)'}; account sync is off`);
    return out;
  }

  /** @param {string} id */
  _entry(id) {
    return this._current && typeof id === 'string' && id && this._current.id === id ? this._current : null;
  }
}

