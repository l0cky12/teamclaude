// GET /teamclaude/insights: what a served response books into the usage
// history (usage-history.js), read back through the endpoint the dashboard's
// Insights page draws. The history's own arithmetic is in usage-history.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

// An upstream that answers a buffered request with one usage object, and a
// streamed one the way Anthropic does: input and cache at message_start, the
// final output at message_delta.
/** @param {any} t */
async function fixture(t) {
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (JSON.parse(body).stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm2', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`);
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm1', type: 'message', usage: { input_tokens: 11, output_tokens: 7 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'work', type: 'apikey', apiKey: 'fake' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  return { am, url: `http://127.0.0.1:${port}` };
}

/** @param {string} url @param {Record<string, any>} body */
async function send(url, body) {
  const res = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_tokens: 1, messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  assert.equal(res.status, 200);
  await res.text();
}

test('a buffered and a streamed response are each one request, with every token kind', async t => {
  const { url } = await fixture(t);
  await send(url, { model: 'claude-opus-5-5' });
  await send(url, { model: 'claude-opus-5-5', stream: true });

  const res = await fetch(`${url}/teamclaude/insights?range=24h`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const d = await res.json();
  assert.equal(d.range, '24h');
  assert.equal(d.unit, 'hour');
  assert.equal(d.buckets.length, 24);
  // The stream's output is its final figure (9), not 9 plus the placeholder.
  assert.deepEqual(d.totals, { requests: 2, input: 16, output: 16, cacheRead: 100, cacheWrite: 20 });
  assert.equal(d.requests[23], 2, 'both land in the current hour');
  assert.deepEqual(d.accounts.map((/** @type {any} */ a) => [a.provider, a.account, a.requests]), [['anthropic', 'work', 2]]);
  assert.deepEqual(d.models.map((/** @type {any} */ m) => m.model), ['claude-opus-5-5']);
  assert.ok(d.since > 0);

  const week = await (await fetch(`${url}/teamclaude/insights?range=7d`)).json();
  assert.equal(week.unit, 'day');
  assert.equal(week.buckets.length, 7);
  assert.equal(week.totals.requests, 2);
  assert.equal(week.previous, null, 'recording began today');

  const fallback = await (await fetch(`${url}/teamclaude/insights?range=nope`)).json();
  assert.equal(fallback.range, '30d', 'an unknown range gets the default, and says so');
});

test('a backend account is booked under its host, a Codex one under codex', () => {
  const am = new AccountManager([
    { name: 'ds', type: 'apikey', apiKey: 'k1', upstream: 'https://api.deepseek.com/anthropic' },
    { name: 'cx', type: 'apikey', provider: 'codex', apiKey: 'k2' },
    { name: 'main', type: 'apikey', apiKey: 'k3' },
  ], 0.98);
  am.recordTokenUsage(0, null, 'deepseek-v4-pro', { input_tokens: 10, output_tokens: 1 });
  am.recordTokenUsage(1, null, 'gpt-6', { input_tokens: 20, output_tokens: 1 });
  am.recordTokenUsage(2, null, 'claude-sonnet-5', { input_tokens: 30, output_tokens: 1 });
  am.recordTokenUsage(9, null, 'claude-sonnet-5', { input_tokens: 99 });
  const d = am.usageHistory.insights('7d');
  assert.deepEqual(d.accounts.map(a => [a.provider, a.account]).sort(),
    [['anthropic', 'main'], ['backend:api.deepseek.com', 'ds'], ['codex', 'cx']]);
  assert.equal(d.totals.requests, 3, 'an index with no account books nothing');
});
