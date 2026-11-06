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
// higher. `owner` names the member that started the term: two members that
// each took over on their own side of a split can reach the same counters
// with different contents, and the owner tells those copies apart.
// `lineage` lists the earlier terms a copy took in (each with the rev it had
// reached), so a member can tell whether another's copy is already part of
// its own (contains) or holds writes it lacks, which have to be merged in
// rather than copied over.
//
// `leader` is the write fence. It names the member answering as master, and
// only while it does: a takeover sets it, a step-down clears it, and a copy
// taken from another member never carries it. With a master and backups,
// every call of the store's API — from this server, from a CLI command on
// this machine, or from another machine — checks it under the file lock, so
// a renewal still under way when the master steps down cannot write to a
// store the next master has already copied. The server also refuses its own
// calls the moment its election stops making it master (index.js), before
// the file is even touched.
//
// A takeover merges the copies the members hold. A copy another one already
// contains brings nothing (it would only bring back what was deleted since),
// a lock any copy holds is kept, and `deleted` remembers the rows deleted
// for a month, so a copy from the other side of a split cannot bring them
// back either.

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
 * @typedef {{ term: number, owner: string|null, rev: number }} TermMark
 * @typedef {{ key: string, at: number }} DeletedMark
 * @typedef {{ v: number, term: number, rev: number, owner: string|null, leader: string|null, lineage: TermMark[], deleted: DeletedMark[], rows: StoreRow[] }} StoreFile
 * @typedef {{ term: number, rev: number, owner?: string|null, lineage?: TermMark[] }} StorePosition
 */

/** How many earlier terms a copy remembers, beyond the copies a takeover merged. */
const MAX_LINEAGE = 64;
/**
 * Rows deleted are remembered this long, and at most this many, so a copy
 * that still holds one does not bring it back at a merge. Longer than the
 * week a tombstone is kept before it is deleted (credential-sync.js).
 */
const DELETED_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_DELETED = 1000;

/**
 * Whether copy `a` already holds everything copy `b` does: `b` is `a` itself
 * or an earlier version of it (same term and owner, no later rev), or a term
 * `a` took in at or past the rev `b` had reached. An empty store is part of
 * every copy.
 * @param {StorePosition} a
 * @param {StorePosition} b
 */
export function contains(a, b) {
  if (b.term === 0 && b.rev === 0) return true;
  const same = (/** @type {{ term: number, owner?: string|null }} */ m) => m.term === b.term && (m.owner ?? null) === (b.owner ?? null);
  if (same(a) && a.rev >= b.rev) return true;
  return (a.lineage || []).some(m => same(m) && m.rev >= b.rev);
}

/**
 * The lineage of a copy made from `positions` (this one first), plus the
 * positions themselves: each term once, at the highest rev seen.
 * @param {StorePosition[]} positions
 * @returns {TermMark[]}
 */
function joinLineage(positions) {
  /** @type {Map<string, TermMark>} */
  const marks = new Map();
  const keyOf = (/** @type {{ term: number, owner?: string|null }} */ m) => `${m.term}\u0000${m.owner ?? ''}`;
  const add = (/** @type {TermMark} */ m) => {
    if (m.term === 0 && m.rev === 0) return;
    const k = keyOf(m);
    const held = marks.get(k);
    if (!held || m.rev > held.rev) marks.set(k, { term: m.term, owner: m.owner ?? null, rev: m.rev });
  };
  for (const p of positions) {
    for (const m of p.lineage || []) add(m);
    add({ term: p.term, owner: p.owner ?? null, rev: p.rev });
  }
  // The copies merged now are always kept, however old their term: a
  // member that returned from far behind has to find its copy contained,
  // or the next round would merge it all over again. The rest are the
  // latest terms, up to MAX_LINEAGE.
  const inputs = new Set(positions.filter(p => !(p.term === 0 && p.rev === 0)).map(keyOf));
  const all = [...marks.values()].sort((x, y) => y.term - x.term || y.rev - x.rev);
  const kept = all.filter(m => inputs.has(keyOf(m)));
  for (const m of all) {
    if (kept.length >= MAX_LINEAGE + inputs.size) break;
    if (!inputs.has(keyOf(m))) kept.push(m);
  }
  return kept.sort((x, y) => y.term - x.term || y.rev - x.rev);
}

/** A lineage from a file or a reply. @param {unknown} v @returns {TermMark[]} */
export function lineageOf(v) {
  if (!Array.isArray(v)) return [];
  /** @type {TermMark[]} */
  const out = [];
  // Room for the merged copies of a full list of members (sync-cluster.js MAX_MEMBERS).
  for (const m of v.slice(0, MAX_LINEAGE + 16)) {
    if (!m || typeof m !== 'object') continue;
    const term = counter(m.term);
    const rev = counter(m.rev);
    out.push({ term, rev, owner: typeof m.owner === 'string' && m.owner ? m.owner.slice(0, 64) : null });
  }
  return out;
}

/**
 * Whether two positions name the same version of the store: the same
 * counters, in a term the same member started.
 * @param {StorePosition} a
 * @param {StorePosition} b
 */
export function samePosition(a, b) {
  return a.term === b.term && a.rev === b.rev && (a.owner ?? null) === (b.owner ?? null);
}

/** The expiry a row's token carries, or null when it holds none. @param {StoreRow} row */
function tokenExpiry(row) {
  try {
    const b = JSON.parse(row.data);
    return b && typeof b === 'object' && b._deleted == null && Number.isFinite(b.expiresAt) && typeof b.refreshToken === 'string' && b.refreshToken ? b.expiresAt : null;
  } catch {
    return null;
  }
}

/**
 * Several copies of the store made one, row by row, keyed by the row's key:
 * a row only one copy holds is kept, and of two rows for the same account
 * the one with the later token expiry wins (a renewal always pushes it
 * forward), else the one written later. What a stale copy brings back is
 * harmless: a takeover marks every row as a seed, and a seed never replaces
 * a newer token any machine holds.
 *
 * The lock is merged apart from the token: a row any copy holds locked stays
 * locked (the latest lock and its lease), whichever copy's token wins, so a
 * renewal under way on the copy that lost is still waited for. A row a copy
 * deleted (`deleted`, see DELETE) after it was last written is not brought
 * back by a copy that still holds it.
 * @param {StoreRow[][]} copies  the first is this machine's own
 * @param {DeletedMark[]} [deleted]
 * @returns {StoreRow[]}
 */
export function mergeRows(copies, deleted = []) {
  /** @type {Map<string, StoreRow>} */
  const byKey = new Map();
  /** @type {Map<string, StoreRow>} the latest lock seen per key */
  const locks = new Map();
  for (const rows of copies) {
    for (const row of rows) {
      if (row.lockedAt != null) {
        const l = locks.get(row.key);
        if (!l || /** @type {number} */ (row.lockedAt) > /** @type {number} */ (l.lockedAt)) locks.set(row.key, row);
      }
      const held = byKey.get(row.key);
      if (!held) { byKey.set(row.key, { ...row }); continue; }
      const a = tokenExpiry(held);
      const b = tokenExpiry(row);
      const wins = a != null && b != null ? b > a : row.updated > held.updated;
      if (wins) byKey.set(row.key, { ...row });
    }
  }
  /** @type {Map<string, number>} */
  const gone = new Map();
  for (const d of deleted) gone.set(d.key, Math.max(gone.get(d.key) ?? 0, d.at));
  /** @type {StoreRow[]} */
  const out = [];
  for (const row of byKey.values()) {
    const at = gone.get(row.key);
    if (at != null && row.updated <= at) continue;
    const l = locks.get(row.key);
    if (l) { row.lockedAt = l.lockedAt; row.lease = l.lease ?? null; }
    out.push(row);
  }
  return out.slice(0, MAX_ROWS);
}

/**
 * The copies a takeover merges, without those another copy already
 * contains: an ancestor holds nothing its descendant lacks, and merging its
 * rows would bring back what the descendant deleted. Of copies at the same
 * position, the first is kept.
 * @template {StorePosition} T
 * @param {T[]} copies
 * @returns {T[]}
 */
export function newestCopies(copies) {
  return copies.filter((c, i) => !copies.some((d, j) => j !== i && contains(d, c) && (!contains(c, d) || j < i)));
}

/**
 * The deletion marks of several copies, each key once at its latest
 * deletion, the old ones dropped.
 * @param {DeletedMark[][]} lists
 * @param {number} now
 * @returns {DeletedMark[]}
 */
function joinDeleted(lists, now) {
  /** @type {Map<string, number>} */
  const at = new Map();
  for (const list of lists) for (const d of list) if (now - d.at < DELETED_TTL_MS) at.set(d.key, Math.max(at.get(d.key) ?? 0, d.at));
  return [...at].map(([key, t]) => ({ key, at: t })).sort((x, y) => y.at - x.at).slice(0, MAX_DELETED);
}

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
  /** @type {DeletedMark[]} */
  const deleted = [];
  for (const d of Array.isArray(doc.deleted) ? doc.deleted.slice(0, MAX_DELETED) : []) {
    if (d && typeof d.key === 'string' && Number.isFinite(d.at)) deleted.push({ key: d.key, at: d.at });
  }
  return { v: STORE_VERSION, term: counter(doc.term), rev: counter(doc.rev), owner: nameOf(doc.owner), leader: nameOf(doc.leader), lineage: lineageOf(doc.lineage), deleted, rows };
}

/** A member name from a file, or null. @param {unknown} v */
function nameOf(v) {
  return typeof v === 'string' && v ? v.slice(0, 64) : null;
}

/**
 * The store at `path`. `call` takes what callbackCall takes, so it can stand
 * in for it as the sync's `api`.
 *
 * `leaderName` turns on the write fence (see the top of this file): when it
 * names this machine, every call is refused unless the file says this
 * machine leads it. Null (the default, and a store kept by one machine) is
 * no fence.
 *
 * @param {{ path?: string, now?: () => number, leaderName?: () => (string | null | Promise<string | null>) }} [opts]
 */
export function createSyncStore({ path = getSyncStorePath(), now = Date.now, leaderName = () => null } = {}) {
  /**
   * Refuse when the fence is on and the file does not name this machine.
   * @param {StoreFile} store
   * @param {string|null} want
   */
  function fence(store, want) {
    if (want != null && store.leader !== want) throw new SyncStoreError('error_not_host', 'this machine is not the master of the account store right now');
  }

  /** @returns {Promise<StoreFile>} */
  async function load() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (/** @type {any} */ err) {
      if (err?.code === 'ENOENT') return { v: STORE_VERSION, term: 0, rev: 0, owner: null, leader: null, lineage: [], deleted: [], rows: [] };
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
    const want = await leaderName();
    // Every change goes through here, so the fence is checked under the lock.
    /** @type {typeof update} */
    const write = (fn) => update((store) => { fence(store, want); return fn(store); });
    const read = async () => { const store = await load(); fence(store, want); return store; };
    const m = PATH_RE.exec(String(route || ''));
    if (!m) throw new SyncStoreError('error_bad_request', 'unknown route');
    const [, id, action] = m;
    if (id != null && !ID_RE.test(id)) throw new SyncStoreError('error_not_found', 'no such credential');
    const p = params && typeof params === 'object' ? params : {};

    if (id == null && method === 'GET') {
      const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(p.results_per_page)) || MAX_PAGE_SIZE));
      const page = Math.max(1, Math.floor(Number(p.page_no)) || 1);
      const { rows } = await read();
      const data = rows.slice((page - 1) * size, page * size).map(view);
      const pageMax = Math.max(1, Math.ceil(rows.length / size));
      return opts.envelope ? { data, paging: { page_no: page, page_max: pageMax, count: rows.length } } : data;
    }

    if (id == null && method === 'POST') {
      const key = p.Key;
      if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) throw new SyncStoreError('error_bad_request', '"Key" must be a short string');
      const data = checkData(p.Data);
      return write((store) => {
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
      return write((store) => {
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
      return write((store) => {
        const row = find(store, id);
        if (row.lockedAt == null || (row.lease && p.Lease !== row.lease)) return { result: view(row), changed: false };
        row.lockedAt = null;
        row.lease = null;
        return { result: view(row), changed: true };
      });
    }
    if (action) throw new SyncStoreError('error_bad_request', 'unknown route');

    if (method === 'GET') return view(find(await read(), id));
    if (method === 'PATCH') {
      const data = checkData(p.Data);
      return write((store) => {
        const row = find(store, id);
        row.data = data;
        row.updated = now();
        return { result: view(row), changed: true };
      });
    }
    if (method === 'DELETE') {
      return write((store) => {
        const row = find(store, id);
        store.rows = store.rows.filter(r => r.id !== id);
        // Remembered, so a copy that still holds the row (a member that was
        // away) does not bring it back at the next takeover (mergeRows).
        store.deleted = joinDeleted([[{ key: row.key, at: now() }], store.deleted], now());
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
    const { term, rev, owner, lineage } = await load();
    return { term, rev, owner, lineage };
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
      store.owner = copy.owner;
      store.lineage = copy.lineage;
      store.deleted = copy.deleted;
      // A copy is never led from here: only a takeover sets the fence.
      store.leader = null;
      store.rows = copy.rows;
      return { result: { term: copy.term, rev: copy.rev, owner: copy.owner, lineage: copy.lineage }, changed: true, positioned: true };
    });
  }

  /**
   * Stop leading: clear the fence, so no call made through this file goes
   * ahead from here on. The rows stay as they are, for the next master to
   * take.
   * @returns {Promise<StorePosition>}
   */
  async function resign() {
    return update((store) => {
      const changed = store.leader != null;
      store.leader = null;
      return { result: { term: store.term, rev: store.rev, owner: store.owner, lineage: store.lineage }, changed, positioned: true };
    });
  }

  /**
   * Start answering as the master `name`, at `term`, with the rows of the
   * other members' copies merged in (mergeRows). Every row becomes a seed, as
   * when a machine starts keeping the store: a copy may predate renewals
   * made on the old master. A lock a copy holds is stamped as taken now, so
   * a renewal that was under way on the old master keeps its row for a full
   * lease and stores its token before anyone else renews that account.
   * @param {number} term
   * @param {string} name
   * @param {unknown[]} [copies]  other members' snapshots
   * @returns {Promise<StorePosition>}
   */
  async function promote(term, name, copies = []) {
    const others = copies.map(c => parseStore(JSON.stringify(c ?? null)));
    return update((store) => {
      const all = [store, ...others];
      // Only the copies no other copy contains bring rows (newestCopies),
      // judged on the positions as they were, before this store's changes.
      const newest = newestCopies(all.map(c => ({ ...c })));
      const deleted = joinDeleted(all.map(c => c.deleted), now());
      // Every copy taken in, this one included, is part of the new term.
      store.lineage = joinLineage(all);
      store.rows = mergeRows(newest.map(c => c.rows), deleted);
      store.deleted = deleted;
      store.term = counter(term);
      store.rev += 1;
      store.owner = name;
      store.leader = name;
      markSeeds(store);
      const at = now();
      for (const row of store.rows) if (row.lockedAt != null) row.lockedAt = at;
      return { result: { term: store.term, rev: store.rev, owner: store.owner, lineage: store.lineage }, changed: true, positioned: true };
    });
  }

  return { path, call, reseed, snapshot, position, replaceWith, promote, resign };
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
