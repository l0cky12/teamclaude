// Where the account sync keeps its store: callback.net, or one of your own
// instances.
//
// The account sync (credential-sync.js) talks to a store through one `api`
// function. Signed in to callback.net, that is callback.net. With
// `accountSync` set in the config, it is a store one of your own instances
// keeps instead, so no outside service is involved:
//
//   "accountSync": { "mode": "host" }                    this instance keeps it (sync-store.js)
//   "accountSync": { "mode": "follow", "peer": "desk" }   the linked instance "desk" keeps it
//
// A follower reaches the host through the linked-instance channel (peers.js):
// the address and proxy key it lists for that instance under `peers`, and the
// host's POST /teamclaude/sync-store. Nothing new to sign in to.
//
// The mode is read from the config on every call, so a reload or a change made
// from the dashboard applies to the running sync at once. Set, it wins over a
// callback.net session: an install syncs with one store, never two.

import { configuredPeers, peerRequest } from './peers.js';
import { callbackCall, loadCallbackToken } from './callback-auth.js';
import { safeLine } from './safe-text.js';

/** One store call to a host; a renewal is waiting on it, so not long. */
const STORE_CALL_TIMEOUT_MS = 15_000;
/** How often a pass runs against a store of your own: it is a read on your own network. */
export const INSTANCE_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @typedef {{ mode: 'off' } | { mode: 'host' } | { mode: 'follow', peer: string }} SyncMode
 * @typedef {(method: string, path: string, params?: Record<string, any>|null, opts?: any) => Promise<any>} Api
 */

/**
 * The store setting in a config. Anything malformed is off, which leaves
 * callback.net (or nothing) in charge, as before the setting existed.
 * @param {Record<string, any>|null|undefined} config
 * @returns {SyncMode}
 */
export function accountSyncMode(config) {
  const s = config?.accountSync;
  if (s?.mode === 'host') return { mode: 'host' };
  if (s?.mode === 'follow' && typeof s.peer === 'string' && s.peer.trim()) return { mode: 'follow', peer: s.peer.trim() };
  return { mode: 'off' };
}

/**
 * What the sync's log lines call the store.
 * @param {SyncMode} m
 */
export function storeLabel(m) {
  if (m.mode === 'host') return 'the account store on this machine';
  if (m.mode === 'follow') return `the account store on ${safeLine(m.peer, 64)}`;
  return 'callback.net';
}

/**
 * An `api` that sends each call to a host's POST /teamclaude/sync-store.
 * A refusal comes back as an Error carrying the store's `token`, the way
 * callbackCall reports one, so the sync reads both alike.
 * @param {import('./peers.js').Peer} peer
 * @param {{ request?: typeof peerRequest }} [opts]
 * @returns {Api}
 */
export function peerStoreApi(peer, { request = peerRequest } = {}) {
  return async (method, path, params = null, opts = {}) => {
    const body = Buffer.from(JSON.stringify({ method, path, params, envelope: !!opts?.envelope }));
    let out;
    try {
      out = await request(peer, 'sync-store', { method: 'POST', body, timeoutMs: STORE_CALL_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`${peer.name} is unreachable (${/** @type {Error} */ (err).message})`);
    }
    /** @type {any} */ let j = null;
    try { j = JSON.parse(out.body.toString('utf8')); } catch { /* not JSON: the status says enough */ }
    if (out.status === 200 && j?.ok) return j.result;
    const why = safeLine(typeof j?.error === 'string' ? j.error : `status ${out.status}`, 160);
    if (out.status === 401 || out.status === 403) throw new Error(`${peer.name} refused its key in peers (${why})`);
    /** @type {any} */
    const err = new Error(out.status === 404 && j?.token === 'error_not_host'
      ? `${peer.name} does not keep the accounts; turn that on there first`
      : `${peer.name}: ${why}`);
    if (typeof j?.token === 'string') err.token = j.token;
    throw err;
  };
}

/**
 * The `api`, `isSignedIn` and `where` the account sync is built with, picking
 * the store by the config each time it is asked.
 *
 * @param {object} opts
 * @param {() => Record<string, any> | Promise<Record<string, any>>} opts.getConfig  the config as it is now
 * @param {{ call: Api }} opts.store  this machine's own store (sync-store.js)
 * @param {Api} [opts.callback]
 * @param {() => Promise<boolean>} [opts.callbackSignedIn]
 * @param {typeof peerRequest} [opts.request]
 */
export function createSyncTransport({ getConfig, store, callback = callbackCall, callbackSignedIn = async () => !!(await loadCallbackToken()), request = peerRequest }) {
  // The mode as last read, for the log lines, which are written synchronously.
  /** @type {SyncMode} */
  let last = { mode: 'off' };
  const mode = async () => (last = accountSyncMode(await getConfig()));
  return {
    /** @type {Api} */
    async api(method, path, params = null, opts = {}) {
      const m = await mode();
      if (m.mode === 'host') return store.call(method, path, params, opts);
      if (m.mode === 'follow') {
        const config = await getConfig();
        const peer = configuredPeers(config).find(p => p.name === m.peer);
        if (!peer) throw new Error(`no linked instance named ${safeLine(m.peer, 64)} (accountSync.peer)`);
        return peerStoreApi(peer, { request })(method, path, params, opts);
      }
      return callback(method, path, params, opts);
    },
    // A store of your own is always "signed in": with the host unreachable,
    // the sync then holds back renewals instead of renewing on its own and
    // signing the other machines out.
    async isSignedIn() {
      const m = await mode();
      return m.mode !== 'off' || callbackSignedIn();
    },
    where() {
      return storeLabel(last);
    },
  };
}
