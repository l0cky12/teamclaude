// A Grok account on the Quota and Insights views: what a streamed Grok reply
// books into the usage history and how it is priced, what its row says before
// it has a reading, and the "month" a monthly plan's lines are written in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';
import { accountMeters } from '../src/dashboard.js';
import { outsideSpendText, forecastText, renderStatus } from '../src/status-renderer.js';
import { GROK_PRICES, costAt } from '../src/api-pricing.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

test('a streamed Grok reply lands on the Insights page under Grok, priced at xAI\'s list price', async t => {
  // xAI's proxy streams a Responses turn and settles its usage on the terminal
  // event, cached tokens inside input_tokens, as OpenAI's does.
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\n`);
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_1', object: 'response', status: 'completed',
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50 },
    } })}\n\n`);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{
    name: 'grok-a', type: 'oauth', provider: 'grok', upstream: `http://127.0.0.1:${upstreamPort}`,
    accessToken: 'at-a', expiresAt: Date.now() + 24 * 3600_000, userId: 'user-a',
  }], 0.98);
  const proxy = createProxyServer(am, { proxy: {} });
  const port = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });

  const res = await fetch(`http://127.0.0.1:${port}/grok/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-4.7', input: 'hi', stream: true }),
  });
  assert.equal(res.status, 200);
  await res.text();

  const d = await (await fetch(`http://127.0.0.1:${port}/teamclaude/insights?range=24h`)).json();
  assert.deepEqual(d.providers.map((/** @type {any} */ p) => p.provider), ['grok']);
  assert.deepEqual(d.accounts.map((/** @type {any} */ a) => [a.provider, a.account, a.requests]), [['grok', 'grok-a', 1]]);
  assert.deepEqual(d.totals, { requests: 1, input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  assert.deepEqual(d.models.map((/** @type {any} */ m) => [m.provider, m.model]), [['grok', 'grok-4.7']]);
  const expected = costAt(GROK_PRICES['grok-4.7'], { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  assert.ok(Math.abs(d.cost.total - expected) < 1e-12, `cost ${d.cost.total} != ${expected}`);
  assert.equal(d.cost.unpricedTokens, 0);
});

test('a Grok row with no reading says how to get one; other rows keep waiting for traffic', () => {
  assert.match(String(accountMeters({ provider: 'grok', quota: {} }).text), /Grok states it only when asked \(Refresh quota\)/);
  assert.equal(accountMeters({ provider: 'codex', quota: {} }).text, 'quota unknown (no traffic observed yet)');
  assert.equal(accountMeters({ quota: {} }).text, 'quota unknown (no traffic observed yet)');
});

test('teamclaude status says where an unread Grok account\'s quota comes from', () => {
  const am = new AccountManager([
    { name: 'g', type: 'oauth', provider: 'grok', accessToken: 'at', expiresAt: Date.now() + 24 * 3600_000, userId: 'u' },
    { name: 'k', type: 'apikey', apiKey: 'sk-demo-1' },
  ], 0.98);
  const out = renderStatus(am.getStatus(), { color: false, now: Date.now() });
  assert.match(out, /Quota\s+unknown \(Grok states it only to the quota probe\)/);
  assert.equal(out.match(/Quota\s+unknown$/gm)?.length, 1, 'the API key keeps the bare word');
});

test('a monthly plan\'s outside-spend and forecast lines say month, a weekly one week', () => {
  const outside = { unified7d: { share: 0.12, state: 'measured', since: null } };
  assert.equal(outsideSpendText(outside, 0, 'monthly'), '12.0% of the month went elsewhere');
  assert.equal(outsideSpendText(outside, 0, null), '12.0% of the week went elsewhere');
  assert.equal(outsideSpendText({ unified7d: { share: null, state: 'not_observed', since: null } }, 0, 'monthly'), 'month: not observed (quota probe off?)');

  const now = 1_000_000_000_000;
  const forecast = { unified7d: { ratePerHour: 0.01, threshold: 0.98, reachesThresholdAt: now + 5 * 3600_000, resetAt: now + 10 * 24 * 3600_000 } };
  assert.match(String(forecastText(forecast, now, 'monthly')), /^month reaches 98% in ~5h/);
  assert.match(String(forecastText(forecast, now)), /^week reaches 98% in ~5h/);
});
