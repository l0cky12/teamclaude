// proxy.logPrompts is read live, so a reload has to be able to turn it off,
// including by deleting the whole proxy section: prompt capture that outlives
// its opt-in would keep what people type in a log every key holder can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnServer } from '../test-helpers/spawn-server.js';

test('a reload without a proxy section stops recording prompts', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const c of req) void c;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test', logPrompts: true },
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamProxy: false,
      autoUpdate: false,
      accounts: [{ name: 'work', type: 'apikey', apiKey: 'k1' }],
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const send = async (/** @type {string} */ text) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 1, messages: [{ role: 'user', content: text }] }),
    });
    await res.text();
  };
  const prompts = async () => (await (await fetch(`${base}/teamclaude/logs`)).json()).events
    .filter((/** @type {any} */ e) => e.kind === 'usage').map((/** @type {any} */ e) => e.prompt ?? null);
  try {
    await send('kept');
    const config = JSON.parse(await readFile(server.configPath, 'utf8'));
    delete config.proxy;
    await writeFile(server.configPath, JSON.stringify(config));
    assert.equal((await fetch(`${base}/teamclaude/reload`, { method: 'POST' })).status, 200);
    await send('not kept');
    assert.deepEqual(await prompts(), ['kept', null]);
  } finally {
    await server.stop();
    upstream.closeAllConnections();
    upstream.close();
  }
});
