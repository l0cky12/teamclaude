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
//   "accountSync": { "mode": "cluster", "members": ["server", "desk"] }
//                                  a master and backups keep it (sync-cluster.js):
//                                  the first member that is up is the master
//
// A follower reaches the host through the linked-instance channel (peers.js):
// the address and proxy key it lists for that instance under `peers`, and the
// host's POST /teamclaude/sync-store. Nothing new to sign in to.
//
// The mode is read from the config on every call, so a reload or a change made
// from the dashboard applies to the running sync at once. Set, it wins over a
// callback.net session: an install syncs with one store, never two.

import { configuredPeers, instanceName, peerRequest } from './peers.js';
import { callbackCall, loadCallbackToken } from './callback-auth.js';
import { safeLine } from './safe-text.js';
import { parseMembers, askMember } from './sync-cluster.js';

/** One store call to a host; a renewal is waiting on it, so not long. */
const STORE_CALL_TIMEOUT_MS = 15_000;
/** How often a pass runs against a store of your own: it is a read on your own network. */
export const INSTANCE_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @typedef {{ mode: 'off' } | { mode: 'host' } | { mode: 'follow', peer: string } | { mode: 'cluster', members: string[] }} SyncMode
 * @typedef {(method: string, path: string, params?: Record<string, any>|null, opts?: any) => Promise<any>} Api
 * @typedef {{ isMaster: () => boolean, masterPeer: () => import('./peers.js').Peer | null, election: { master: string|null, reason: string|null } }} ClusterView
 *   the running election (sync-cluster.js ClusterMonitor)
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
  if (s?.mode === 'cluster') {
    const members = parseMembers(s.members);
    if (members) return { mode: 'cluster', members };
  }
  return { mode: 'off' };
}

/**
 * What the sync's log lines call the store.
 * @param {SyncMode} m
 */
export function storeLabel(m) {
  if (m.mode === 'host') return 'the account store on this machine';
  if (m.mode === 'follow') return `the account store on ${safeLine(m.peer, 64)}`;
  if (m.mode === 'cluster') return 'the account store of your master and backups';
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
 * The store a config names, with the peer entry a follower reaches it
 * through: what an operation is pinned to. With a master and backups it is
 * the master the election names now: this machine's own store when it is
 * the master (`local`), the master's otherwise, and none while there is no
 * master (`master` null).
 * @param {Record<string, any>} config
 * @param {ClusterView|null} [cluster]
 * @returns {{ mode: SyncMode, peer: import('./peers.js').Peer | null, local?: boolean, master?: string | null }}
 */
export function storeTarget(config, cluster = null) {
  const mode = accountSyncMode(config);
  if (mode.mode === 'cluster') {
    if (cluster?.isMaster()) return { mode, peer: null, local: true, master: instanceName(config) };
    const peer = cluster?.masterPeer() || null;
    return { mode, peer, local: false, master: peer ? cluster?.election.master ?? null : null };
  }
  const peer = mode.mode === 'follow' ? configuredPeers(config).find(p => p.name === mode.peer) || null : null;
  return { mode, peer };
}

/**
 * The master of a cluster as a one-shot command finds it, with no election
 * of its own running: the first member, in order, that answers that it is
 * the master. This machine is asked through its own proxy (loopback, its own
 * key), since the running server is the one that knows. Null when none says so.
 * @param {Record<string, any>} config
 * @param {{ request?: typeof peerRequest }} [opts]
 * @returns {Promise<{ local: boolean, peer: import('./peers.js').Peer | null, master: string } | null>}
 */
export async function findClusterMaster(config, { request = peerRequest } = {}) {
  const mode = accountSyncMode(config);
  if (mode.mode !== 'cluster') return null;
  const self = instanceName(config);
  const peers = configuredPeers(config);
  const key = config.proxy?.apiKey;
  const port = Number(config.proxy?.port) || 3456;
  for (const name of mode.members) {
    if (name === self) {
      if (!key) continue;
      const own = { name: self, url: `http://127.0.0.1:${port}`, apiKey: key };
      if ((await askMember(own, { request }))?.role === 'master') return { local: true, peer: null, master: self };
      continue;
    }
    const peer = peers.find(p => p.name === name);
    if (peer && (await askMember(peer, { request }))?.role === 'master') return { local: false, peer, master: name };
  }
  return null;
}

/**
 * The `api`, `isSignedIn` and `where` the account sync is built with.
 *
 * Every call goes to the store the transport is PINNED to, not to whatever
 * the config says at that moment: a renewal that locked a row in one store
 * has to store and unlock in that same store, so a change of mode (or of the
 * address a follower uses) takes effect only through `pin`, which the server
 * calls once the running operations are done (CredentialSync.switchStore).
 * Until the first `pin`, the first call pins to the config as `getConfig`
 * reads it then, which is what a one-shot CLI command wants.
 *
 * @param {object} opts
 * @param {() => Record<string, any> | Promise<Record<string, any>>} opts.getConfig  the config as it is now
 * @param {{ call: Api }} opts.store  this machine's own store (sync-store.js)
 * @param {Api} [opts.callback]
 * @param {() => Promise<boolean>} [opts.callbackSignedIn]
 * @param {typeof peerRequest} [opts.request]
 * @param {ClusterView|null} [opts.cluster]  the running election, with a master and backups
 */
export function createSyncTransport({ getConfig, store, callback = callbackCall, callbackSignedIn = async () => !!(await loadCallbackToken()), request = peerRequest, cluster = null }) {
  /** @type {ReturnType<typeof storeTarget> | null} */
  let pinned = null;
  // A one-shot command has no election running: it asks the members who is
  // master, once, when it pins.
  const oneShot = async (/** @type {Record<string, any>} */ config) => {
    const t = storeTarget(config, cluster);
    if (t.mode.mode !== 'cluster' || cluster) return t;
    const found = await findClusterMaster(config, { request }).catch(() => null);
    return found ? { mode: t.mode, peer: found.peer, local: found.local, master: found.master } : t;
  };
  const target = async () => (pinned ??= await oneShot(await getConfig()));
  return {
    /** Point every later call at the store `config` names. @param {Record<string, any>} config */
    pin(config) {
      pinned = storeTarget(config, cluster);
    },
    /** Whether `config` names another store than the one pinned. @param {Record<string, any>} config */
    differs(config) {
      return JSON.stringify(storeTarget(config, cluster)) !== JSON.stringify(pinned);
    },
    /** @type {Api} */
    async api(method, path, params = null, opts = {}) {
      const t = await target();
      const { mode, peer } = t;
      if (mode.mode === 'host' || (mode.mode === 'cluster' && t.local)) return store.call(method, path, params, opts);
      if (mode.mode === 'follow') {
        if (!peer) throw new Error(`no linked instance named ${safeLine(mode.peer, 64)} (accountSync.peer)`);
        return peerStoreApi(peer, { request })(method, path, params, opts);
      }
      if (mode.mode === 'cluster') {
        // No master: the same as a store that cannot be reached, so a
        // renewal waits rather than going ahead unlocked.
        if (!peer) throw new Error('no account store master is reachable');
        return peerStoreApi(peer, { request })(method, path, params, opts);
      }
      return callback(method, path, params, opts);
    },
    // A store of your own is always "signed in": with the host unreachable,
    // the sync then holds back renewals instead of renewing on its own and
    // signing the other machines out.
    async isSignedIn() {
      const { mode } = await target();
      return mode.mode !== 'off' || callbackSignedIn();
    },
    where() {
      if (pinned?.mode.mode === 'cluster') {
        if (pinned.local) return 'the account store on this machine (master)';
        return pinned.master ? `the account store on ${safeLine(pinned.master, 64)} (master)` : 'the account store (no master reachable)';
      }
      return storeLabel(pinned?.mode ?? { mode: 'off' });
    },
    /** The mode pinned, 'off' before the first pin. */
    mode() {
      return pinned?.mode.mode ?? 'off';
    },
    /** Whether the store pinned is one of your own (CredentialSync seedsAll). */
    ownStore() {
      return !!pinned && pinned.mode.mode !== 'off';
    },
  };
}
