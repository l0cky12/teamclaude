// GET /teamclaude/logs: a request served through the proxy becomes a usage
// entry, and `?after=` returns only what is newer. The caller's own activity
// hooks still see every request. Control entries are in control-events.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, createProxyRequestListener, eventPath } from '../src/server.js';

const PIN_UUID = '3f9a1c2e-7b4d-4e8a-9c1f-0a2b3c4d5e6f';
const UNKNOWN_UUID = '0b0e7f6c-1d2e-4f00-9a00-123456789abc';

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
  const am = new AccountManager([{ name: 'work', type: 'apikey', apiKey: 'fake', accountUuid: PIN_UUID }], 0.98);
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

const post = (/** @type {string} */ url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
});

// A pin names an account however the client spelled it: an account uuid, an
// email, an index. Client keys can read the log, so the entry names the
// account by its configured name only, and an unresolved pin by nothing.
test('a /tc-acct/ pin never puts the client\'s spelling of the account on the log', async t => {
  const { url } = await fixture(t);
  assert.equal((await post(`${url}/tc-acct/${PIN_UUID}/v1/messages`)).status, 200);
  assert.equal((await post(`${url}/tc-acct/${UNKNOWN_UUID}/v1/messages`)).status, 404);
  const page = await (await fetch(`${url}/teamclaude/logs`)).json();
  const text = JSON.stringify(page.events);
  assert.equal(text.includes(PIN_UUID), false);
  assert.equal(text.includes(UNKNOWN_UUID), false);
  const [served, refused] = page.events.filter((/** @type {any} */ e) => e.kind === 'usage');
  assert.equal(served.account, 'work');
  // A served pin's path reaches the log as forwarded, the prefix already gone.
  assert.equal(served.message, 'POST /v1/messages');
  assert.equal(refused.account, null);
  assert.equal(refused.message, 'POST /tc-acct/…/v1/messages (unknown account pin)');
});

test('an unresolved TC_ACCT pin (the MITM listener\'s) is logged without it', async t => {
  const am = new AccountManager([{ name: 'work', type: 'apikey', apiKey: 'fake' }], 0.98);
  const server = http.createServer(createProxyRequestListener({
    accountManager: am, upstream: 'http://127.0.0.1:9', config: { proxy: {} }, forcedPin: 'someone@example.com',
  }));
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await post(`http://127.0.0.1:${port}/v1/messages`)).status, 404);
  const [entry] = am.events.since(0).events;
  assert.equal(JSON.stringify(entry).includes('someone@example.com'), false);
  assert.equal(entry.message, 'POST /v1/messages (unknown account pin)');
});

test('eventPath drops the query and the pin token, nothing else', () => {
  assert.equal(eventPath('/v1/messages?beta=true'), '/v1/messages');
  assert.equal(eventPath('/tc-acct/me@example.com/v1/messages?x=1'), '/tc-acct/…/v1/messages');
  assert.equal(eventPath('/tc-acct/2'), '/tc-acct/…');
  assert.equal(eventPath(undefined), '');
});
