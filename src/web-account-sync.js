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
//
// The card also switches the sync to a store one of your own instances keeps
// (instance-sync.js), for those who would rather not use an outside service:
// `mode` makes this machine keep it, follow a linked instance that does, or
// stops either. One store at a time. Choosing one of your own machines
// cancels a callback.net sign-in that is still waiting, so that approval
// cannot sign the machine in afterwards. A sign-in already approved is
// saving its token and is left to finish; a machine already signed in to
// callback.net still has to sign out first.

import { randomBytes } from 'node:crypto';
import { loginCallback, loadCallbackToken, saveCallbackTokenIn, callbackSessionEpoch, callbackWhoami, logoutCallback } from './callback-auth.js';
import { safeLine } from './safe-text.js';
import { storeLabel } from './instance-sync.js';

// The user's name and email are read from callback.net for the card. A page
// that cannot get them quickly still shows the rest.
const WHOAMI_TIMEOUT_MS = 5000;

/**
 * @typedef {{ email: string|null, name: string|null }} SyncUser
 * @typedef {'waiting' | 'finishing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'} SyncSignInState
 */

/**
 * @typedef {import('./instance-sync.js').SyncMode} SyncMode
 */

/**
 * @typedef {object} SyncSignIn
 * @property {string} id
 * @property {AbortController} controller
 * @property {Exclude<SyncSignInState, 'unknown'>} state
 * @property {string | null} error
 * @property {Promise<unknown>} [firstPass]  the pass a successful sign-in starts
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
   * @param {typeof saveCallbackTokenIn} [opts.save]  saves the token for the session epoch it began in
   * @param {typeof callbackSessionEpoch} [opts.epoch]
   * @param {typeof callbackWhoami} [opts.whoami]
   * @param {typeof logoutCallback} [opts.logout]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(line: string) => void} [opts.log]
   * @param {() => SyncMode} [opts.mode]  the store setting as it is now (instance-sync.js)
   * @param {((next: SyncMode) => Promise<void>) | null} [opts.setMode]  saves and applies a new one
   * @param {() => string[]} [opts.peerNames]  the linked instances this machine lists
   * @param {() => boolean} [opts.canHost]  whether other machines can reach this one (it has a proxy key)
   * @param {(peer: string) => Promise<unknown>} [opts.probe]  one read of a linked instance's store
   */
  constructor({ sync, login = loginCallback, load = loadCallbackToken, save = saveCallbackTokenIn, epoch = callbackSessionEpoch, whoami = callbackWhoami, logout = logoutCallback, fetchImpl = fetch, log = (l) => console.log(l), mode = () => ({ mode: 'off' }), setMode = null, peerNames = () => [], canHost = () => false, probe = () => Promise.reject(new Error('not supported')) }) {
    this._sync = sync;
    this._mode = mode;
    this._setMode = setMode;
    this._peerNames = peerNames;
    this._canHost = canHost;
    this._probe = probe;
    this._login = login;
    this._load = load;
    this._save = save;
    this._epoch = epoch;
    // Tokens this class has saved, counted: a start that read the token file
    // while one was being written cannot trust what it read.
    this._saves = 0;
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
   * `instance` is the store of your own instances: off, kept here (host) or
   * followed on a linked instance, with what the card offers to switch to.
   * @returns {Promise<{ signedIn: boolean, user: SyncUser | null, userError: string | null, sync: Record<string, any>, signIn: { id: string, state: SyncSignInState } | null, instance: { mode: SyncMode['mode'], peer: string | null, peers: string[], canHost: boolean, supported: boolean } }>}
   */
  async view() {
    const token = await this._load().catch(() => null);
    const m = this._mode();
    let user = null;
    let userError = null;
    // A session the sync does not use is not worth asking callback.net about.
    if (token && m.mode === 'off') {
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
      signIn: cur && (cur.state === 'waiting' || cur.state === 'finishing') ? { id: cur.id, state: cur.state } : null,
      instance: {
        mode: m.mode,
        peer: m.mode === 'follow' ? m.peer : null,
        peers: this._peerNames(),
        canHost: this._canHost(),
        supported: !!this._setMode,
      },
    };
  }

  /** What the store is called in a message: callback.net, or the instance that keeps it. */
  storeName() {
    return storeLabel(this._mode());
  }

  /**
   * Switch the store to one of your own instances, or off again: `host`
   * keeps it on this machine, `follow` {peer} uses the one a linked instance
   * keeps (checked first, so a follower is never pointed at a machine that
   * does not keep one), `off` goes back to callback.net or to nothing. The
   * accounts stay where they are either way; only where they are shared
   * through changes. The first pass starts at once.
   *
   * Host and follow do not use callback.net. A sign-in that is only waiting
   * is cancelled before the first await, so an approval that arrives while
   * the switch is checked cannot save a token. One already approved
   * (`finishing`) is past cancelling: its token is being saved, and the
   * switch is refused until that has landed and been signed out.
   * @param {{ mode?: unknown, peer?: unknown }} body
   * @returns {Promise<{ mode: SyncMode['mode'], peer: string | null }>}
   */
  async changeMode(body) {
    if (!this._setMode) throw new AccountSyncError('this server cannot switch account sync from the dashboard');
    const want = body?.mode;
    /** @type {SyncMode} */
    let next;
    if (want === 'off') {
      next = { mode: 'off' };
    } else if (want === 'host' || want === 'follow') {
      // Refusals that need no I/O come first, so a waiting sign-in is left
      // alone when this machine cannot take the store anyway.
      if (want === 'host') {
        if (!this._canHost()) throw new AccountSyncError('this machine has no proxy key (proxy.apiKey), so your other machines could not reach its store; set one first');
        next = { mode: 'host' };
      } else {
        const peer = typeof body?.peer === 'string' ? body.peer.trim() : '';
        if (!peer || !this._peerNames().includes(peer)) throw new AccountSyncError('choose one of the linked instances of this machine');
        next = { mode: 'follow', peer };
      }
      const cur = this._current;
      if (cur?.state === 'finishing') {
        throw new AccountSyncError('the last callback.net sign-in was approved and is still finishing; try again in a moment');
      }
      // Synchronous with the approval's own abort check: no token write can
      // start between here and the awaits below.
      if (cur?.state === 'waiting') this.cancel(cur.id);
      if (await this._load().catch(() => null)) {
        throw new AccountSyncError('this machine is signed in to callback.net; sign out first, so it syncs with one store only');
      }
      if (next.mode === 'follow') {
        try {
          await this._probe(next.peer);
        } catch (err) {
          throw new AccountSyncError(`could not use the account store on ${safeLine(next.peer, 64)}: ${syncError(err)}`);
        }
      }
    } else {
      throw new AccountSyncError('"mode" must be host, follow or off');
    }
    await this._setMode(next);
    return { mode: next.mode, peer: next.mode === 'follow' ? next.peer : null };
  }

  /**
   * Start a sign-in, cancelling one still waiting. Resolves once callback.net
   * has handed out the approval link; the approval itself is waited for in
   * the background, and `status` says how it went.
   *
   * Once approved, the sign-in is FINISHING: its token is being saved, and
   * from then on Cancel no longer stops it. The save belongs to the session
   * epoch the sign-in began in (callback-auth.js saveCallbackTokenIn), so a
   * sign-out at any point either refuses it or waits for it and then deletes
   * it: a late save can never turn sync back on behind a sign-out.
   * @returns {Promise<{ id: string, url: string, lifetimeSeconds: number }>}
   */
  async start() {
    const saves = this._saves;
    const signedIn = await this._load().catch(() => null);
    // Checked after the read, and synchronously with taking over _current
    // below: a sign-in approved or saved while the file was being read wins,
    // and this one is refused rather than replacing it.
    if (signedIn || this._saves !== saves) {
      throw new AccountSyncError('already signed in to callback.net; sign out first to use another callback.net account');
    }
    if (this._mode().mode !== 'off') {
      throw new AccountSyncError('account sync goes through your own instances; turn that off first to use callback.net');
    }
    if (this._current?.state === 'finishing') {
      throw new AccountSyncError('the last sign-in was approved and is still finishing; try again in a moment');
    }
    this.cancel(this._current?.id ?? '');
    const id = randomBytes(16).toString('hex');
    const controller = new AbortController();
    const epoch = this._epoch();
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
      // Synchronously with the check above: no cancel can come between them.
      entry.state = 'finishing';
      await this._save(token, epoch);
      this._saves++;
      this._who = null;
      return token;
    });
    outcome.then(
      () => {
        entry.state = 'succeeded';
        this._log('[TeamClaude] Signed in to callback.net from the dashboard; account sync is on');
        // The first pass brings the store's accounts here and this install's
        // freshly renewed ones there. Not awaited: the page polls the card.
        entry.firstPass = this._sync.sync('dashboard sign-in').catch(() => {});
      },
      (err) => {
        // Refused by a sign-out that began meanwhile: the operator ended it.
        const ended = err?.name === 'AbortError' || controller.signal.aborted || (err?.loginRequired && this._epoch() !== epoch);
        entry.state = ended ? 'cancelled' : 'failed';
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
   * Stop waiting for the approval `id` names. Nothing to cancel is not an
   * error. A sign-in already approved (finishing) is past cancelling: its
   * token is being saved, and Sign out is what undoes it.
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
    if (this._mode().mode === 'off' && !await this._load().catch(() => null)) throw new AccountSyncError('not signed in to callback.net');
    return this._sync.sync('dashboard');
  }

  /**
   * Revoke the session and stop syncing. The accounts stay on this install;
   * only the link to the store goes.
   * @returns {Promise<{ wasSignedIn: boolean, revoked: boolean }>}
   */
  async signOut() {
    const cur = this._current;
    if (cur) this.cancel(cur.id);
    // The logout itself refuses or waits for every token write in this
    // process, the dashboard's sign-in and callback.net's own renewals alike.
    const out = await this._logout();
    // A sign-in's first pass still running would be the one the pass below
    // joins, and so count a store that is no longer this install's.
    if (cur) await cur.firstPass;
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

