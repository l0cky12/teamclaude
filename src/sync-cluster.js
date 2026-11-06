// A master and backups for the account store: the store one of your own
// machines keeps (sync-store.js), with a copy on others that take over when
// it goes down.
//
// With `"accountSync": { "mode": "cluster", "members": ["server", "desk", "laptop"] }`
// on every machine, the list is the order of succession. The master is the
// first member that is up; the others are backups, each keeping a copy of
// the master's store. A machine that runs the same setting without being in
// the list is a plain follower: it uses whichever member is master, and
// keeps no copy.
//
// HOW THE MASTER IS ELECTED. Every machine checks every member every 10
// seconds (POST /teamclaude/sync-cluster on it, with the proxy key it holds
// for that machine) and works out the master on its own, walking the list
// from the top:
//
// - itself: it is the master (every member above it is down);
// - a member that answers: that one is the master;
// - a member it has not heard from yet: nobody is, for now (it waits);
// - a member that has not answered for 30 seconds (3 checks in a row) is
//   down, and the walk goes on to the next — unless a member that does
//   answer reached it at its own last check, in which case it is up and
//   only this machine cannot see it, and nobody is the master from here.
//
// Every machine runs the same walk over the same list, so they agree on the
// master without a vote. Taking over is then a handshake, so that two
// members who both think it is their turn (a master restarting just as its
// backup gives up on it) never both answer:
//
// 1. The member says it is a CANDIDATE: from now on every check of it
//    answers so.
// 2. It checks every member again, then and there. It backs off if one
//    above it in the list answers, or if any member answers that it is a
//    candidate or the master. Two candidates that check each other both
//    back off; the walk then makes the lower one a backup, and the higher
//    one goes again next round.
// 3. It merges every copy the members that answer hold (sync-store.js
//    mergeRows), starts a new term above every term it has seen, and only
//    then answers as master.
//
// A master steps down as soon as a member above it is up, or a member it
// reaches runs another list, or says it is a candidate or master itself, or
// holds a copy from a term this one did not start. Stepping down clears the
// store's write fence (sync-store.js) BEFORE this machine stops saying it is
// master, so the copy the next master takes is final: a renewal still under
// way here can no longer write to it.
//
// What this cannot rule out is a network split where neither side sees any
// member of the other: each side then elects its own master, and both may
// renew the same sign-in. With two members there is no third to tell them
// apart; that is the price of the second taking over at all.
//
// While nobody is the master, nothing renews a token through the store: a
// token that is still good is used, and one that has run out waits, exactly
// as when a single store machine is down (instance-sync.js).

import { configuredPeers, instanceName, peerRequest } from './peers.js';
import { contains, lineageOf, samePosition } from './sync-store.js';
import { safeLine } from './safe-text.js';

/** How often each member is checked. */
export const CLUSTER_CHECK_MS = 10_000;
/** Checks in a row a member has to miss to count as down: 30 s at the interval above. */
export const DOWN_AFTER_MISSES = 3;
/** One check: a small read on your own network. */
const CHECK_TIMEOUT_MS = 3_000;
/** A copy of the store: bigger than a check, still on your own network. */
const SNAPSHOT_TIMEOUT_MS = 15_000;
/** The most members a list may name. */
export const MAX_MEMBERS = 16;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @typedef {import('./peers.js').Peer} Peer
 * @typedef {import('./sync-store.js').StorePosition} StorePosition
 * @typedef {'master' | 'candidate' | 'backup' | 'follower' | 'off'} ClusterRole
 * @typedef {'up' | 'down' | 'unknown' | 'unplaced'} MemberState
 * @typedef {object} MemberView
 * @property {MemberState} state  up: answered the last check; down: missed DOWN_AFTER_MISSES in a row;
 *   unknown: not heard from yet; unplaced: no linked instance of this machine is that member
 * @property {number} misses
 * @property {boolean} cluster  whether it answers checks (false: a version without them)
 * @property {string|null} peer  the linked instance it is reached through
 * @property {ClusterRole|null} role
 * @property {string[]} sees  the members whose last check it answered, itself included
 * @property {string[]|null} members  the list it runs with
 * @property {StorePosition|null} position
 * @typedef {{ master: string|null, reason: string|null }} Election
 * @typedef {{ request?: typeof peerRequest, timeoutMs?: number }} AskOpts
 */

/**
 * The member list of a cluster setting: names, trimmed, each one a name an
 * instance can have, no repeats. Null when it is not a usable list (fewer
 * than two, or a name that is not one).
 * @param {unknown} list
 * @returns {string[]|null}
 */
export function parseMembers(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_MEMBERS) return null;
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!NAME_RE.test(name) || out.includes(name)) return null;
    out.push(name);
  }
  return out;
}

/**
 * Who is master, as this machine sees it: the walk described at the top.
 * @param {{ members: string[], self: string, views: Map<string, MemberView> }} opts
 * @returns {Election}
 */
export function elect({ members, self, views }) {
  for (const name of members) {
    if (name === self) return { master: self, reason: null };
    const v = views.get(name);
    if (!v || v.state === 'unplaced') return { master: null, reason: `${name} is not a linked instance of this machine` };
    if (v.state === 'unknown') return { master: null, reason: `waiting to hear from ${name}` };
    if (v.state === 'up') {
      if (!v.cluster) return { master: null, reason: `${name} runs a version without master and backups; update it` };
      return { master: name, reason: null };
    }
    // Down from here. A member that answers and still counts it up says the
    // fault is between this machine and it, not that it is gone.
    const witness = members.find(w => w !== name && w !== self && views.get(w)?.state === 'up' && views.get(w)?.sees.includes(name));
    if (witness) return { master: null, reason: `${name} does not answer this machine, but ${witness} still reaches it` };
  }
  return { master: null, reason: 'no member is up' };
}

/**
 * One check of a linked instance: what it answers at /teamclaude/sync-cluster.
 * Null when it cannot be reached; `{ cluster: false }` when it answers but
 * runs a version without the route.
 * @param {Peer} peer
 * @param {AskOpts} [opts]
 * @returns {Promise<Record<string, any>|null>}
 */
export async function askMember(peer, { request = peerRequest, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  let out;
  try {
    out = await request(peer, 'sync-cluster', { method: 'POST', body: Buffer.from(JSON.stringify({ op: 'status' })), timeoutMs });
  } catch {
    return null;
  }
  if (out.status === 404) return { cluster: false };
  if (out.status !== 200) return null;
  try {
    const j = JSON.parse(out.body.toString('utf8'));
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

/**
 * A copy of a member's store.
 * @param {Peer} peer
 * @param {AskOpts} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchSnapshot(peer, { request = peerRequest, timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  const out = await request(peer, 'sync-cluster', { method: 'POST', body: Buffer.from(JSON.stringify({ op: 'snapshot' })), timeoutMs });
  /** @type {any} */ let j = null;
  try { j = JSON.parse(out.body.toString('utf8')); } catch { /* the status says enough */ }
  if (out.status !== 200 || !j?.ok || !j.store) throw new Error(`${peer.name} did not hand over its account store (${safeLine(typeof j?.error === 'string' ? j.error : `status ${out.status}`, 120)})`);
  return j.store;
}

/** A position from a reply, or null. @param {any} p @returns {StorePosition|null} */
function positionOf(p) {
  if (!p || typeof p !== 'object') return null;
  const term = Number(p.term);
  const rev = Number(p.rev);
  const owner = typeof p.owner === 'string' ? p.owner.slice(0, 64) : null;
  return Number.isSafeInteger(term) && Number.isSafeInteger(rev) && term >= 0 && rev >= 0 ? { term, rev, owner, lineage: lineageOf(p.lineage) } : null;
}

/** A role from a reply, or null. @param {unknown} r @returns {ClusterRole|null} */
function roleOf(r) {
  return r === 'master' || r === 'candidate' || r === 'backup' || r === 'follower' ? r : null;
}

/** A list of names from a reply. @param {unknown} v @returns {string[]} */
function namesOf(v) {
  return Array.isArray(v) ? v.filter(n => typeof n === 'string').slice(0, MAX_MEMBERS * 2) : [];
}

export class ClusterMonitor {
  /**
   * @param {object} opts
   * @param {() => Record<string, any>} opts.getConfig  the running config
   * @param {{ snapshot: () => Promise<any>, position: () => Promise<StorePosition>, replaceWith: (snap: unknown) => Promise<StorePosition>, promote: (term: number, name: string, copies?: unknown[]) => Promise<StorePosition>, resign: () => Promise<StorePosition> }} opts.store  this machine's store (sync-store.js)
   * @param {() => void} [opts.onChange]  the master changed, or this machine's role did: the sync has to move to it
   * @param {typeof peerRequest} [opts.request]
   * @param {(line: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {number} [opts.checkMs]
   */
  constructor({ getConfig, store, onChange = () => {}, request = peerRequest, log = (l) => console.log(l), now = Date.now, checkMs = CLUSTER_CHECK_MS }) {
    this.getConfig = getConfig;
    this.store = store;
    this.onChange = onChange;
    this.request = request;
    this.log = log;
    this.now = now;
    this.checkMs = checkMs;
    /** @type {Map<string, MemberView>} keyed by member name */
    this.views = new Map();
    /** Names linked instances answered with, by the name they are linked under. @type {Map<string, string>} */
    this.learned = new Map();
    /** @type {ClusterRole} */
    this.role = 'off';
    /** @type {Election} */
    this.election = { master: null, reason: null };
    /** @type {StorePosition} */
    this.position = { term: 0, rev: 0, owner: null, lineage: [] };
    /** @type {string|null} why the last round could not do what it set out to */
    this.lastError = null;
    /** @type {number|null} */
    this.lastCheckAt = null;
    /** The members list the views were built for, to start over when it changes. */
    this._for = '';
    /** @type {ReturnType<typeof setInterval>|null} */
    this._timer = null;
    /** @type {Promise<void>|null} */
    this._round = null;
    /** Stepping down: the fence is being cleared, and no new store call is taken. */
    this._resigning = false;
  }

  /** Check every CLUSTER_CHECK_MS, and once now. Does nothing while the setting is not a cluster. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, this.checkMs);
    this._timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** The cluster setting, or null. @returns {{ members: string[], self: string } | null} */
  setting() {
    const config = this.getConfig();
    const s = config?.accountSync;
    if (s?.mode !== 'cluster') return null;
    const members = parseMembers(s.members);
    return members ? { members, self: instanceName(config) } : null;
  }

  /** Whether this machine answers the store's API now. */
  isMaster() {
    return this.role === 'master' && !this._resigning && !!this.setting();
  }

  /**
   * The linked instance the master is reached through, when it is another
   * machine; null when this machine is the master, or there is none.
   * @returns {Peer|null}
   */
  masterPeer() {
    const master = this.election.master;
    if (!master || this.isMaster()) return null;
    const name = this.views.get(master)?.peer;
    return name ? configuredPeers(this.getConfig()).find(p => p.name === name) || null : null;
  }

  /**
   * One round: check every member, elect, and act on it. Rounds never
   * overlap; a call during one waits for it.
   * @returns {Promise<void>}
   */
  tick() {
    if (!this._round) this._round = this._tick().finally(() => { this._round = null; });
    return this._round;
  }

  async _tick() {
    const setting = this.setting();
    if (!setting) {
      if (this.role === 'master') await this._resign('the account store is no longer kept by a master and backups', 'off');
      else if (this.role !== 'off') this._setRole('off', null);
      this.views.clear();
      this._for = '';
      this.election = { master: null, reason: null };
      return;
    }
    const { members, self } = setting;
    const key = JSON.stringify([self, members]);
    if (key !== this._for) {
      // Another list, or another name for this machine: what was heard about
      // the old one says nothing about the new, and a master elected under
      // the old one is not elected under this one.
      if (this.role === 'master') await this._resign('the member list changed', 'backup');
      this.views.clear();
      this._for = key;
    }
    await this._check(members, self);
    this.lastCheckAt = this.now();
    this.position = await this.store.position().catch(() => this.position);

    const election = elect({ members, self, views: this.views });
    const before = this.election.master;
    this.election = election;
    this.lastError = null;

    if (election.master === self) {
      await this._lead(members, self);
    } else {
      const role = members.includes(self) ? 'backup' : 'follower';
      if (this.role === 'master') await this._resign(election.master ? `${election.master} is up again` : election.reason || 'no member is up', role);
      else if (this.role !== role) this._setRole(role, null);
      if (role === 'backup' && election.master) await this._follow(election.master);
    }
    if (before !== this.election.master) {
      this.log(`[TeamClaude] Account store master: ${this.election.master ? safeLine(this.election.master, 64) + (this.election.master === self ? ' (this machine)' : '') : 'none (' + (this.election.reason || 'no member is up') + ')'}`);
      this.onChange();
    }
  }

  /**
   * Ask every linked instance, and fold the answers into the member views.
   * Every one is asked, not only those linked under a member's name: one
   * linked under another name is placed by the name it answers with.
   * @param {string[]} members
   * @param {string} self
   */
  async _check(members, self) {
    const peers = configuredPeers(this.getConfig());
    const answers = await Promise.all(peers.map(p => askMember(p, { request: this.request })));
    /** @type {Map<string, Record<string, any>|null>} */
    const byPeer = new Map();
    peers.forEach((p, i) => {
      const a = answers[i];
      byPeer.set(p.name, a);
      if (a && typeof a.name === 'string' && NAME_RE.test(a.name)) this.learned.set(p.name, a.name);
    });
    for (const name of members) {
      if (name === self) continue;
      const peer = peers.find(p => p.name === name) || peers.find(p => this.learned.get(p.name) === name) || null;
      const prev = this.views.get(name);
      if (!peer) {
        this.views.set(name, { state: 'unplaced', misses: 0, cluster: false, peer: null, role: null, sees: [], members: null, position: null });
        continue;
      }
      const a = byPeer.get(peer.name) ?? null;
      if (a) {
        this.views.set(name, {
          state: 'up', misses: 0, cluster: a.cluster !== false, peer: peer.name,
          role: roleOf(a.role),
          sees: namesOf(a.sees), members: a.members ? namesOf(a.members) : null, position: positionOf(a.position),
        });
        continue;
      }
      const misses = (prev?.peer === peer.name ? prev.misses : 0) + 1;
      const was = prev?.peer === peer.name ? prev.state : 'unknown';
      /** @type {MemberState} */
      const state = misses >= DOWN_AFTER_MISSES ? 'down' : was === 'up' ? 'up' : 'unknown';
      // Still up for now, but it no longer says what it sees: a member that
      // has stopped answering is no witness for another.
      this.views.set(name, { state, misses, cluster: prev?.cluster ?? true, peer: peer.name, role: prev?.role ?? null, sees: [], members: prev?.members ?? null, position: prev?.position ?? null });
    }
  }

  /**
   * This machine is first in line. A sitting master checks it still may be;
   * any other member takes over once it is safe (the handshake at the top).
   * @param {string[]} members
   * @param {string} self
   */
  async _lead(members, self) {
    const up = members.filter(n => n !== self && this.views.get(n)?.state === 'up');
    const conflict = this._conflict(members, up);
    if (this.role === 'master') {
      if (conflict) await this._resign(conflict, 'backup');
      else return;
    }
    if (conflict) {
      this._hold(conflict);
      return;
    }
    // 1. Say so first, then 2. look again: whoever checks this machine from
    // here on sees a candidate.
    this._setRole('candidate', null);
    const fresh = await this._confirm(members, self);
    if (fresh.reason) {
      this._hold(fresh.reason);
      return;
    }
    // 3. Every copy the members that answered hold, merged, in a new term.
    try {
      const copies = [];
      for (const peer of fresh.peers) copies.push(await fetchSnapshot(peer, { request: this.request }));
      let term = this.position.term;
      for (const p of fresh.positions) term = Math.max(term, p.term);
      for (const c of copies) term = Math.max(term, Number(c?.term) || 0);
      this.position = await this.store.promote(term + 1, self, copies);
      if (this.role !== 'candidate') return; // stopped meanwhile
      this._setRole('master', null);
    } catch (/** @type {any} */ err) {
      this._hold(`could not take over: ${safeLine(err?.message || String(err), 160)}`);
    }
  }

  /**
   * Why this machine may not lead right now, from this round's checks: a
   * member that runs another list, one that says it is master or candidate,
   * or — for a sitting master — one holding a copy from a term it did not
   * start or a later one.
   * @param {string[]} members
   * @param {string[]} up
   * @returns {string|null}
   */
  _conflict(members, up) {
    for (const n of up) {
      const v = this.views.get(n);
      if (v?.members && JSON.stringify(v.members) !== JSON.stringify(members)) {
        return `${n} runs with another member list; set the same list, in the same order, on every machine`;
      }
    }
    for (const n of up) {
      const role = this.views.get(n)?.role;
      // It steps down (or backs off) when it sees this machine, which is
      // above it; its copy is merged in after.
      if (role === 'master' || role === 'candidate') return `waiting for ${n} to hand over`;
    }
    if (this.role === 'master') {
      // A copy this one does not contain holds writes made elsewhere (the
      // other side of a split): it is merged in, in a new term.
      for (const n of up) {
        const p = this.views.get(n)?.position;
        if (p && !contains(this.position, p)) return `${n} holds writes this copy lacks`;
      }
    }
    return null;
  }

  /**
   * Step 2 of the handshake: every member asked again, now. Refused when a
   * member above this one answers, or any member answers that it is a
   * candidate or master, or runs another list. Otherwise the members that
   * answered, to merge their copies.
   * @param {string[]} members
   * @param {string} self
   * @returns {Promise<{ reason: string|null, peers: Peer[], positions: StorePosition[] }>}
   */
  async _confirm(members, self) {
    const peers = configuredPeers(this.getConfig());
    const others = members.filter(n => n !== self);
    const linked = others.map(n => ({ name: n, peer: peers.find(p => p.name === this.views.get(n)?.peer) || null }));
    const answers = await Promise.all(linked.map(m => (m.peer ? askMember(m.peer, { request: this.request }) : Promise.resolve(null))));
    /** @type {Peer[]} */
    const reached = [];
    /** @type {StorePosition[]} */
    const positions = [];
    const rank = members.indexOf(self);
    for (let i = 0; i < linked.length; i++) {
      const a = answers[i];
      const { name, peer } = linked[i];
      if (!a || !peer) continue;
      if (a.cluster === false) return { reason: `${name} runs a version without master and backups; update it`, peers: [], positions: [] };
      if (members.indexOf(name) < rank) return { reason: `${name} is up again`, peers: [], positions: [] };
      const role = roleOf(a.role);
      if (role === 'master' || role === 'candidate') return { reason: `waiting for ${name} to hand over`, peers: [], positions: [] };
      if (a.members && JSON.stringify(namesOf(a.members)) !== JSON.stringify(members)) {
        return { reason: `${name} runs with another member list; set the same list, in the same order, on every machine`, peers: [], positions: [] };
      }
      reached.push(peer);
      const p = positionOf(a.position);
      if (p) positions.push(p);
    }
    return { reason: null, peers: reached, positions };
  }

  /**
   * A backup keeps its copy level with the master's.
   * @param {string} master
   */
  async _follow(master) {
    const v = this.views.get(master);
    // Only from a master answering as one: a member first in line that has
    // not taken over yet holds an older copy, and the one here is among those
    // it is about to merge. A master took every copy in when it took over,
    // so whatever it holds now is the one to keep.
    if (!v || v.state !== 'up' || v.role !== 'master' || !v.position || !v.peer) return;
    if (samePosition(v.position, this.position)) return;
    // A copy here that the master's does not contain holds writes it lacks:
    // kept, for the master to merge in (it steps down for it, _conflict).
    if (!contains(v.position, this.position)) {
      this.lastError = `this copy holds writes ${safeLine(master, 64)} lacks; it merges them in at its next round`;
      return;
    }
    const peer = configuredPeers(this.getConfig()).find(p => p.name === v.peer);
    if (!peer) return;
    try {
      this.position = await this.store.replaceWith(await fetchSnapshot(peer, { request: this.request }));
    } catch (/** @type {any} */ err) {
      this.lastError = `could not copy the account store from ${safeLine(master, 64)}: ${safeLine(err?.message || String(err), 160)}`;
    }
  }

  /**
   * Stop answering as master. The fence is cleared first, while checks of
   * this machine still say master, so nobody takes its copy before the last
   * write here has landed or been refused. Until then isMaster() is already
   * false: this server takes no new store call.
   * @param {string} why
   * @param {ClusterRole} next
   */
  async _resign(why, next) {
    this._resigning = true;
    try {
      this.position = await this.store.resign();
    } catch (/** @type {any} */ err) {
      // The fence could not be cleared: say master no longer anyway (no new
      // call is taken), and try again at the next step-down.
      this.lastError = `could not clear the account store's write fence: ${safeLine(err?.message || String(err), 160)}`;
    } finally {
      this._resigning = false;
    }
    this._setRole(next, why);
  }

  /** First in line, not taking over yet: nobody is master from here. @param {string} why */
  _hold(why) {
    this.lastError = why;
    this.election = { master: null, reason: why };
    if (this.role !== 'backup') this._setRole('backup', null);
  }

  /**
   * @param {ClusterRole} role
   * @param {string|null} why
   */
  _setRole(role, why) {
    const was = this.role;
    this.role = role;
    if (was === 'master' && role !== 'master') this.log(`[TeamClaude] Account store: this machine stops answering as master${why ? ` (${why})` : ''}`);
    if (role === 'master' && was !== 'master') this.log(`[TeamClaude] Account store: this machine is now the master (term ${this.position.term})`);
  }

  /**
   * This machine's copy of the store, for a member taking over or a backup
   * keeping level; null when this machine is not a member.
   * @returns {Promise<any>}
   */
  async snapshot() {
    const setting = this.setting();
    if (!setting || !setting.members.includes(setting.self)) return null;
    return this.store.snapshot();
  }

  /**
   * What /teamclaude/sync-cluster answers to a check, and what the
   * dashboard shows.
   */
  status() {
    const setting = this.setting();
    if (!setting) return { cluster: true, name: instanceName(this.getConfig()), role: /** @type {ClusterRole} */ ('off'), members: null, master: null, sees: [], position: this.position };
    const { members, self } = setting;
    // What another member takes as a witness (elect): only a member whose
    // last check answered. One inside its grace period may already be gone.
    const sees = members.filter(n => n === self || (this.views.get(n)?.state === 'up' && this.views.get(n)?.misses === 0));
    return {
      cluster: true,
      name: self,
      role: this.role,
      members,
      master: this.election.master,
      reason: this.election.reason,
      sees,
      position: this.position,
      lastCheckAt: this.lastCheckAt,
      error: this.lastError,
      memberStates: members.map(n => ({ name: n, self: n === self, state: n === self ? 'up' : this.views.get(n)?.state ?? 'unknown', role: n === self ? this.role : this.views.get(n)?.role ?? null })),
    };
  }
}
