import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contains, createSyncStore, isNewerPosition, mergeRows, samePosition, SyncStoreError } from '../src/sync-store.js';
import { ClusterMonitor, elect, parseMembers, DOWN_AFTER_MISSES } from '../src/sync-cluster.js';
import { accountSyncMode, createSyncTransport, storeTarget } from '../src/instance-sync.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// A master and backups for the account store (sync-cluster.js). The election
// is a pure function over what this machine has heard, so most of it is
// pinned directly. The scenarios then run three members — each with a real
// store file and its own ClusterMonitor — over a simulated network, so a
// member can be taken down, cut off from one other member only, and brought
// back, and each round is driven by hand: no timers, no sleeps.

const T0 = 1_700_000_000_000;

/** @param {Partial<import('../src/sync-cluster.js').MemberView>} v */
const view = (v) => ({ state: 'up', misses: 0, cluster: true, peer: 'p', role: null, sees: [], members: null, position: null, ...v });

test('a member list is two or more names an instance can have, each once', () => {
  assert.deepEqual(parseMembers([' server ', 'desk']), ['server', 'desk']);
  assert.equal(parseMembers(['server']), null);
  assert.equal(parseMembers(['server', 'server']), null);
  assert.equal(parseMembers(['server', 'no spaces']), null);
  assert.equal(parseMembers(['server', 3]), null);
  assert.equal(parseMembers('server,desk'), null);
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'cluster', members: ['a', 'b'] } }), { mode: 'cluster', members: ['a', 'b'] });
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'cluster', members: ['a'] } }), { mode: 'off' });
});

test('the master is the first member that is up, walking the list from the top', () => {
  const members = ['a', 'b', 'c'];
  const at = (/** @type {Record<string, any>} */ views, self = 'c') => elect({ members, self, views: new Map(Object.entries(views)) });

  // The first one up wins; this machine wins when everything above it is down.
  assert.deepEqual(at({ a: view({}), b: view({}) }), { master: 'a', reason: null });
  assert.deepEqual(at({ a: view({ state: 'down' }), b: view({}) }), { master: 'b', reason: null });
  assert.deepEqual(at({ a: view({ state: 'down' }), b: view({ state: 'down' }) }), { master: 'c', reason: null });
  assert.deepEqual(at({}, 'a'), { master: 'a', reason: null });

  // Not heard from yet: nobody, for now. Not a linked instance: nobody, ever.
  assert.match(at({ a: view({ state: 'unknown' }), b: view({}) }).reason, /waiting to hear from a/);
  assert.equal(at({ a: view({ state: 'unknown' }), b: view({}) }).master, null);
  assert.match(at({ a: view({ state: 'unplaced' }), b: view({}) }).reason, /a is not a linked instance/);
  assert.match(at({ b: view({}) }).reason, /a is not a linked instance/);

  // Up but too old to take part: nobody rather than a master that cannot answer.
  assert.match(at({ a: view({ cluster: false }), b: view({}) }).reason, /a runs a version without/);

  // Down from here, but a member that answers still reaches it: the fault is
  // between this machine and it, so nobody takes over.
  const cut = at({ a: view({ state: 'down' }), b: view({ sees: ['a', 'b'] }) });
  assert.equal(cut.master, null);
  assert.match(cut.reason, /a does not answer this machine, but b still reaches it/);

  // A plain follower, in no list, walks the same list.
  assert.deepEqual(elect({ members, self: 'x', views: new Map([['a', view({ state: 'down' })], ['b', view({})], ['c', view({})]]) }), { master: 'b', reason: null });
  assert.deepEqual(elect({ members, self: 'x', views: new Map([['a', view({ state: 'down' })], ['b', view({ state: 'down' })], ['c', view({ state: 'down' })]]) }), { master: null, reason: 'no member is up' });
});

test('the store counts its writes, hands over a copy, and starts a term as master', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  let clock = T0;
  try {
    const one = createSyncStore({ path: join(dir, 'one.json'), now: () => clock });
    const two = createSyncStore({ path: join(dir, 'two.json'), now: () => clock });
    assert.deepEqual(await one.position(), { term: 0, rev: 0, owner: null, lineage: [] });

    const blob = JSON.stringify({ v: 1, provider: 'grok', name: 'g', userId: 'u1', accessToken: 'at', refreshToken: 'rt', expiresAt: T0 + 3600_000 });
    const row = await one.call('POST', 'User/Credential', { Key: 'teamrouter.grok.u1', Data: blob });
    const id = row.User_Credential__;
    await one.call('POST', `User/Credential/${id}:lock`, { timeout: 30 });
    assert.deepEqual(await one.position(), { term: 0, rev: 2, owner: null, lineage: [] }, 'a create and a lock are two writes');

    // The copy keeps the position it was taken at.
    const snap = await one.snapshot();
    assert.deepEqual(await two.replaceWith(snap), { term: 0, rev: 2, owner: null, lineage: [] });
    assert.deepEqual(await two.position(), { term: 0, rev: 2, owner: null, lineage: [] });
    assert.equal((await two.call('GET', `User/Credential/${id}`)).Data, blob);

    // Taking over: a new term, every token row a seed, and a lock the copy
    // held stamped as taken now, so it holds a full lease from here.
    clock += 600_000;
    // The copy it started from is part of the new term's lineage.
    assert.deepEqual(await two.promote(1, 'two'), { term: 1, rev: 3, owner: 'two', lineage: [{ term: 0, owner: null, rev: 2 }] });
    assert.equal(contains(await two.position(), await one.position()), true);
    assert.equal(contains(await one.position(), await two.position()), false);
    const after = JSON.parse(await readFile(join(dir, 'two.json'), 'utf8'));
    assert.equal(JSON.parse(after.rows[0].data).seeded, true);
    assert.equal(after.rows[0].lockedAt, clock);
    await assert.rejects(two.call('POST', `User/Credential/${id}:lock`, { timeout: 30 }), (e) => e instanceof SyncStoreError && e.token === 'error_credential_locked');

    assert.equal(isNewerPosition({ term: 1, rev: 0 }, { term: 0, rev: 9 }), true);
    assert.equal(isNewerPosition({ term: 1, rev: 3 }, { term: 1, rev: 3 }), false);

    // A copy that is not a store, and a file here that does not read, are refused; nothing is written.
    await assert.rejects(two.replaceWith({ v: 9, rows: [] }), (e) => e instanceof SyncStoreError && e.token === 'error_store_unreadable');
    await writeFile(join(dir, 'one.json'), 'not json');
    await assert.rejects(one.replaceWith(snap), (e) => e instanceof SyncStoreError && e.token === 'error_store_unreadable');
    assert.equal(await readFile(join(dir, 'one.json'), 'utf8'), 'not json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the store answers only while the file names this machine as its leader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const store = createSyncStore({ path: join(dir, 'a.json'), now: () => T0, leaderName: () => 'a' });
    const refused = (e) => e instanceof SyncStoreError && e.token === 'error_not_host';
    const post = (key) => store.call('POST', 'User/Credential', { Key: key, Data: '{}' });
    // Never led: every call is refused, reads too.
    await assert.rejects(post('teamrouter.x'), refused);
    await assert.rejects(store.call('GET', 'User/Credential'), refused);
    // Led from a takeover.
    await store.promote(1, 'a');
    await post('teamrouter.x');
    // Stepped down: refused again, and the rows stay for the next master.
    await store.resign();
    await assert.rejects(post('teamrouter.y'), refused);
    assert.deepEqual((await store.snapshot()).rows.map(r => r.key), ['teamrouter.x']);
    // A copy taken from another member never leads.
    await store.promote(2, 'a');
    await store.replaceWith({ v: 1, term: 3, rev: 1, owner: 'b', leader: 'a', rows: [] });
    await assert.rejects(post('teamrouter.z'), refused);
    // Another name in the file is not this machine.
    const other = createSyncStore({ path: join(dir, 'a.json'), now: () => T0, leaderName: () => 'b' });
    await store.promote(4, 'a');
    await assert.rejects(other.call('GET', 'User/Credential'), refused);
    // No fence: a store one machine keeps alone answers whatever the file says.
    await createSyncStore({ path: join(dir, 'a.json'), now: () => T0 }).call('GET', 'User/Credential');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('copies merged at a takeover keep every account, the later token winning', () => {
  const tok = (exp) => JSON.stringify({ v: 1, accessToken: 'a', refreshToken: 'r', expiresAt: exp });
  const row = (key, data, updated) => ({ id: 'id-' + key + updated, key, data, updated, lockedAt: null, lease: null });
  const merged = mergeRows([
    [row('k1', tok(100), 5), row('k2', tok(100), 5)],
    [row('k1', tok(200), 1), row('k3', tok(50), 1)],
    [row('k2', JSON.stringify({ _deleted: 'x' }), 9)],
  ]);
  const byKey = Object.fromEntries(merged.map(r => [r.key, r]));
  assert.deepEqual(Object.keys(byKey).sort(), ['k1', 'k2', 'k3']);
  assert.equal(JSON.parse(byKey.k1.data).expiresAt, 200, 'the later expiry, whatever was written last');
  assert.ok(JSON.parse(byKey.k2.data)._deleted, 'a token against a tombstone: the later write');
  assert.equal(samePosition({ term: 2, rev: 3, owner: 'a' }, { term: 2, rev: 3, owner: 'b' }), false);
});

// ---- Three members over a simulated network ---------------------------------

/**
 * Members named in `names`, each with its store in `dir` and links to all the
 * others under their own names. `cut` holds the links that fail, as "from>to".
 */
async function cluster(dir, names, { members = names, lists = {} } = {}) {
  let clock = T0;
  const cut = new Set();
  /** Runs before each request is delivered, as (from, to, op). */
  let hook = async (_from, _to, _op) => {};
  /** @type {Record<string, { monitor: ClusterMonitor, store: ReturnType<typeof createSyncStore>, config: any, logs: string[], changes: number }>} */
  const m = {};
  for (const name of names) {
    const config = {
      instanceName: name,
      proxy: { apiKey: `tc-${name}` },
      accountSync: { mode: 'cluster', members: lists[name] || members },
      peers: names.filter(n => n !== name).map(n => ({ name: n, url: `http://${n}.test`, apiKey: `tc-${n}` })),
    };
    const store = createSyncStore({ path: join(dir, `${name}.json`), now: () => clock, leaderName: () => name });
    const logs = [];
    const node = { store, config, logs, changes: 0, monitor: /** @type {any} */ (null) };
    // A request reaches the member the link's address names, unless the link is cut.
    const request = async (peer, rest, opts) => {
      const to = new URL(peer.url).hostname.replace(/\.test$/, '');
      const body = JSON.parse(opts.body.toString());
      await hook(name, to, body.op);
      if (cut.has(`${name}>${to}`) || !m[to]) throw new Error('connect ECONNREFUSED');
      assert.equal(rest, 'sync-cluster');
      assert.equal(peer.apiKey, `tc-${to}`, 'each link carries that machine\'s key');
      const target = m[to].monitor;
      const payload = body.op === 'status' ? { ok: true, ...target.status() } : { ok: true, store: await target.snapshot() };
      return { status: 200, body: Buffer.from(JSON.stringify(payload)) };
    };
    node.monitor = new ClusterMonitor({ getConfig: () => config, store, request, log: (l) => logs.push(l), now: () => clock, onChange: () => { node.changes++; } });
    node.restart = () => {
      // A process that died without stepping down: its file still names it.
      node.monitor = new ClusterMonitor({ getConfig: () => config, store, request, log: (l) => logs.push(l), now: () => clock, onChange: () => { node.changes++; } });
    };
    m[name] = node;
  }
  const round = async (who = names) => { for (const n of who) await m[n].monitor.tick(); };
  const roles = () => Object.fromEntries(names.map(n => [n, m[n].monitor.role]));
  const masters = () => Object.fromEntries(names.map(n => [n, m[n].monitor.election.master]));
  // Whoever answers as master, among the members that can reach each other.
  const answering = () => names.filter(n => m[n].monitor.isMaster());
  return { m, cut, round, roles, masters, answering, onRequest: (fn) => { hook = fn; }, tick: (ms) => { clock += ms; } };
}

/** A row on whichever store answers as master, the way a follower's sync writes one. */
async function write(store, key) {
  const data = JSON.stringify({ v: 1, provider: 'anthropic', name: key, accountUuid: key, accessToken: 'at-' + key, refreshToken: 'rt-' + key, expiresAt: T0 + 3600_000 });
  return store.call('POST', 'User/Credential', { Key: `teamrouter.anthropic.${key}.org`, Data: data });
}

const keys = async (store) => (await store.snapshot()).rows.map(r => r.key).sort();

test('with every member up, the first is master and the backups keep its copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk', 'laptop']);
    await c.round();
    // The first round hears from everyone; server, first in line, took over.
    assert.deepEqual(c.roles(), { server: 'master', desk: 'backup', laptop: 'backup' });
    assert.deepEqual(c.masters(), { server: 'server', desk: 'server', laptop: 'server' });
    assert.equal(c.m.server.monitor.isMaster(), true);
    assert.equal(c.m.desk.monitor.isMaster(), false);
    assert.equal(c.m.desk.monitor.masterPeer()?.name, 'server');

    await write(c.m.server.store, 'one');
    await c.round();
    assert.deepEqual(await keys(c.m.desk.store), ['teamrouter.anthropic.one.org']);
    assert.deepEqual(await keys(c.m.laptop.store), ['teamrouter.anthropic.one.org']);
    assert.deepEqual(await c.m.desk.store.position(), await c.m.server.store.position());

    // The transport follows the election: the master's own store, or the master's.
    const local = storeTarget(c.m.server.config, c.m.server.monitor);
    assert.equal(local.local, true);
    const remote = storeTarget(c.m.desk.config, c.m.desk.monitor);
    assert.deepEqual([remote.local, remote.master, remote.peer?.name], [false, 'server', 'server']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the master goes down: the next in line takes over after three missed checks, with the copy it kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk', 'laptop']);
    await c.round();
    await write(c.m.server.store, 'one');
    await c.round();
    const before = await c.m.server.store.position();

    // server stops answering anyone.
    c.cut.add('desk>server').add('laptop>server');
    for (let i = 1; i < DOWN_AFTER_MISSES; i++) {
      await c.round(['desk', 'laptop']);
      assert.equal(c.m.desk.monitor.role, 'backup', `still a backup after ${i} missed check(s)`);
      assert.equal(c.m.desk.monitor.election.master, 'server');
    }
    await c.round(['desk', 'laptop']);
    // desk went first this round, so laptop sees it as master at once.
    assert.equal(c.m.desk.monitor.role, 'master');
    assert.equal(c.m.laptop.monitor.election.master, 'desk');
    const term = await c.m.desk.store.position();
    assert.equal(term.term, before.term + 1, 'a new term');
    assert.deepEqual(await keys(c.m.desk.store), ['teamrouter.anthropic.one.org'], 'the copy it kept');
    assert.equal(JSON.parse((await c.m.desk.store.snapshot()).rows[0].data).seeded, true, 'its rows are seeds');
    assert.ok(c.m.desk.logs.some(l => /this machine is now the master/.test(l)));
    assert.ok(c.m.laptop.changes >= 2, 'the sync was told the master moved');

    // Writes now go to desk, and laptop keeps desk's copy.
    await write(c.m.desk.store, 'two');
    await c.round(['desk', 'laptop']);
    assert.deepEqual(await keys(c.m.laptop.store), ['teamrouter.anthropic.one.org', 'teamrouter.anthropic.two.org']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a member cut off from the master, while another still reaches it, does not take over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk', 'laptop']);
    await c.round();
    c.cut.add('desk>server');
    for (let i = 0; i < DOWN_AFTER_MISSES + 1; i++) await c.round();
    assert.deepEqual(c.roles(), { server: 'master', desk: 'backup', laptop: 'backup' });
    assert.equal(c.m.desk.monitor.election.master, null);
    assert.match(c.m.desk.monitor.election.reason, /server does not answer this machine, but laptop still reaches it/);
    // With no master, desk's sync has nowhere to renew: it holds.
    assert.equal(storeTarget(c.m.desk.config, c.m.desk.monitor).peer, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the master comes back: the acting master steps down, and it takes over the newer copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk', 'laptop']);
    await c.round();
    await write(c.m.server.store, 'one');
    await c.round();
    c.cut.add('desk>server').add('laptop>server').add('server>desk').add('server>laptop');
    for (let i = 0; i < DOWN_AFTER_MISSES; i++) await c.round(['desk', 'laptop']);
    assert.equal(c.m.desk.monitor.role, 'master');
    await write(c.m.desk.store, 'while-away');
    await c.round(['desk', 'laptop']);
    const kept = await c.m.desk.store.position();

    // server is back. It does not answer as master while desk still does.
    c.cut.clear();
    await c.round(['server']);
    assert.equal(c.m.server.monitor.role, 'backup');
    assert.match(c.m.server.monitor.election.reason, /waiting for desk to hand over/);
    // desk sees server and steps down; its copy is left as it is.
    await c.round(['desk']);
    assert.equal(c.m.desk.monitor.role, 'backup');
    assert.deepEqual(await c.m.desk.store.position(), kept, 'the newer copy is not overwritten with the old one');
    // server takes desk's copy, in a term above desk's.
    await c.round(['server', 'desk', 'laptop']);
    assert.deepEqual(c.roles(), { server: 'master', desk: 'backup', laptop: 'backup' });
    assert.deepEqual(await keys(c.m.server.store), ['teamrouter.anthropic.one.org', 'teamrouter.anthropic.while-away.org']);
    assert.equal((await c.m.server.store.position()).term, kept.term + 1);
    await c.round();
    assert.deepEqual(await c.m.laptop.store.position(), await c.m.server.store.position());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('after a split, both masters step down and the one first in line merges both copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    // Two members, cut apart both ways: each side elects itself, and both
    // reach the same term and rev with different rows.
    c.cut.add('desk>server').add('server>desk');
    for (let i = 0; i < DOWN_AFTER_MISSES; i++) await c.round();
    assert.deepEqual(c.roles(), { server: 'master', desk: 'master' });
    await write(c.m.server.store, 'only-server');
    await write(c.m.desk.store, 'only-desk');

    // Healed. Each sees the other answering as master and steps down.
    c.cut.clear();
    await c.round();
    assert.ok(c.answering().length <= 1, JSON.stringify(c.roles()));
    for (let i = 0; i < 4; i++) await c.round();
    assert.deepEqual(c.roles(), { server: 'master', desk: 'backup' });
    assert.deepEqual(await keys(c.m.server.store), ['teamrouter.anthropic.only-desk.org', 'teamrouter.anthropic.only-server.org']);
    assert.ok(samePosition(await c.m.desk.store.position(), await c.m.server.store.position()), 'desk holds the merged copy');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a copy with the master\'s counters but from a term another member started is merged in, not ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    const master = await c.m.server.store.position();
    // desk holds a copy at the master's very term and rev, started by desk,
    // with an account the master's copy lacks.
    const extra = { id: 'ucr-x', key: 'teamrouter.anthropic.desk-only.org', data: JSON.stringify({ v: 1, accessToken: 'a', refreshToken: 'r', expiresAt: T0 }), updated: T0, lockedAt: null };
    await c.m.desk.store.replaceWith({ v: 1, term: master.term, rev: master.rev, owner: 'desk', rows: [extra] });
    const theirs = await c.m.desk.store.position();
    assert.deepEqual([theirs.term, theirs.rev], [master.term, master.rev], 'equal counters');
    assert.equal(samePosition(theirs, master), false, 'but not the same copy');
    for (let i = 0; i < 3; i++) await c.round();
    assert.deepEqual(c.roles(), { server: 'master', desk: 'backup' });
    assert.deepEqual(await keys(c.m.server.store), ['teamrouter.anthropic.desk-only.org']);
    assert.ok((await c.m.server.store.position()).term > master.term);
    assert.ok(samePosition(await c.m.desk.store.position(), await c.m.server.store.position()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a master that restarts as its backup gives up on it: the backup backs off at its fresh check', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    c.cut.add('desk>server').add('server>desk');
    for (let i = 1; i < DOWN_AFTER_MISSES; i++) await c.round(['desk']);
    // In desk's third round, its check of server fails; server is back
    // (restarted) by the time desk checks again as a candidate.
    c.m.server.restart();
    let asked = 0;
    c.onRequest(async (from, to) => {
      if (from === 'desk' && to === 'server' && ++asked === 2) c.cut.clear();
    });
    await c.round(['desk']);
    assert.equal(c.m.desk.monitor.role, 'backup');
    assert.match(c.m.desk.monitor.election.reason, /server is up again/);
    assert.deepEqual(c.answering(), []);
    await c.round(['server', 'desk']);
    assert.deepEqual(c.answering(), ['server']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a master that restarts while its backup is taking over waits for the candidate, and never both answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    await write(c.m.server.store, 'one');
    await c.round();
    c.cut.add('desk>server').add('server>desk');
    for (let i = 1; i < DOWN_AFTER_MISSES; i++) await c.round(['desk']);
    // desk passes its fresh check (server still down) and is merging. Right
    // then server restarts, the network is back, and server runs a round.
    c.m.server.restart();
    const promote = c.m.desk.store.promote;
    let seen = null;
    c.m.desk.store.promote = async (...args) => {
      c.cut.clear();
      await c.m.server.monitor.tick();
      seen = c.m.server.monitor.role;
      return promote(...args);
    };
    await c.round(['desk']);
    c.m.desk.store.promote = promote;
    assert.equal(seen, 'backup', 'server saw a candidate and did not take over');
    assert.match(c.m.server.monitor.election.reason, /waiting for desk to hand over/);
    assert.deepEqual(c.answering(), ['desk']);
    // From here, rounds in any order: desk steps down for server, which
    // takes over with desk's copy; never two at once.
    for (const order of [['desk', 'server'], ['server', 'desk'], ['desk', 'server'], ['server', 'desk']]) {
      for (const n of order) {
        await c.round([n]);
        assert.ok(c.answering().length <= 1, JSON.stringify(c.roles()));
      }
    }
    assert.deepEqual(c.answering(), ['server']);
    assert.deepEqual(await keys(c.m.server.store), ['teamrouter.anthropic.one.org']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a renewal under way when the master steps down cannot write to the copy the next master takes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    c.cut.add('desk>server').add('server>desk');
    for (let i = 0; i < DOWN_AFTER_MISSES; i++) await c.round(['desk']);
    assert.equal(c.m.desk.monitor.isMaster(), true);
    // desk's own sync is pinned to its local store, as a renewal would be.
    const transport = createSyncTransport({ getConfig: () => c.m.desk.config, store: c.m.desk.store, cluster: c.m.desk.monitor });
    transport.pin(c.m.desk.config);
    const row = await transport.api('POST', 'User/Credential', { Key: 'teamrouter.anthropic.renewing.org', Data: '{}' });
    await transport.api('POST', `User/Credential/${row.User_Credential__}:lock`, { timeout: 30 });
    // server is back; desk steps down. The renewal's PATCH arrives after.
    c.cut.clear();
    await c.round(['desk']);
    assert.equal(c.m.desk.monitor.isMaster(), false);
    await assert.rejects(transport.api('PATCH', `User/Credential/${row.User_Credential__}`, { Data: '{"late":true}' }), (e) => e.token === 'error_not_host');
    await assert.rejects(transport.api('POST', 'User/Credential', { Key: 'teamrouter.x', Data: '{}' }), (e) => e.token === 'error_not_host');
    // server, master all along on its side, steps down for desk's newer
    // term, then takes over with desk's copy merged in.
    for (let i = 0; i < 3; i++) await c.round(['server', 'desk']);
    assert.deepEqual(c.answering(), ['server']);
    const taken = (await c.m.server.store.snapshot()).rows.find(r => r.key === 'teamrouter.anthropic.renewing.org');
    assert.equal(taken.data, '{}', 'the late write never reached the copy');
    assert.equal(taken.lockedAt, T0, 'and its lock holds a full lease on the new master');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a sitting master steps down when a member\'s list, or its own, changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    await c.round();
    assert.equal(c.m.server.monitor.role, 'master');
    c.m.desk.config.accountSync.members = ['server', 'desk', 'attic'];
    await c.round(['desk', 'server']);
    assert.equal(c.m.server.monitor.role, 'backup');
    assert.match(c.m.server.monitor.election.reason, /desk runs with another member list/);
    assert.ok(c.m.server.logs.some(l => /stops answering as master/.test(l)));

    // Lists level again: server takes over again. Then its own list changes.
    c.m.desk.config.accountSync.members = ['server', 'desk'];
    await c.round(['desk', 'server']);
    assert.equal(c.m.server.monitor.role, 'master');
    c.m.server.config.accountSync.members = ['server', 'desk', 'attic'];
    c.m.server.config.peers.push({ name: 'attic', url: 'http://attic.test', apiKey: 'tc-attic' });
    await c.round(['server']);
    assert.notEqual(c.m.server.monitor.role, 'master');
    assert.ok(c.m.server.logs.some(l => /stops answering as master \(the member list changed\)/.test(l)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('members running different lists never take over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk'], { lists: { desk: ['desk', 'server'] } });
    await c.round();
    await c.round();
    // Each is first on its own list; each sees the other with another list.
    assert.deepEqual(c.roles(), { server: 'backup', desk: 'backup' });
    assert.match(c.m.server.monitor.election.reason, /desk runs with another member list/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a linked instance listed under another name is placed by the name it answers with', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-cluster-'));
  try {
    const c = await cluster(dir, ['server', 'desk']);
    // desk lists server as "home"; the member list says "server".
    c.m.desk.config.peers = [{ name: 'home', url: 'http://server.test', apiKey: 'tc-server' }];
    await c.round();
    assert.equal(c.m.desk.monitor.election.master, 'server');
    assert.equal(c.m.desk.monitor.masterPeer()?.name, 'home');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a one-shot command finds the master by asking the members, this machine through its own proxy', async () => {
  const asked = [];
  const config = {
    instanceName: 'desk',
    proxy: { port: 4100, apiKey: 'tc-desk' },
    accountSync: { mode: 'cluster', members: ['server', 'desk'] },
    peers: [{ name: 'server', url: 'http://server.test', apiKey: 'tc-server' }],
  };
  const calls = [];
  const transport = createSyncTransport({
    getConfig: () => config,
    store: { call: async () => { calls.push('local'); return 'local'; } },
    request: async (peer, rest, opts) => {
      const body = JSON.parse(opts.body.toString());
      asked.push(`${peer.url} ${rest} ${body.op || body.method}`);
      if (rest === 'sync-cluster') {
        // server is down; desk's own server says it is the master.
        if (peer.url === 'http://server.test') throw new Error('down');
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, role: 'master' })) };
      }
      return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, result: 'remote' })) };
    },
  });
  assert.equal(await transport.api('GET', 'User/Credential'), 'local');
  assert.deepEqual(asked, ['http://server.test sync-cluster status', 'http://127.0.0.1:4100 sync-cluster status']);
  assert.equal(transport.where(), 'the account store on this machine (master)');
  assert.deepEqual(calls, ['local']);
});

test('the check route answers only this machine\'s proxy key, and hands a copy only from a member', async () => {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  let member = true;
  const hooks = { syncCluster: { status: () => ({ cluster: true, name: 'server', role: 'master' }), snapshot: async () => (member ? { v: 1, term: 1, rev: 2, rows: [] } : null) } };
  const server = createProxyServer(new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk-demo-1' }], 0.98),
    { proxy: { port: 3, apiKey: 'tc-host', clientKeys: [{ name: 'laptop', key: 'tc-client' }] } }, hooks);
  const port = await listen(server);
  const ask = (key, op) => fetch(`http://127.0.0.1:${port}/teamclaude/sync-cluster`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify({ op }),
  });
  try {
    assert.equal((await ask(null, 'status')).status, 401, 'loopback without a key');
    assert.equal((await ask('wrong', 'status')).status, 401);
    assert.equal((await ask('tc-client', 'status')).status, 403, 'a client key');
    const ok = await ask('tc-host', 'status');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).role, 'master');
    assert.deepEqual((await (await ask('tc-host', 'snapshot')).json()).store, { v: 1, term: 1, rev: 2, rows: [] });
    member = false;
    assert.equal((await ask('tc-host', 'snapshot')).status, 404);
    assert.equal((await ask('tc-host', 'nope')).status, 400);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
