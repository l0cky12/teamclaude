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

/** Run a join from `self`, which has just linked `joined` both ways. */
async function join(w, self, joined) {
  const added = [];
  const out = await joinPeerMesh({
    self: w.peer(self),
    ownPeers: w.machines[self].list.map(p => ({ ...p })),
    joined: w.peer(joined),
    addLocal: async (entries) => { added.push(...entries); w.machines[self].list.push(...entries); },
    readList: w.readList,
    test: w.test,
    request: w.request,
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
  assert.deepEqual(out.skipped, [
    { from: 'desk', to: 'nas', error: 'nas is offline from desk' },
    { from: 'nas', to: 'desk', error: 'could not reach nas' },
  ]);
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

test('a joined instance listing too many instances is refused before any is visited', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `m${i}`);
  const w = world({ hub: [...many, 'desk'], desk: ['hub'], ...Object.fromEntries(many.map(n => [n, []])) });
  const out = await join(w, 'desk', 'hub');
  assert.deepEqual(out.linked, []);
  assert.match(out.skipped[0].error, /more than 32 instances/);
  assert.deepEqual(w.calls, [['read', 'hub']]);
});
