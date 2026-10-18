// GET /teamclaude/logs: a request served through the proxy becomes a usage
// entry, and `?after=` returns only what is newer. The caller's own activity
// hooks still see every request. Control entries are in control-events.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

/** @param {any} t @param {Record<string, any>} [hooks] */
async function fixture(t, hooks = {}) {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', usage: { input_tokens: 11, output_tokens: 7 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'work', type: 'apikey', apiKey: 'fake' }], 0.98);
  const ended = [];
  const proxy = createProxyServer(am,
    { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` },
    { ...hooks, onRequestEnd: (/** @type {number} */ id, /** @type {any} */ info) => ended.push({ id, ...info }) });
  const port = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  return { am, ended, url: `http://127.0.0.1:${port}` };
}

test('a served request is a usage entry with its account, model, status and tokens', async t => {
  const { url, ended } = await fixture(t);
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  await res.text();

  const page = await (await fetch(`${url}/teamclaude/logs`)).json();
  const usage = page.events.filter((/** @type {any} */ e) => e.kind === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].account, 'work');
  assert.equal(usage[0].provider, 'anthropic');
  assert.equal(usage[0].model, 'claude-fable-5-1');
  assert.equal(usage[0].status, 200);
  assert.equal(usage[0].inputTokens, 11);
  assert.equal(usage[0].outputTokens, 7);
  assert.equal(typeof usage[0].ms, 'number');
  assert.equal(usage[0].message, 'POST /v1/messages');
  // The caller's own hook still closed the row.
  assert.equal(ended.length, 1);

  const after = await (await fetch(`${url}/teamclaude/logs?after=${page.lastId}`)).json();
  assert.deepEqual(after.events, []);
  assert.equal(after.lastId, page.lastId);
});

test('a refused request names no account', async t => {
  const { url } = await fixture(t);
  // fetch would normalise the dot-segment away; node:http sends the path as written.
  await new Promise((resolve, reject) => {
    const req = http.request(`${url}/`, { method: 'GET', path: '/v1/../x' }, r => { r.resume(); r.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  const page = await (await fetch(`${url}/teamclaude/logs`)).json();
  const refused = page.events.filter((/** @type {any} */ e) => e.status === 400);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].account, null);
  assert.match(refused[0].message, /refused/);
});
