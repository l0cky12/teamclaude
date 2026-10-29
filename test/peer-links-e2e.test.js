import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { closedPort, spawnServer } from '../test-helpers/spawn-server.js';

// Two real proxies, each with its own config file, linked from one of them in
// one step the way the dashboard's Linked instances card does it: the add on
// the first carries a linkBack, and the first asks the second to list it too.
// Afterwards each relays to the other, so either dashboard shows both.

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

const post = (port, key, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(body),
});

test('one add with a link back links two real proxies both ways', async () => {
  const hub = await proxy('hub');
  const desk = await proxy('desk');
  try {
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    const deskUrl = `http://127.0.0.1:${desk.port}`;

    // The form's Test button first: desk answers to its key and can link back.
    const tested = await (await post(hub.port, 'tc-hub-key', '/teamclaude/peer-links/test', { url: deskUrl, apiKey: 'tc-desk-key' })).json();
    assert.equal(tested.state, 'online');
    assert.equal(tested.linkable, true);

    const res = await post(hub.port, 'tc-hub-key', '/teamclaude/peer-links/add', {
      name: 'desk', url: deskUrl, apiKey: 'tc-desk-key', linkBack: { name: 'hub', url: hubUrl },
    });
    const body = await res.json();
    assert.deepEqual(body, { ok: true, name: 'desk', url: deskUrl, linkBack: { ok: true } }, hub.output() + desk.output());

    // Each file names the other, with the other's own key.
    assert.deepEqual(JSON.parse(await readFile(hub.configPath, 'utf-8')).peers, [{ name: 'desk', url: deskUrl, apiKey: 'tc-desk-key' }]);
    assert.deepEqual(JSON.parse(await readFile(desk.configPath, 'utf-8')).peers, [{ name: 'hub', url: hubUrl, apiKey: 'tc-hub-key' }]);

    // And both are live without a restart: each relays to the other.
    const viaHub = await fetch(`http://127.0.0.1:${hub.port}/teamclaude/peers/desk/status`, { headers: { 'x-api-key': 'tc-hub-key' } });
    assert.equal(viaHub.status, 200);
    assert.equal((await viaHub.json()).server.pid, desk.pid);
    const viaDesk = await fetch(`http://127.0.0.1:${desk.port}/teamclaude/peers/hub/status`, { headers: { 'x-api-key': 'tc-desk-key' } });
    assert.equal(viaDesk.status, 200);
    assert.equal((await viaDesk.json()).server.pid, hub.pid);

    // The keys reached the other machine's file, never either log.
    assert.ok(!/tc-(hub|desk)-key/.test(hub.output() + desk.output()));

    // Removing is one machine at a time: desk keeps its link to hub.
    const removed = await (await post(hub.port, 'tc-hub-key', '/teamclaude/peer-links/remove', { name: 'desk' })).json();
    assert.equal(removed.ok, true);
    assert.deepEqual(JSON.parse(await readFile(hub.configPath, 'utf-8')).peers, []);
    const gone = await fetch(`http://127.0.0.1:${hub.port}/teamclaude/peers/desk/status`, { headers: { 'x-api-key': 'tc-hub-key' } });
    assert.equal(gone.status, 404);
    assert.equal(JSON.parse(await readFile(desk.configPath, 'utf-8')).peers.length, 1);
  } finally {
    await hub.stop();
    await desk.stop();
  }
});
