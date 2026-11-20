import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RequestTraffic, TRAFFIC_BUCKET_MS, TRAFFIC_BUCKETS } from '../src/request-traffic.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const START = 1000 * TRAFFIC_BUCKET_MS;

/** @param {number} at */
function clockAt(at) {
  const clock = { at, now: () => clock.at };
  return clock;
}

test('read returns 20 zero slots, oldest first, ending with the current slot', () => {
  const clock = clockAt(START + 123_456);
  const { bucketMs, buckets } = new RequestTraffic(clock).read();
  assert.equal(bucketMs, 600_000);
  assert.equal(buckets.length, TRAFFIC_BUCKETS);
  assert.deepEqual(buckets.at(-1), { at: START, ok: 0, failed: 0 });
  assert.deepEqual(buckets[0], { at: START - 19 * TRAFFIC_BUCKET_MS, ok: 0, failed: 0 });
  for (let i = 1; i < buckets.length; i++) assert.equal(buckets[i].at - buckets[i - 1].at, TRAFFIC_BUCKET_MS);
});

test('a request lands in the slot its end time falls in', () => {
  const clock = clockAt(START);
  const traffic = new RequestTraffic(clock);
  traffic.record(200);
  clock.at = START + TRAFFIC_BUCKET_MS - 1;
  traffic.record(200);
  clock.at = START + 2 * TRAFFIC_BUCKET_MS;
  traffic.record(200);
  const { buckets } = traffic.read();
  assert.deepEqual(buckets.slice(-3), [
    { at: START, ok: 2, failed: 0 },
    { at: START + TRAFFIC_BUCKET_MS, ok: 0, failed: 0 },
    { at: START + 2 * TRAFFIC_BUCKET_MS, ok: 1, failed: 0 },
  ]);
});

test('a missing status, a 4xx and a 5xx are failed; 2xx and 3xx are ok', () => {
  const traffic = new RequestTraffic(clockAt(START));
  for (const status of [200, 204, 304, 399]) traffic.record(status);
  for (const status of [null, undefined, 0, 400, 429, 500, 529]) traffic.record(status);
  assert.deepEqual(traffic.read().buckets.at(-1), { at: START, ok: 4, failed: 7 });
});

test('a slot older than 20 buckets drops out of the read', () => {
  const clock = clockAt(START);
  const traffic = new RequestTraffic(clock);
  traffic.record(200);
  clock.at = START + 19 * TRAFFIC_BUCKET_MS;
  assert.deepEqual(traffic.read().buckets[0], { at: START, ok: 1, failed: 0 });
  clock.at = START + 20 * TRAFFIC_BUCKET_MS;
  const { buckets } = traffic.read();
  assert.equal(buckets.some(b => b.ok || b.failed), false);
  assert.equal(buckets[0].at, START + TRAFFIC_BUCKET_MS);
});

test('a slot reused a lap later starts from zero', () => {
  const clock = clockAt(START);
  const traffic = new RequestTraffic(clock);
  traffic.record(200);
  traffic.record(500);
  clock.at = START + 20 * TRAFFIC_BUCKET_MS;
  traffic.record(429);
  const { buckets } = traffic.read();
  assert.deepEqual(buckets.at(-1), { at: START + 20 * TRAFFIC_BUCKET_MS, ok: 0, failed: 1 });
  assert.equal(buckets.reduce((sum, b) => sum + b.ok + b.failed, 0), 1);
});

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)));
}

test('/teamclaude/status carries traffic with the request just served', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'work', type: 'apikey', apiKey: 'fake' }], 0.98);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    const url = `http://127.0.0.1:${await listen(proxy)}`;
    const res = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const { traffic } = await (await fetch(`${url}/teamclaude/status`)).json();
    assert.equal(traffic.bucketMs, TRAFFIC_BUCKET_MS);
    assert.equal(traffic.buckets.length, TRAFFIC_BUCKETS);
    const served = traffic.buckets.filter((/** @type {any} */ b) => b.ok || b.failed);
    assert.deepEqual(served.map((/** @type {any} */ b) => [b.ok, b.failed]), [[1, 0]]);
  } finally {
    proxy.closeAllConnections();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});
