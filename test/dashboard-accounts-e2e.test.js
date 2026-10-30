import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

// The real server, headless, driven the way the dashboard's Accounts page
// drives it: Remove has to take an account out of the running fleet AND out of
// the config file, and a sign-in started there has to be the server's own
// flow, reachable, cancellable and on the event log.

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify(body),
});
const status = port => fetch(`http://127.0.0.1:${port}/teamclaude/status`).then(r => r.json());

async function withServer(fn) {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: 'tc-test' },
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      autoUpdate: false,
      accounts: [
        { name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' },
        { name: 'b@example.com', type: 'apikey', apiKey: 'sk-demo-2' },
      ],
    }),
    // No browser may open on the host for a dashboard sign-in; saying the
    // terminal is local proves that is the caller's choice, not the session's.
    env: { TEAMCLAUDE_REMOTE: '0', TEAMROUTER_REMOTE: '0' },
  });
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

test('Remove takes the account out of the fleet and the config file, and leaves the rest', async () => {
  await withServer(async ({ port, configPath }) => {
    const res = await post(port, '/teamclaude/remove', { account: 'a@example.com' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, 'a@example.com');

    const fleet = await status(port);
    assert.deepEqual(fleet.accounts.map(a => a.name), ['b@example.com']);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(disk.accounts.map(a => a.name), ['b@example.com']);
    assert.equal(disk.accounts[0].apiKey, 'sk-demo-2', 'the remaining account keeps its credential');

    // A reload reads the file again: the removal must not come back from it.
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' })).status, 200);
    assert.deepEqual((await status(port)).accounts.map(a => a.name), ['b@example.com']);

    const logs = await fetch(`http://127.0.0.1:${port}/teamclaude/logs`).then(r => r.json());
    assert.ok(logs.events.some(e => e.type === 'account_removed' && e.account === 'a@example.com'), 'the removal is on the event log');

    // The last one goes too: a server with none keeps running, so the
    // dashboard is still there to sign one in again.
    const last = await post(port, '/teamclaude/remove', { account: 'b@example.com' });
    assert.equal(last.status, 200);
    assert.deepEqual((await status(port)).accounts, []);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).accounts, []);
  });
});

test('a server with no accounts starts, serves the dashboard, and answers requests 503 until one arrives', async () => {
  // A stand-in upstream that counts what reaches it: nothing may, until an
  // account exists.
  let upstreamHits = 0;
  const upstream = createServer((req, res) => {
    upstreamHits++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', content: [] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(undefined)));
  const upstreamPort = /** @type {import('node:net').AddressInfo} */ (upstream.address()).port;
  /** @type {Awaited<ReturnType<typeof spawnServer>> | null} */
  let server = null;
  try {
    server = await spawnServer({
      config: () => ({
        proxy: { apiKey: 'tc-test' },
        upstream: `http://127.0.0.1:${upstreamPort}`,
        upstreamProxy: false,
        autoUpdate: false,
        // An empty pool must not be held: no window will ever bring an account back.
        holdSeconds: 600,
        accounts: [],
      }),
    });
    const { port, configPath } = server;
    assert.deepEqual((await status(port)).accounts, []);
    assert.match(server.output(), /No accounts configured yet/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/dashboard`)).status, 200);

    const request = path => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    for (const path of ['/v1/messages', '/backend-api/codex/responses']) {
      const res = await request(path);
      assert.equal(res.status, 503, path);
      assert.match((await res.json()).error.message, /no accounts yet/, path);
    }
    assert.equal(upstreamHits, 0);

    // An account added while it runs is used without a restart.
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    disk.accounts = [{ name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }];
    await writeFile(configPath, JSON.stringify(disk));
    assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' })).status, 200);
    assert.deepEqual((await status(port)).accounts.map(a => a.name), ['a@example.com']);
    const after = await request('/v1/messages');
    assert.equal(after.status, 200);
    assert.equal(upstreamHits, 1);
  } finally {
    await server?.stop();
    await new Promise(resolve => upstream.close(() => resolve(undefined)));
  }
});

test('a dashboard sign-in is the server\'s own Claude flow, and Cancel ends it', async () => {
  await withServer(async ({ port, output }) => {
    const start = await post(port, '/teamclaude/login/start', { provider: 'claude' });
    assert.equal(start.status, 200);
    const started = await start.json();
    assert.equal(new URL(started.url).searchParams.get('redirect_uri'), 'https://console.anthropic.com/oauth/code/callback',
      'the link that works from any device ends on the code page');
    assert.match(new URL(started.browserUrl).searchParams.get('redirect_uri'), /^http:\/\/localhost:\d+\/callback$/,
      'and the loopback link is there for a page opened on this machine');
    assert.equal(started.listening, true);

    const cancel = await (await post(port, '/teamclaude/login/cancel', { id: started.id })).json();
    assert.equal(cancel.cancelled, true);
    // The abort settles the flow in microtasks, before the cancel is answered.
    assert.equal((await (await post(port, '/teamclaude/login/status', { id: started.id })).json()).state, 'cancelled');

    const logs = await fetch(`http://127.0.0.1:${port}/teamclaude/logs`).then(r => r.json());
    const steps = logs.events.filter(e => e.kind === 'signin').map(e => e.type);
    assert.deepEqual(steps, ['signin_started', 'signin_cancelled']);
    assert.doesNotMatch(output(), /Could not open a browser|Opening browser/, 'nothing was opened on the host');
  });
});
