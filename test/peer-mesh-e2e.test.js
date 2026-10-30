import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { closedPort, spawnServer } from '../test-helpers/spawn-server.js';

// Four real proxies, each with its own config file, in two groups: desk and
// laptop linked to each other, hub and server linked to each other. Linking
// desk to hub from desk's dashboard, with a link back, joins the groups: each
// of the four then lists the other three and relays to them.

async function proxy(name) {
  const deadPort = await closedPort();
  return spawnServer({
    config: () => ({
      proxy: { apiKey: `tc-${name}-key` },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      autoUpdate: false,
      accounts: [{ name: `${name}@example.com`, type: 'apikey', apiKey: 'k1' }],
    }),
  });
}

const post = (p, path, body) => fetch(`http://127.0.0.1:${p.port}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': p.key },
  body: JSON.stringify(body),
});

/** Link `from` to `to` both ways, the way the dashboard's form does. */
async function link(from, to, extra = {}) {
  const res = await post(from, '/teamclaude/peer-links/add', {
    name: to.name, url: to.url, apiKey: to.key, linkBack: { name: from.name, url: from.url }, ...extra,
  });
  return res.json();
}

test('linking one machine of a group to one of another links every machine to every other', async () => {
  const names = ['desk', 'laptop', 'hub', 'server'];
  /** @type {Record<string, any>} */
  const p = {};
  try {
    for (const name of names) {
      const s = await proxy(name);
      p[name] = Object.assign(s, { name, key: `tc-${name}-key`, url: `http://127.0.0.1:${s.port}` });
    }
    const output = () => names.map(n => p[n].output()).join('');

    // The two groups, each linked the old way: no one else to join yet.
    assert.deepEqual((await link(p.desk, p.laptop)).mesh, { linked: [], skipped: [] }, output());
    assert.deepEqual((await link(p.hub, p.server)).mesh, { linked: [], skipped: [] }, output());

    const joined = await link(p.desk, p.hub);
    assert.equal(joined.ok, true, output());
    assert.deepEqual(joined.linkBack, { ok: true });
    assert.deepEqual(joined.mesh.skipped, [], output());
    assert.deepEqual(joined.mesh.linked.map(l => `${l.from}>${l.to}`).sort(),
      ['desk>server', 'laptop>hub', 'laptop>server', 'server>desk', 'hub>laptop', 'server>laptop'].sort());

    // Each file lists the other three, each with that machine's own key.
    for (const name of names) {
      const peers = JSON.parse(await readFile(p[name].configPath, 'utf-8')).peers;
      const others = names.filter(n => n !== name);
      assert.deepEqual(peers.map(e => e.name).sort(), [...others].sort(), name);
      for (const e of peers) assert.equal(e.apiKey, p[e.name].key, `${name} lists ${e.name} with its key`);
    }

    // And every link is live without a restart: each relays to each.
    for (const from of names) {
      for (const to of names.filter(n => n !== from)) {
        const res = await fetch(`http://127.0.0.1:${p[from].port}/teamclaude/peers/${to}/status`, { headers: { 'x-api-key': p[from].key } });
        assert.equal(res.status, 200, `${from} -> ${to}`);
        assert.equal((await res.json()).server.pid, p[to].pid, `${from} -> ${to}`);
      }
    }

    // No key reached any log.
    assert.ok(!/tc-(desk|laptop|hub|server)-key/.test(output()));
  } finally {
    for (const name of names) await p[name]?.stop().catch(() => {});
  }
});

test('mesh: false links the two machines and no others', async () => {
  const names = ['desk', 'hub', 'server'];
  /** @type {Record<string, any>} */
  const p = {};
  try {
    for (const name of names) {
      const s = await proxy(name);
      p[name] = Object.assign(s, { name, key: `tc-${name}-key`, url: `http://127.0.0.1:${s.port}` });
    }
    await link(p.hub, p.server);
    const out = await link(p.desk, p.hub, { mesh: false });
    assert.deepEqual(out, { ok: true, name: 'hub', url: p.hub.url, linkBack: { ok: true } });
    assert.deepEqual(JSON.parse(await readFile(p.desk.configPath, 'utf-8')).peers.map(e => e.name), ['hub']);
    assert.deepEqual(JSON.parse(await readFile(p.server.configPath, 'utf-8')).peers.map(e => e.name), ['hub']);
  } finally {
    for (const name of names) await p[name]?.stop().catch(() => {});
  }
});
