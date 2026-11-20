// The per-10-minute request counts in /teamclaude/status `traffic` survive a
// real restart of the server: they are saved with the state file on shutdown
// and taken back at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';

const envFor = (/** @type {string} */ dir) => ({ HOME: dir, XDG_CONFIG_HOME: dir, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' });

/** @param {number} port @param {string} content */
async function post(port, content) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 1, messages: [{ role: 'user', content }] }),
  });
  await res.arrayBuffer();
  return res.status;
}

/** @param {number} port */
async function trafficTotals(port) {
  const { traffic } = await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`)).json();
  let ok = 0, failed = 0;
  for (const b of traffic.buckets) { ok += b.ok; failed += b.failed; }
  return { ok, failed };
}

test('request counts in /teamclaude/status survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-traffic-'));
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const fail = body.includes('fail');
    res.writeHead(fail ? 400 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail
      ? { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } }
      : { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  let srv;
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(null)));
    const config = {
      proxy: { apiKey: 'test-key' },
      upstream: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (upstream.address()).port}`,
      upstreamProxy: false, autoUpdate: false, quotaProbeSeconds: 0,
      accounts: [{ id: 'a', name: 'demo-a', type: 'apikey', apiKey: 'sk-demo-1' }],
    };
    const start = () => spawnServer({ dir, env: envFor(dir), config: () => config });
    srv = await start();
    assert.deepEqual(await Promise.all([post(srv.port, 'one'), post(srv.port, 'two'), post(srv.port, 'three'), post(srv.port, 'fail')]), [200, 200, 200, 400]);
    assert.deepEqual(await trafficTotals(srv.port), { ok: 3, failed: 1 });
    await srv.stop();
    const saved = JSON.parse(await readFile(join(dir, 'config.state.json'), 'utf8'));
    assert.equal(saved.traffic.buckets.length, 20);

    srv = await start();
    assert.deepEqual(await trafficTotals(srv.port), { ok: 3, failed: 1 }, 'counts from before the restart');
    assert.equal(await post(srv.port, 'four'), 200);
    assert.deepEqual(await trafficTotals(srv.port), { ok: 4, failed: 1 }, 'a new request adds to them');
  } finally {
    await srv?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
