// Account sync without a third-party service: the credential store, kept by
// one of your own instances.
//
// The account sync (credential-sync.js) keeps each OAuth account's tokens in a
// store every install reads, and orders renewals through a per-row lock so two
// installs never rotate one token family at once. callback.net is one such
// store. This is another: a file beside this instance's config that answers
// the same small API (list, read, create, update, delete, lock, unlock), so
// the sync itself runs unchanged against it. The instance holding the file
// keeps the accounts (`accountSync.mode: "host"`); your other instances reach
// it through the linked-instance channel (peers.js) with the proxy key they
// already hold (`accountSync.mode: "follow"`, instance-sync.js).
//
// Every write is a read-modify-write under the same advisory file lock the
// config uses (config.js withConfigLock), in its strict form: a write never
// goes ahead without it, so the server and a CLI command on this machine can
// both use the store directly and never hand one renewal lock to two callers.
// A lock that cannot be had is refused (error_store_busy), which the sync
// treats like an unreachable store: it holds the renewal back. The file holds live refresh
// tokens, like the config does: it is written atomically with mode 0600.
//
// A file that does not parse is never written over: a lost store would cost
// every machine its sign-ins, so the operator decides what to do with it.
//
// With a master and backups (`accountSync.mode: "cluster"`, sync-cluster.js)
// every member keeps such a file: the master answers the store's API, and
// each backup holds a copy of the master's to take over with. The file says
// how current it is with two counters: `rev`, raised by every write, and
// `term`, raised each time a member takes over as master. A copy is newer
// than another when its term is higher, or its term is the same and its rev
// higher, so a member that comes back after a failover can tell that the
// copy kept meanwhile is the one to take.

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { getConfigPath, withConfigLock, writeJsonAtomic } from './config.js';

const STORE_VERSION = 1;
/** Bounds on what one caller can make this machine keep. */
const MAX_ROWS = 1000;
const MAX_KEY_LENGTH = 200;
const MAX_DATA_LENGTH = 64 * 1024;
/** The lease a :lock asks for, in seconds: the default and the bounds. */
const DEFAULT_LOCK_S = 30;
const MIN_LOCK_S = 1;
const MAX_LOCK_S = 300;
const MAX_PAGE_SIZE = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_RE = /^User\/Credential(?:\/([^/:]+)(?::(lock|unlock))?)?$/;

/**
 * A refusal with the token the sync reads (`err.token`), as callback.net
 * answers: error_not_found, error_key_exists, error_credential_locked,
 * error_bad_request, error_store_full, error_store_unreadable, error_store_busy.
 */
export class SyncStoreError extends Error {
  /**
   * @param {string} token
   * @param {string} message
   */
  constructor(token, message) {
    super(message);
    this.token = token;
  }
}

/**
 * Where the store lives: beside the config, like the state file.
 * @param {string} [configPath]
 */
export function getSyncStorePath(configPath = getConfigPath()) {
  return configPath.endsWith('.json') ? configPath.replace(/\.json$/, '.sync-store.json') : configPath + '.sync-store';
}

/**
 * @typedef {{ id: string, key: string, data: string, updated: number, lockedAt: number|null, lease?: string|null }} StoreRow
 * @typedef {{ v: number, term: number, rev: number, rows: StoreRow[] }} StoreFile
 * @typedef {{ term: number, rev: number }} StorePosition
 */

/**
 * Whether position `a` is newer than `b`: a later term, or the same term
 * and a later rev.
 * @param {StorePosition} a
 * @param {StorePosition} b
 */
export function isNewerPosition(a, b) {
  return a.term > b.term || (a.term === b.term && a.rev > b.rev);
}

/** A count from a file or a reply: a whole number, 0 when it is not one. */
function counter(/** @type {unknown} */ v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * A row as callback.net's User/Credential answers it, which is what the sync reads.
 * @param {StoreRow} r
 */
function view(r) {
  return { User_Credential__: r.id, Key: r.key, Data: r.data, Updated: { unixms: r.updated } };
}

/**
 * The rows of a store file's contents, checked; throws when they are not a store.
 * @param {string} text
 * @returns {StoreFile}
 */
function parseStore(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { doc = null; }
  if (!doc || typeof doc !== 'object' || doc.v !== STORE_VERSION || !Array.isArray(doc.rows)) {
    throw new SyncStoreError('error_store_unreadable', 'the account store file is not one this version reads; it was left as it is');
  }
  /** @type {StoreRow[]} */
  const rows = [];
  for (const r of doc.rows) {
    if (!r || typeof r.id !== 'string' || typeof r.key !== 'string' || typeof r.data !== 'string') continue;
    rows.push({ id: r.id, key: r.key, data: r.data, updated: Number(r.updated) || 0, lockedAt: Number.isFinite(r.lockedAt) ? r.lockedAt : null, lease: typeof r.lease === 'string' ? r.lease : null });
  }
  return { v: STORE_VERSION, term: counter(doc.term), rev: counter(doc.rev), rows };
}

/**
 * The store at `path`. `call` takes what callbackCall takes, so it can stand
 * in for it as the sync's `api`.
 *
 * @param {{ path?: string, now?: () => number }} [opts]
 */
export function createSyncStore({ path = getSyncStorePath(), now = Date.now } = {}) {
  /** @returns {Promise<StoreFile>} */
  async function load() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (/** @type {any} */ err) {
      if (err?.code === 'ENOENT') return { v: STORE_VERSION, term: 0, rev: 0, rows: [] };
      throw err;
    }
    return parseStore(text);
  }

  /**
   * Change the store under its lock. `fn` returns what the call answers and
   * whether anything changed; nothing is written when nothing did. A write
   * raises `rev`, unless `fn` set the position itself (a copy taken from
   * the master keeps the master's).
   * @template T
   * @param {(store: StoreFile) => { result: T, changed: boolean, positioned?: boolean }} fn
   * @returns {Promise<T>}
   */
  function update(fn) {
    return withConfigLock(path, async () => {
      const store = await load();
      const { result, changed, positioned = false } = fn(store);
      if (changed) {
        if (!positioned) store.rev += 1;
        await writeJsonAtomic(path, store);
      }
      return result;
    }, { strict: true }).catch((/** @type {any} */ err) => {
      if (err?.code === 'LOCK_BUSY') throw new SyncStoreError('error_store_busy', 'the account store is busy; try again');
      throw err;
    });
  }

  /** @param {StoreFile} store @param {string} id */
  function find(store, id) {
    const row = store.rows.find(r => r.id === id);
    if (!row) throw new SyncStoreError('error_not_found', 'no such credential');
    return row;
  }

  /** @param {unknown} data */
  function checkData(data) {
    if (typeof data !== 'string') throw new SyncStoreError('error_bad_request', '"Data" must be a string');
    if (data.length > MAX_DATA_LENGTH) throw new SyncStoreError('error_bad_request', '"Data" is too long');
    return data;
  }

  /**
   * One call of the User/Credential API.
   * @param {string} method
   * @param {string} route
   * @param {Record<string, any>|null} [params]
   * @param {{ envelope?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async function call(method, route, params = null, opts = {}) {
    const m = PATH_RE.exec(String(route || ''));
    if (!m) throw new SyncStoreError('error_bad_request', 'unknown route');
    const [, id, action] = m;
    if (id != null && !ID_RE.test(id)) throw new SyncStoreError('error_not_found', 'no such credential');
    const p = params && typeof params === 'object' ? params : {};

    if (id == null && method === 'GET') {
      const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(p.results_per_page)) || MAX_PAGE_SIZE));
      const page = Math.max(1, Math.floor(Number(p.page_no)) || 1);
      const { rows } = await load();
      const data = rows.slice((page - 1) * size, page * size).map(view);
      const pageMax = Math.max(1, Math.ceil(rows.length / size));
      return opts.envelope ? { data, paging: { page_no: page, page_max: pageMax, count: rows.length } } : data;
    }

    if (id == null && method === 'POST') {
      const key = p.Key;
      if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) throw new SyncStoreError('error_bad_request', '"Key" must be a short string');
      const data = checkData(p.Data);
      return update((store) => {
        if (store.rows.some(r => r.key === key)) throw new SyncStoreError('error_key_exists', 'a credential with that key exists');
        if (store.rows.length >= MAX_ROWS) throw new SyncStoreError('error_store_full', 'the account store is full');
        const row = { id: 'ucr-' + randomBytes(9).toString('hex'), key, data, updated: now(), lockedAt: null };
        store.rows.push(row);
        return { result: view(row), changed: true };
      });
    }

    if (id == null) throw new SyncStoreError('error_bad_request', 'unknown route');

    if (action === 'lock' && method === 'POST') {
      const asked = Number(p.timeout);
      const timeoutS = Number.isFinite(asked) ? Math.min(MAX_LOCK_S, Math.max(MIN_LOCK_S, asked)) : DEFAULT_LOCK_S;
      return update((store) => {
        const row = find(store, id);
        // Handed over once it is older than the lease this taker names, the
        // rule the sync is written for (credential-sync.js LOCK_TIMEOUT_S).
        if (row.lockedAt != null && now() - row.lockedAt < timeoutS * 1000) {
          throw new SyncStoreError('error_credential_locked', 'the credential is locked');
        }
        // Named, so the unlock has to name it too: one that arrives after the
        // lock was handed over releases nothing.
        row.lockedAt = now();
        row.lease = randomBytes(12).toString('hex');
        return { result: { ...view(row), Lease: row.lease }, changed: true };
      });
    }
    if (action === 'unlock' && method === 'POST') {
      return update((store) => {
        const row = find(store, id);
        if (row.lockedAt == null || (row.lease && p.Lease !== row.lease)) return { result: view(row), changed: false };
        row.lockedAt = null;
        row.lease = null;
        return { result: view(row), changed: true };
      });
    }
    if (action) throw new SyncStoreError('error_bad_request', 'unknown route');

    if (method === 'GET') return view(find(await load(), id));
    if (method === 'PATCH') {
      const data = checkData(p.Data);
      return update((store) => {
        const row = find(store, id);
        row.data = data;
        row.updated = now();
        return { result: view(row), changed: true };
      });
    }
    if (method === 'DELETE') {
      return update((store) => {
        find(store, id);
        store.rows = store.rows.filter(r => r.id !== id);
        return { result: { ok: true }, changed: true };
      });
    }
    throw new SyncStoreError('error_bad_request', 'unknown route');
  }

  /**
   * Mark every row as a seed (credential-sync.js heldElsewhere): what the
   * file holds when this machine starts keeping the store, or starts again,
   * may predate renewals the other machines made without it, so none of it
   * may replace a newer token. A renewal under the lock clears the mark.
   * @returns {Promise<number>} how many rows were marked
   */
  async function reseed() {
    return update((store) => {
      const n = markSeeds(store);
      return { result: n, changed: n > 0 };
    });
  }

  /**
   * The whole file, for a backup to keep a copy of (sync-cluster.js). Read
   * without the lock: every write replaces the file in one rename, so a read
   * sees one version or the other.
   * @returns {Promise<StoreFile>}
   */
  function snapshot() {
    return load();
  }

  /** How current this copy is. @returns {Promise<StorePosition>} */
  async function position() {
    const { term, rev } = await load();
    return { term, rev };
  }

  /**
   * Make this file a copy of another member's (its `snapshot`), position
   * included. What it is given is checked like a file read from disk, and an
   * unreadable file here is still never written over.
   * @param {unknown} snap
   * @returns {Promise<StorePosition>}  the position now held
   */
  async function replaceWith(snap) {
    const copy = parseStore(JSON.stringify(snap ?? null));
    if (copy.rows.length > MAX_ROWS) throw new SyncStoreError('error_store_full', 'the copy holds more rows than a store may');
    return update((store) => {
      store.term = copy.term;
      store.rev = copy.rev;
      store.rows = copy.rows;
      return { result: { term: copy.term, rev: copy.rev }, changed: true, positioned: true };
    });
  }

  /**
   * Start answering as the master, at `term`. Every row becomes a seed, as
   * when a machine starts keeping the store: the copy may predate renewals
   * made on the old master. A lock the copy holds is stamped as taken now,
   * so a renewal that was under way on the old master keeps its row for a
   * full lease and stores its token before anyone else renews that account.
   * @param {number} term
   * @returns {Promise<StorePosition>}
   */
  async function promote(term) {
    return update((store) => {
      store.term = counter(term);
      store.rev += 1;
      markSeeds(store);
      const at = now();
      for (const row of store.rows) if (row.lockedAt != null) row.lockedAt = at;
      return { result: { term: store.term, rev: store.rev }, changed: true, positioned: true };
    });
  }

  return { path, call, reseed, snapshot, position, replaceWith, promote };
}

/**
 * Mark every token row of `store` as a seed, in place.
 * @param {StoreFile} store
 * @returns {number} how many rows were marked
 */
function markSeeds(store) {
  let n = 0;
  for (const row of store.rows) {
    let blob;
    try { blob = JSON.parse(row.data); } catch { continue; }
    if (!blob || typeof blob !== 'object' || blob._deleted != null || typeof blob.refreshToken !== 'string' || blob.seeded) continue;
    blob.seeded = true;
    row.data = JSON.stringify(blob);
    n++;
  }
  return n;
}
