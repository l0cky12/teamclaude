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

/**
 * A counter with traffic in three slots of the window, and the clock it reads.
 * @returns {{ clock: { at: number, now: () => number }, traffic: RequestTraffic }}
 */
function busyTraffic() {
  const clock = clockAt(START - 19 * TRAFFIC_BUCKET_MS);
  const traffic = new RequestTraffic(clock);
  traffic.record(200);
  clock.at = START - 10 * TRAFFIC_BUCKET_MS;
  traffic.record(500);
  traffic.record(200);
  clock.at = START + 5;
  traffic.record(200);
  traffic.record(null);
  return { clock, traffic };
}

/** @param {RequestTraffic} traffic */
const nonZero = traffic => traffic.read().buckets.filter(b => b.ok || b.failed);

test('slots saved from read() and restored into a new counter read back the same', () => {
  const { clock, traffic } = busyTraffic();
  const saved = JSON.parse(JSON.stringify(traffic.read()));
  const restored = new RequestTraffic(clock);
  restored.restore(saved);
  assert.deepEqual(restored.read(), traffic.read());
  assert.deepEqual(nonZero(restored), [
    { at: START - 19 * TRAFFIC_BUCKET_MS, ok: 1, failed: 0 },
    { at: START - 10 * TRAFFIC_BUCKET_MS, ok: 1, failed: 1 },
    { at: START, ok: 1, failed: 1 },
  ]);
  restored.record(200);
  assert.deepEqual(restored.read().buckets.at(-1), { at: START, ok: 2, failed: 1 }, 'a request after the restore adds to the restored slot');
});

test('restoring the same saved value twice counts it once', () => {
  const { clock, traffic } = busyTraffic();
  const saved = traffic.read();
  const restored = new RequestTraffic(clock);
  restored.restore(saved);
  restored.restore(saved);
  assert.deepEqual(restored.read(), traffic.read());
});

test('a restore drops slots that have left the window and slots ahead of the clock', () => {
  const { clock, traffic } = busyTraffic();
  const saved = traffic.read();
  saved.buckets.push({ at: START + 10 * TRAFFIC_BUCKET_MS, ok: 9, failed: 9 });
  clock.at = START + 9 * TRAFFIC_BUCKET_MS;
  const restored = new RequestTraffic(clock);
  restored.restore(saved);
  assert.deepEqual(nonZero(restored), [
    { at: START - 10 * TRAFFIC_BUCKET_MS, ok: 1, failed: 1 },
    { at: START, ok: 1, failed: 1 },
  ]);
  clock.at = START + 10 * TRAFFIC_BUCKET_MS;
  assert.deepEqual(nonZero(restored), [{ at: START, ok: 1, failed: 1 }], 'the slot ahead of the restore clock was not kept');
});

test('a saved value with another slot size or the wrong shape is ignored whole', () => {
  const clock = clockAt(START);
  const slot = { at: START, ok: 3, failed: 1 };
  for (const saved of [
    undefined, null, 'x', 7, [slot],
    { buckets: [slot] },
    { bucketMs: 60_000, buckets: [slot] },
    { bucketMs: String(TRAFFIC_BUCKET_MS), buckets: [slot] },
    { bucketMs: TRAFFIC_BUCKET_MS },
    { bucketMs: TRAFFIC_BUCKET_MS, buckets: { 0: slot } },
  ]) {
    const traffic = new RequestTraffic(clock);
    traffic.restore(saved);
    assert.deepEqual(nonZero(traffic), [], JSON.stringify(saved) ?? String(saved));
  }
});

test('a malformed slot is dropped and the well-formed ones beside it are kept', () => {
  const clock = clockAt(START);
  const at = START - TRAFFIC_BUCKET_MS;
  const traffic = new RequestTraffic(clock);
  traffic.restore({ bucketMs: TRAFFIC_BUCKET_MS, buckets: [
    null, 'slot', 3,
    { at, ok: -1, failed: 0 },
    { at, ok: 1.5, failed: 0 },
    { at, ok: '2', failed: 0 },
    { at, ok: 2 },
    { at, ok: Number.POSITIVE_INFINITY, failed: 0 },
    { at: at + 1, ok: 2, failed: 0 },
    { at: String(at), ok: 2, failed: 0 },
    { at: Number.NaN, ok: 2, failed: 0 },
    { ok: 2, failed: 0 },
    { at: START, ok: 4, failed: 2 },
  ] });
  assert.deepEqual(nonZero(traffic), [{ at: START, ok: 4, failed: 2 }]);
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
