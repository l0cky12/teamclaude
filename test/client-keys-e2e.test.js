import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

// The real server, headless, driven the way the dashboard's Client keys card
// drives it and then used the way a client uses the key it hands out: a key
// made from the page has to be accepted by the running proxy straight away,
// with its requests booked under its name, and refused again once revoked.
// The client's requests carry X-Forwarded-For, which the proxy never admits
// through the loopback exemption, so they are held to the key gate the way a
// client on another machine is. (`trustLoopback: false` would say the same, but
// spawnServer's readiness poll reads status without a key.)

const REMOTE = { 'x-forwarded-for': '203.0.113.5' };

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// An upstream that answers every message with a fixed usage.
function startStubUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 3 } }));
    });
  });
}

const OPERATOR = 'tc-operator';

// `operatorKey` is sent on the control calls; null for a proxy without a
// shared key, whose operator is the key-exempt loopback caller.
function control(port, step, name, operatorKey = OPERATOR) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/client-keys/${step}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(operatorKey ? { 'x-api-key': operatorKey } : {}) },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  });
}

// A request from a client on another machine; `key` null sends none.
function message(port, key) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...REMOTE },
    body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [] }),
    signal: AbortSignal.timeout(10_000),
  });
}

function status(port, key) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': key, ...REMOTE }, signal: AbortSignal.timeout(10_000) });
}

// The stub and the server, both closed whatever happens, startup included.
async function withServer(proxy, fn) {
  const stub = startStubUpstream();
  let server = null;
  try {
    const stubPort = await listen(stub);
    server = await spawnServer({
      config: () => ({
        proxy,
        upstream: `http://127.0.0.1:${stubPort}`,
        upstreamProxy: false,
        autoUpdate: false,
        accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }],
      }),
    });
    await fn(server);
  } finally {
    if (server) await server.stop();
    stub.closeAllConnections();
    stub.close();
  }
}

test('a key made from the dashboard works at once, is counted under its name, and stops working when revoked', async () => {
  await withServer({ apiKey: OPERATOR }, async ({ port, configPath }) => {
    const created = await control(port, 'create', 'laptop');
    assert.equal(created.status, 200);
    const { key } = await created.json();
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).proxy.clientKeys, [{ name: 'laptop', key }]);

    // The dashboard's Test key: status read with the new key names the client.
    const asClient = await (await status(port, key)).json();
    assert.equal(asClient.caller.kind, 'client');
    assert.equal(asClient.caller.client, 'laptop');
    assert.deepEqual(asClient.clientKeys, ['laptop']);

    const used = await message(port, key);
    assert.equal(used.status, 200, await used.clone().text());
    await used.arrayBuffer();
    const booked = (await (await status(port, OPERATOR)).json()).clients.laptop;
    assert.equal(booked.requests, 1);
    assert.equal(booked.inputTokens, 7);
    assert.equal(booked.outputTokens, 3);

    assert.equal((await message(port, 'tc-not-a-key')).status, 401, 'the gate is on: a wrong key is refused');

    const revoked = await control(port, 'revoke', 'laptop');
    assert.equal(revoked.status, 200);
    assert.equal((await message(port, key)).status, 401, 'a revoked key is refused without a restart');
    assert.equal((await status(port, key)).status, 401);
    const after = await (await status(port, OPERATOR)).json();
    assert.deepEqual(after.clientKeys, []);
    assert.equal(after.clients.laptop.requests, 1, 'the usage booked so far stays');
  });
});

// Without a shared key the client keys are the whole gate: the first one
// closes it, and revoking the last one would open it to everybody again.
test('on a proxy without a shared key, the first key closes the gate and the last cannot be revoked', async () => {
  await withServer({}, async ({ port, configPath }) => {
    assert.equal((await message(port, null)).status, 200, 'setup: with no key at all the gate is open');

    const created = await control(port, 'create', 'laptop', null);
    assert.equal(created.status, 200);
    const { key, firstKey } = await created.json();
    assert.equal(firstKey, true);
    assert.equal((await message(port, null)).status, 401, 'the first key closes the gate');
    assert.equal((await message(port, key)).status, 200);

    const refused = await control(port, 'revoke', 'laptop', null);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /last key/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).proxy.clientKeys, [{ name: 'laptop', key }]);
    assert.equal((await message(port, null)).status, 401, 'the gate stays closed');
    const asRevoked = await status(port, key);
    assert.equal((await asRevoked.json()).caller.kind, 'client', 'the key did not become the operator');

    // With a second key the first one can go, and the gate stays shut.
    assert.equal((await control(port, 'create', 'desktop', null)).status, 200);
    assert.equal((await control(port, 'revoke', 'laptop', null)).status, 200);
    assert.equal((await message(port, key)).status, 401);
    assert.equal((await message(port, null)).status, 401);
  });
});
