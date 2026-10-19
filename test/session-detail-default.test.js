// Exercise the dashboard's status payload through startup and live reload so
// an omitted setting cannot silently hide conversations again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig } from '../src/config.js';
import { sessionRows } from '../src/dashboard.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

test('new configs explicitly enable session details', () => {
  assert.equal(createDefaultConfig().proxy.sessionDetail, true);
});

test('sessions are listed by default and an explicit opt-out hot-reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-session-detail-'));
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_demo', type: 'message', role: 'assistant', content: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
  });
  let server;
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = /** @type {import('node:net').AddressInfo} */ (upstream.address());
    server = await spawnServer({
      dir,
      env: { TEAMROUTER_CONFIG: join(dir, 'config.json') },
      config: () => ({
        proxy: { apiKey: 'tc-demo' },
        accounts: [{ name: 'demo', type: 'apikey', apiKey: 'sk-demo' }],
        upstream: `http://127.0.0.1:${port}`, upstreamProxy: false, autoUpdate: false,
      }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    for (const session of ['demo-session-a', 'demo-session-b']) {
      const response = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': session },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1, messages: [] }),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }
    const status = async () => {
      const response = await fetch(`${base}/teamclaude/status`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const initial = (await status()).sessions;
    assert.equal(initial.known, 2);
    assert.deepEqual(sessionRows(initial).map(row => row.session).sort(), ['demo-session-a', 'demo-session-b']);
    assert.ok(sessionRows(initial).every(row => row.requests === 1 && row.input === 10 && row.output === 5));

    // A disk edit and reload must apply both the opt-out and its removal;
    // neither may drop the tracker's already-known conversations.
    for (const enabled of [false, true, undefined]) {
      const config = JSON.parse(await readFile(server.configPath, 'utf8'));
      if (enabled === undefined) delete config.proxy.sessionDetail;
      else config.proxy.sessionDetail = enabled;
      await writeFile(server.configPath, JSON.stringify(config));
      const response = await fetch(`${base}/teamclaude/reload`, { method: 'POST' });
      assert.equal(response.status, 200, await response.text());
      const sessions = (await status()).sessions;
      assert.equal(sessions.known, initial.known);
      assert.equal(sessions.active, initial.active);
      if (enabled === false) assert.equal('items' in sessions, false);
      else assert.equal(sessionRows(sessions).length, 2);
    }
  } finally {
    await server?.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
