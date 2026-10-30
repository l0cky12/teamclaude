import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPeerMesh } from '../src/peers.js';

// joinPeerMesh against a pretend set of machines: each has a key, an address
// and the list of instances it links to. readList, test and request stand in
// for the HTTP calls, so a test says which machines are up and reads back
// what each one lists afterwards.

/**
 * @param {Record<string, string[]>} links  machine name → the names it lists
 * @param {{ down?: string[], old?: string[], aliases?: Record<string, Record<string, string>> }} [opts]
 *   `down`: machines that answer nothing; `old`: ones without peer-links/peers;
 *   `aliases`: owner → { listed name → name it is listed under there }
 */
function world(links, { down = [], old = [], aliases = {} } = {}) {
  const machines = {};
  for (const name of Object.keys(links)) machines[name] = { name, url: `http://${name}.test:3456`, apiKey: `${name}-key`, list: [] };
  for (const [owner, names] of Object.entries(links)) {
    machines[owner].list = names.map((n) => ({ ...peerOf(machines[n]), name: aliases[owner]?.[n] ?? n }));
  }
  const byKey = (key) => Object.values(machines).find(m => m.apiKey === key);
  const calls = [];
  return {
    machines,
    calls,
    peer: (name) => peerOf(machines[name]),
    lists: (name) => machines[name].list.map(p => p.name),
    readList: async (peer) => {
      const m = byKey(peer.apiKey);
      calls.push(['read', m.name]);
      if (down.includes(m.name) || old.includes(m.name)) return null;
      return m.list.map(p => ({ ...p }));
    },
    test: async (peer) => ({ state: down.includes(byKey(peer.apiKey).name) ? 'offline' : 'online', linkable: true }),
    request: async (from, rest, { body }) => {
      const m = byKey(from.apiKey);
      calls.push([rest, m.name]);
      if (down.includes(m.name)) throw new Error('connect ECONNREFUSED');
      const json = JSON.parse(body.toString('utf8'));
      if (rest === 'peer-links/test') {
        const state = down.includes(byKey(json.apiKey).name) ? 'offline' : 'online';
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, state })) };
      }
      if (rest === 'peer-links/add') {
        m.list.push(json);
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true })) };
      }
      return { status: 404, body: Buffer.from('{}') };
    },
  };
}

function peerOf(m) {
  return { name: m.name, url: m.url, apiKey: m.apiKey };
}

/**
 * Run a join from `self`, which has just linked `joined` both ways. `refuse`
 * maps an entry name to the error this machine's save gives it.
 */
async function join(w, self, joined, { refuse = {}, expiry } = {}) {
  const added = [];
  const out = await joinPeerMesh({
    self: w.peer(self),
    ownPeers: w.machines[self].list.map(p => ({ ...p })),
    joined: w.peer(joined),
    addLocal: async (entries) => entries.map((e) => {
      if (refuse[e.name]) return refuse[e.name];
      added.push(e);
      w.machines[self].list.push(e);
      return null;
    }),
    readList: w.readList,
    test: w.test,
    request: w.request,
    expiry,
  });
  return { ...out, added };
}

test('linking desk to hub links desk and the server hub already lists, both ways', async () => {
  // hub ↔ server before; desk ↔ hub just now.
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'desk', to: 'server' }, { from: 'server', to: 'desk' }]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.added, [w.peer('server')], 'desk saves the server with its own key');
  assert.deepEqual(w.lists('desk'), ['hub', 'server']);
  assert.deepEqual(w.lists('server'), ['hub', 'desk']);
  assert.equal(w.machines.server.list[1].apiKey, 'desk-key');
});

test('two groups become one: every instance either side lists is linked across', async () => {
  // desk ↔ laptop and hub ↔ server before; desk ↔ hub just now.
  const w = world({ desk: ['laptop', 'hub'], laptop: ['desk'], hub: ['server', 'desk'], server: ['hub'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.skipped, []);
  for (const name of ['desk', 'laptop', 'hub', 'server']) {
    assert.deepEqual(w.lists(name).sort(), ['desk', 'laptop', 'hub', 'server'].filter(n => n !== name).sort(), name);
  }
  // Pairs already linked are not asked again.
  assert.equal(out.linked.length, 6);
});

test('an instance is known by its key, so one listed under another name is not linked twice', async () => {
  // hub lists desk as "workstation"; the server already lists desk as "ws".
  const w = world({ hub: ['server', 'desk'], server: ['hub', 'desk'], desk: ['hub'] }, { aliases: { hub: { desk: 'workstation' }, server: { desk: 'ws' } } });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'desk', to: 'server' }]);
  assert.deepEqual(w.lists('server'), ['hub', 'ws']);
});

test('a name another instance already has there gets a suffix', async () => {
  // The server lists some other machine as "desk" already.
  const w = world({ hub: ['server', 'desk'], server: ['hub', 'other'], desk: ['hub'], other: [] }, { aliases: { server: { other: 'desk' } } });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'desk', to: 'server' }, { from: 'server', to: 'desk-2' }]);
  assert.deepEqual(w.lists('server'), ['hub', 'desk', 'desk-2']);
  assert.equal(w.machines.server.list[2].apiKey, 'desk-key');
});

test('an instance that cannot be reached is reported, and the rest are still linked', async () => {
  const w = world({ hub: ['server', 'nas', 'desk'], server: ['hub', 'nas'], nas: ['hub', 'server'], desk: ['hub'] }, { down: ['nas'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'desk', to: 'server' }, { from: 'server', to: 'desk' }]);
  // nas is reported once for what it could not be asked, and once for desk's
  // own test of it.
  assert.deepEqual(out.skipped.map(s => [s.from, s.to]), [['nas', '*'], ['desk', 'nas']]);
  assert.match(out.skipped[0].error, /could not reach nas to read what it lists/);
  assert.equal(out.skipped[1].error, 'nas is offline from desk');
  assert.deepEqual(w.lists('desk'), ['hub', 'server']);
});

test('an instance that cannot reach the other side keeps its list as it was', async () => {
  // The server can be read from desk, but its own test of desk fails.
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] });
  const request = w.request;
  w.request = async (from, rest, opts) => rest === 'peer-links/test' && from.name === 'server'
    ? { status: 200, body: Buffer.from(JSON.stringify({ ok: true, state: 'offline' })) }
    : request(from, rest, opts);
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'desk', to: 'server' }]);
  assert.deepEqual(out.skipped, [{ from: 'server', to: 'desk', error: 'desk is offline from server' }]);
  assert.deepEqual(w.lists('server'), ['hub']);
});

test('a joined instance whose list cannot be read stops the join before anything is asked', async () => {
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] }, { old: ['hub'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, []);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].error, /could not read the instances hub lists/);
  assert.deepEqual(w.calls, [['read', 'hub']]);
});

test('nothing to do when the two groups are linked already', async () => {
  const w = world({ hub: ['server', 'desk'], server: ['hub', 'desk'], desk: ['hub', 'server'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out, { linked: [], skipped: [], added: [] });
  assert.ok(!w.calls.some(([step]) => step === 'peer-links/add'));
});

test('machines both sides list get their missing links to either side too', async () => {
  // desk and hub both list the server, but the server lists only hub.
  const w = world({ desk: ['hub', 'server'], hub: ['desk', 'server'], server: ['hub'] });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, [{ from: 'server', to: 'desk' }]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(w.lists('server'), ['hub', 'desk']);
});

test('two instances that share a proxy key are reported, not merged into one', async () => {
  const w = world({ hub: ['server', 'nas', 'desk'], server: ['hub'], nas: ['hub'], desk: ['hub'] });
  w.machines.nas.apiKey = 'server-key';
  w.machines.hub.list[1].apiKey = 'server-key';
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, []);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].from, 'server / nas');
  assert.match(out.skipped[0].error, /listed at http:\/\/server\.test:3456 and http:\/\/nas\.test:3456 with one proxy key/);
  assert.deepEqual(w.lists('desk'), ['hub']);
});

test('one that shares this machine\'s key stops the join, since this machine cannot be told apart', async () => {
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] });
  w.machines.server.apiKey = 'desk-key';
  w.machines.hub.list[0].apiKey = 'desk-key';
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, []);
  assert.match(out.skipped[0].error, /cannot be told whether that is one instance or several/);
  assert.ok(!w.calls.some(([step]) => step === 'peer-links/add'));
});

test('a link this machine could not save is reported, not counted as linked', async () => {
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] });
  const out = await join(w, 'desk', 'hub', { refuse: { server: 'an instance named "server" is already linked; remove it first to change it' } });
  assert.deepEqual(out.linked, [{ from: 'server', to: 'desk' }]);
  assert.deepEqual(out.skipped, [{ from: 'desk', to: 'server', error: 'an instance named "server" is already linked; remove it first to change it' }]);
});

test('a name the add routes would refuse is made into one they accept', async () => {
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] }, { aliases: { hub: { server: 'my server' } } });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.added.map(e => e.name), ['my-server']);
  assert.deepEqual(out.skipped, []);
});

test('out of time, the join answers with what it did and what it did not get to', async () => {
  // The server never answers its add; desk's own test of the server answers at once.
  const w = world({ hub: ['server', 'nas', 'desk'], server: ['hub', 'nas'], nas: ['hub', 'server'], desk: ['hub'] });
  let expire;
  const expiry = new Promise((resolve) => { expire = resolve; });
  const request = w.request;
  w.request = (from, rest, opts) => {
    if (from.name === 'server' && rest === 'peer-links/add') { expire(); return new Promise(() => {}); }
    return request(from, rest, opts);
  };
  const out = await join(w, 'desk', 'hub', { expiry });
  const skipped = Object.fromEntries(out.skipped.map(s => [`${s.from}>${s.to}`, s.error]));
  assert.match(skipped['server>desk'], /ran out of time waiting for server; it may have linked desk anyway/);
  // Every missing direction is in the answer once, as linked or as out of
  // time; which of the others finished before the server stalled depends on
  // nothing the test controls, so it only checks they add up.
  const linked = out.linked.map(l => `${l.from}>${l.to}`);
  assert.deepEqual([...linked, ...Object.keys(skipped)].sort(), ['desk>nas', 'desk>server', 'nas>desk', 'server>desk']);
  for (const [pair, error] of Object.entries(skipped)) assert.match(error, /ran out of time/, pair);
  // What desk tested in time is saved.
  assert.deepEqual(out.added.map(e => e.name), linked.filter(l => l.startsWith('desk>')).map(l => l.slice(5)));
});

test('a joined instance listing too many instances is refused before any is visited', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `m${i}`);
  const w = world({ hub: [...many, 'desk'], desk: ['hub'], ...Object.fromEntries(many.map(n => [n, []])) });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, []);
  assert.match(out.skipped[0].error, /more than 32 instances/);
  assert.deepEqual(w.calls, [['read', 'hub']]);
});

test('an add that already used up the time links nothing more, and says so', async () => {
  // The link back alone took past what a relayed reply allows.
  const w = world({ hub: ['server', 'desk'], server: ['hub'], desk: ['hub'] });
  const out = await joinPeerMesh({
    self: w.peer('desk'),
    ownPeers: w.machines.desk.list.map(p => ({ ...p })),
    joined: w.peer('hub'),
    addLocal: async (entries) => entries.map(() => null),
    readList: w.readList,
    test: w.test,
    request: w.request,
    startedAt: Date.now() - 60_000,
  });
  assert.deepEqual(out.linked, []);
  assert.match(out.skipped[0].error, /linking hub took all the time this request has/);
  assert.deepEqual(w.calls, [], 'nothing was asked');
});
