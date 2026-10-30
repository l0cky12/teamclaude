// "All machines" on the Insights page (fleet-insights.js): this proxy's usage
// history added to each linked instance's, and GET /teamclaude/insights?scope=all
// reading them over real HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mergeInsights, fleetInsights, insightsScope } from '../src/fleet-insights.js';
import { UsageHistory } from '../src/usage-history.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const usage = (/** @type {Record<string, number>} */ o = {}) => ({ input_tokens: 1_000_000, output_tokens: 0, ...o });

/** A history with one fixed clock, so two of them agree on what today is. */
function history(/** @type {number} */ now) {
  return new UsageHistory({ now: () => now });
}

test('the scope a URL asks for', () => {
  assert.equal(insightsScope('/teamclaude/insights?range=7d&scope=all'), 'all');
  assert.equal(insightsScope('/teamclaude/insights?scope=ALL'), 'local');
  assert.equal(insightsScope('/teamclaude/insights'), 'local');
  assert.equal(insightsScope(undefined), 'local');
});

test('two machines\' insights add up, bucket by bucket, per account and per model', () => {
  const now = Date.now();
  const desk = history(now);
  const server = history(now);
  desk.record({ provider: 'anthropic', account: 'max', model: 'claude-opus-5-5', usage: usage() });
  server.record({ provider: 'anthropic', account: 'max', model: 'claude-opus-5-5', usage: usage() });
  server.record({ provider: 'codex', account: 'chatgpt', model: 'gpt-5', usage: usage() });
  const m = mergeInsights([
    { name: 'desk', self: true, state: 'ok', data: desk.insights('7d') },
    { name: 'server', self: false, state: 'ok', data: JSON.parse(JSON.stringify(server.insights('7d'))) },
  ]);
  assert.equal(m.scope, 'all');
  assert.equal(m.range, '7d');
  assert.equal(m.buckets.length, 7);
  assert.equal(m.totals.requests, 3);
  assert.equal(m.totals.input, 3_000_000);
  assert.equal(m.requests[6], 3);
  assert.equal(m.kinds.input[6], 3_000_000);
  // Opus 5.5 at $4 twice, gpt-5 at $1.25.
  assert.equal(m.cost.total, 9.25);
  assert.equal(m.cost.values[6], 9.25);
  // The same account on two machines is one account.
  assert.deepEqual(m.accounts.map(a => [a.provider, a.account, a.tokens, a.requests, a.cost]),
    [['anthropic', 'max', 2_000_000, 2, 8], ['codex', 'chatgpt', 1_000_000, 1, 1.25]]);
  assert.deepEqual(m.models.map(x => [x.model, x.tokens, x.input, x.cost]),
    [['claude-opus-5-5', 2_000_000, 2_000_000, 8], ['gpt-5', 1_000_000, 1_000_000, 1.25]]);
  assert.deepEqual(m.providers.map(p => [p.provider, p.tokens]), [['anthropic', 2_000_000], ['codex', 1_000_000]]);
  assert.deepEqual(m.instances.map(i => [i.name, i.self, i.state, i.tokens, i.requests, i.cost, i.values[6]]),
    [['desk', true, 'ok', 1_000_000, 1, 4, 1_000_000], ['server', false, 'ok', 2_000_000, 2, 5.25, 2_000_000]]);
  assert.equal(m.previous, null, 'neither machine reaches back over the week before');
});

test('a machine that could not be read is listed with why, and the rest are summed without it', () => {
  const now = Date.now();
  const desk = history(now);
  desk.record({ provider: 'anthropic', account: 'max', model: 'claude-opus-5-5', usage: usage() });
  const m = mergeInsights([
    { name: 'desk', self: true, state: 'ok', data: desk.insights('24h') },
    { name: 'laptop', self: false, state: 'unreachable', error: 'connect ECONNREFUSED', data: null },
  ]);
  assert.equal(m.totals.requests, 1);
  assert.deepEqual(m.instances.map(i => [i.name, i.state, i.error, i.tokens]),
    [['desk', 'ok', undefined, 1_000_000], ['laptop', 'unreachable', 'connect ECONNREFUSED', 0]]);
});

test('a peer older than the cost estimate counts its tokens as unpriced, not free', () => {
  const now = Date.now();
  const desk = history(now);
  const old = history(now);
  old.record({ provider: 'anthropic', account: 'max', model: 'claude-opus-5-5', usage: usage() });
  const oldReply = /** @type {any} */ (JSON.parse(JSON.stringify(old.insights('7d'))));
  delete oldReply.cost;
  for (const k of ['providers', 'accounts', 'models']) for (const e of oldReply[k]) delete e.cost;
  const m = mergeInsights([
    { name: 'desk', self: true, state: 'ok', data: desk.insights('7d') },
    { name: 'old', self: false, state: 'ok', data: oldReply },
  ]);
  assert.equal(m.cost.total, 0);
  assert.equal(m.cost.unpricedTokens, 1_000_000);
  assert.equal(m.models[0].cost, null);
  assert.equal(m.totals.requests, 1);
});

test('all time runs from the first day any machine recorded, on every machine', () => {
  const now = Date.now();
  const desk = history(now);
  desk.record({ provider: 'anthropic', account: 'a', model: 'x', usage: usage() });
  const local = desk.insights('all');
  // A peer that began three days earlier.
  const peer = { ...JSON.parse(JSON.stringify(local)), buckets: ['2000-01-01', '2000-01-02', '2000-01-03', ...local.buckets], since: 1 };
  for (const k of ['requests']) peer[k] = [1, 0, 0, ...local[k]];
  peer.kinds = { cacheRead: [0, 0, 0, 0], cacheWrite: [0, 0, 0, 0], input: [5, 0, 0, ...local.kinds.input], output: [0, 0, 0, 0] };
  const m = mergeInsights([
    { name: 'desk', self: true, state: 'ok', data: local },
    { name: 'peer', self: false, state: 'ok', data: peer },
  ]);
  assert.deepEqual(m.buckets.slice(0, 3), ['2000-01-01', '2000-01-02', '2000-01-03']);
  assert.equal(m.buckets.length, local.buckets.length + 3);
  assert.equal(m.kinds.input[0], 5, 'the peer\'s first day');
  assert.equal(m.kinds.input[3], 2_000_000, 'today, from both');
  assert.equal(m.since, 1);
  assert.equal(m.previous, null);
});

test('the period before is compared only when every machine that recorded reaches back over it', () => {
  const now = Date.now();
  const a = history(now);
  const b = history(now);
  a.record({ provider: 'anthropic', account: 'a', model: 'x', usage: usage() });
  const withPrev = { ...a.insights('7d'), previous: { requests: 4, input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: { total: 0, values: [], previous: 2, unpricedTokens: 0 } };
  const quiet = b.insights('7d');
  assert.equal(quiet.since, null);
  const m = mergeInsights([
    { name: 'a', self: true, state: 'ok', data: withPrev },
    { name: 'quiet', self: false, state: 'ok', data: quiet },
  ]);
  assert.equal(m.previous?.requests, 4, 'a machine that recorded nothing cannot hold it back');
  assert.equal(m.cost.previous, 2);
  b.record({ provider: 'anthropic', account: 'b', model: 'x', usage: usage() });
  const partial = mergeInsights([
    { name: 'a', self: true, state: 'ok', data: withPrev },
    { name: 'new', self: false, state: 'ok', data: b.insights('7d') },
  ]);
  assert.equal(partial.previous, null, 'one that began recording inside the week before can');
  assert.equal(partial.cost.previous, null);
});

test('each peer is asked for its own view of the same range, never for everyone\'s', async () => {
  const now = Date.now();
  const desk = history(now);
  const peerHistory = history(now);
  peerHistory.record({ provider: 'codex', account: 'cx', model: 'gpt-5', usage: usage() });
  /** @type {string[]} */
  const asked = [];
  /** @type {any} */
  const request = async (/** @type {any} */ peer, /** @type {string} */ rest) => {
    asked.push(`${peer.name}:${rest}`);
    if (peer.name === 'ok') return { status: 200, body: Buffer.from(JSON.stringify(peerHistory.insights('90d'))) };
    if (peer.name === 'old') return { status: 404, body: Buffer.from('{}') };
    if (peer.name === 'badkey') return { status: 401, body: Buffer.from('{}') };
    if (peer.name === 'wrong') return { status: 200, body: Buffer.from(JSON.stringify(peerHistory.insights('7d'))) };
    if (peer.name === 'html') return { status: 200, body: Buffer.from('<html>') };
    throw new Error('timed out');
  };
  const peers = ['ok', 'old', 'badkey', 'wrong', 'html', 'down'].map(name => ({ name, url: 'http://h:1', apiKey: 'k' }));
  const m = await fleetInsights({ local: desk.insights('90d'), selfName: 'desk', peers, request });
  assert.deepEqual(asked, peers.map(p => `${p.name}:insights?range=90d`));
  assert.deepEqual(m.instances.map(i => [i.name, i.state]),
    [['desk', 'ok'], ['ok', 'ok'], ['old', 'outdated'], ['badkey', 'refused'], ['wrong', 'error'], ['html', 'error'], ['down', 'unreachable']]);
  assert.equal(m.totals.requests, 1);
});

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

test('GET /teamclaude/insights?scope=all reads a linked proxy over HTTP, operator only', async t => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm1', type: 'message', usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
  });
  const upstreamPort = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  const serverAm = new AccountManager([{ name: 'shared', type: 'apikey', apiKey: 'fake' }], 0.98);
  const serverProxy = createProxyServer(serverAm, { proxy: { apiKey: 'server-key' }, upstream: upstreamUrl });
  const serverPort = await listen(serverProxy);

  const deskAm = new AccountManager([{ name: 'shared', type: 'apikey', apiKey: 'fake' }], 0.98);
  const deskConfig = {
    instanceName: 'desk',
    proxy: { apiKey: 'desk-key', clientKeys: [{ name: 'ci', key: 'ci-key' }] },
    upstream: upstreamUrl,
    peers: [
      { name: 'server', url: `http://127.0.0.1:${serverPort}`, apiKey: 'server-key' },
      { name: 'asleep', url: 'http://127.0.0.1:1', apiKey: 'x' },
    ],
  };
  const deskProxy = createProxyServer(deskAm, deskConfig);
  const deskPort = await listen(deskProxy);
  t.after(() => {
    for (const s of [deskProxy, serverProxy, upstream]) { s.closeAllConnections(); s.close(); }
  });

  const send = async (/** @type {number} */ port, /** @type {string} */ key) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
  };
  await send(deskPort, 'desk-key');
  await send(serverPort, 'server-key');
  await send(serverPort, 'server-key');

  const local = await (await fetch(`http://127.0.0.1:${deskPort}/teamclaude/insights?range=24h`, { headers: { 'x-api-key': 'desk-key' } })).json();
  assert.equal(local.scope, undefined, 'this machine alone, as before');
  assert.equal(local.totals.requests, 1);
  assert.equal(local.cost.total, 4, 'a million Opus 5.5 input tokens');

  const res = await fetch(`http://127.0.0.1:${deskPort}/teamclaude/insights?range=24h&scope=all`, { headers: { 'x-api-key': 'desk-key' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const all = await res.json();
  assert.equal(all.scope, 'all');
  assert.equal(all.totals.requests, 3);
  assert.equal(all.requests[23], 3);
  assert.equal(all.cost.total, 12);
  assert.deepEqual(all.accounts.map((/** @type {any} */ a) => [a.account, a.requests]), [['shared', 3]]);
  assert.deepEqual(all.instances.map((/** @type {any} */ i) => [i.name, i.self, i.state, i.requests]),
    [['desk', true, 'ok', 1], ['server', false, 'ok', 2], ['asleep', false, 'unreachable', 0]]);

  const refused = await fetch(`http://127.0.0.1:${deskPort}/teamclaude/insights?range=24h&scope=all`, { headers: { 'x-api-key': 'ci-key' } });
  assert.equal(refused.status, 403, 'a client key does not reach linked instances');
  await refused.text();
  const clientLocal = await fetch(`http://127.0.0.1:${deskPort}/teamclaude/insights?range=24h`, { headers: { 'x-api-key': 'ci-key' } });
  assert.equal(clientLocal.status, 200, 'but still reads this machine\'s');
  await clientLocal.text();
});
