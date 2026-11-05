// End to end through the real server: a Grok Build request on the /grok mount
// reaches xAI's proxy on its own path, under the serving account's identity,
// and a spent plan moves it to the next Grok account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnServer } from '../test-helpers/spawn-server.js';

test('a /grok/v1/responses request goes upstream as /v1/responses and rotates off a spent plan', async () => {
  /** @type {Array<{ path: string, headers: import('node:http').IncomingHttpHeaders }>} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push({ path: req.url || '', headers: req.headers });
    if (req.headers.authorization === 'Bearer at-a') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ code: 429, error: 'You ran out of credits. [WKE=personal-team-blocked:spending-limit]' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } }));
  });
  /** @type {Awaited<ReturnType<typeof spawnServer>>|null} */
  let server = null;
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
    const xai = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (upstream.address()).port}`;
    const grok = (/** @type {string} */ id) => ({
      name: `grok-${id}`, type: 'oauth', provider: 'grok', upstream: xai,
      accessToken: `at-${id}`, expiresAt: Date.now() + 24 * 3600_000, userId: `user-${id}`, email: `${id}@example.com`,
    });
    server = await spawnServer({
      config: () => ({ upstreamProxy: false, autoUpdate: false, accounts: [grok('a'), grok('b')] }),
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/grok/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer client-token',
        'x-userid': 'client-user', 'x-grok-user-id': 'client-user', 'x-email': 'client@example.com',
      },
      body: JSON.stringify({ model: 'grok-build', input: 'hi' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 'resp_1');

    assert.deepEqual(seen.map(s => [s.path, s.headers.authorization, s.headers['x-userid'], s.headers['x-grok-user-id'], s.headers['x-email'], s.headers['x-xai-token-auth']]), [
      ['/v1/responses', 'Bearer at-a', 'user-a', 'user-a', 'a@example.com', 'xai-grok-cli'],
      ['/v1/responses', 'Bearer at-b', 'user-b', 'user-b', 'b@example.com', 'xai-grok-cli'],
    ]);

    const status = await (await fetch(`http://127.0.0.1:${server.port}/teamclaude/status`)).json();
    const byName = Object.fromEntries(status.accounts.map((/** @type {any} */ a) => [a.name, a]));
    assert.equal(byName['grok-a'].status, 'throttled');
    assert.equal(byName['grok-b'].status, 'active');
  } finally {
    await server?.stop();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('a Grok request never lands on a Claude account, and a Claude request never on a Grok one', async () => {
  /** @type {string[]} */
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    seen.push(`${req.url} ${req.headers.authorization ?? req.headers['x-api-key']}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', type: 'message', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  /** @type {Awaited<ReturnType<typeof spawnServer>>|null} */
  let server = null;
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
    const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (upstream.address()).port}`;
    server = await spawnServer({
      config: () => ({
        upstream: base, upstreamProxy: false, autoUpdate: false,
        accounts: [
          { name: 'claude', type: 'oauth', accessToken: 'at-claude', expiresAt: Date.now() + 24 * 3600_000 },
          { name: 'grok', type: 'oauth', provider: 'grok', upstream: base, accessToken: 'at-grok', expiresAt: Date.now() + 24 * 3600_000, userId: 'u' },
        ],
      }),
    });
    const proxy = `http://127.0.0.1:${server.port}`;
    const post = (/** @type {string} */ path, /** @type {any} */ body) => fetch(`${proxy}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.text());
    await post('/grok/v1/responses', { model: 'grok-build', input: 'hi' });
    await post('/v1/messages', { model: 'claude-fable-5-1', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(seen, ['/v1/responses Bearer at-grok', '/v1/messages Bearer at-claude']);
  } finally {
    await server?.stop();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('a Grok request is served by a Grok account alone, never by an API key ahead of it', async () => {
  /** @type {string[]} */
  const anthropicSeen = [];
  /** @type {string[]} */
  const grokSeen = [];
  let grokSpent = false;
  const anthropic = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    anthropicSeen.push(`${req.url} ${req.headers['x-api-key']}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
  });
  const grok = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    grokSeen.push(`${req.url} ${req.headers.authorization}`);
    if (grokSpent) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      res.end(JSON.stringify({ code: 429, error: 'You ran out of credits. [WKE=personal-team-blocked:spending-limit]' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } }));
  });
  /** @type {Awaited<ReturnType<typeof spawnServer>>|null} */
  let server = null;
  try {
    const listen = (/** @type {import('node:http').Server} */ s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}`)));
    const anthropicBase = await listen(anthropic);
    const grokBase = await listen(grok);
    server = await spawnServer({
      config: () => ({
        upstream: anthropicBase, upstreamProxy: false, autoUpdate: false,
        accounts: [
          { name: 'key', type: 'apikey', apiKey: 'sk-demo-1', priority: 0 },
          { name: 'grok', type: 'oauth', provider: 'grok', upstream: grokBase, accessToken: 'at-grok', expiresAt: Date.now() + 24 * 3600_000, userId: 'u', priority: 1 },
        ],
      }),
    });
    const send = () => fetch(`http://127.0.0.1:${/** @type {any} */ (server).port}/grok/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'grok-build', input: 'hi' }),
    });

    const served = await send();
    assert.equal(served.status, 200);
    await served.arrayBuffer();
    assert.deepEqual(grokSeen, ['/v1/responses Bearer at-grok']);

    grokSpent = true;
    const spent = await send();
    await spent.arrayBuffer();
    assert.equal(spent.status, 429, 'a spent Grok pool answers 429 rather than another provider\'s reply');
    assert.deepEqual(grokSeen, ['/v1/responses Bearer at-grok', '/v1/responses Bearer at-grok']);
    assert.deepEqual(anthropicSeen, [], 'the API key never served a Grok request');
  } finally {
    await server?.stop();
    for (const s of [anthropic, grok]) { s.closeAllConnections(); s.close(); }
  }
});
