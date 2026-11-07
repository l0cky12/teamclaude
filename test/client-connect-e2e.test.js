import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnServer } from '../test-helpers/spawn-server.js';
import { localCallerRefusal } from '../src/server.js';

// The real server, headless, with a home directory of its own: the dashboard's
// Connect your tools card reads and writes the settings files of the user the
// proxy runs as, so these must never be the real ones.

const OPERATOR = 'tc-operator';
const CLIENT_KEY = 'tc-client-laptop';

/**
 * One request with full control over the headers (fetch will not send a Host
 * of the caller's choosing).
 * @returns {Promise<{ status: number, body: any }>}
 */
function call(port, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/teamclaude/clients/connect',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withServer(fn) {
  const home = await mkdtemp(join(tmpdir(), 'teamclaude-connect-home-'));
  let server = null;
  try {
    server = await spawnServer({
      config: () => ({
        proxy: { apiKey: OPERATOR, clientKeys: [{ name: 'laptop', key: CLIENT_KEY }] },
        upstreamProxy: false,
        autoUpdate: false,
        accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }],
      }),
      env: { HOME: home, SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), XDG_CONFIG_HOME: join(home, '.config') },
    });
    await fn(server, home);
  } finally {
    if (server) await server.stop();
    await rm(home, { recursive: true, force: true });
  }
}

test('from this machine the card reads every client, and connect writes their settings', async () => {
  await withServer(async ({ port }, home) => {
    const before = await call(port, 'GET');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body.clients.map(c => [c.id, c.state, c.where]), [
      ['claude', 'disconnected', join(home, '.claude', 'settings.json')],
      ['codex', 'disconnected', join(home, '.codex', 'config.toml')],
      ['grok', 'disconnected', join(home, '.bashrc')],
    ]);

    const after = await call(port, 'POST', { clients: ['claude', 'codex', 'grok'], action: 'connect' });
    assert.equal(after.status, 200);
    assert.equal(after.body.ok, true);
    assert.deepEqual(after.body.errors, []);
    assert.deepEqual(after.body.clients.map(c => c.state), ['connected', 'connected', 'connected']);

    const origin = `http://127.0.0.1:${port}`;
    assert.equal(JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).env.ANTHROPIC_BASE_URL, origin);
    assert.match(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), new RegExp(`base_url = "${origin}/backend-api/codex"`));
    assert.match(await readFile(join(home, '.bashrc'), 'utf8'), new RegExp(`GROK_CLI_CHAT_PROXY_BASE_URL='${origin}/grok/v1'`));

    const off = await call(port, 'POST', { clients: ['codex'], action: 'disconnect' });
    assert.deepEqual(off.body.clients.map(c => [c.id, c.state]), [['codex', 'disconnected']]);
    assert.equal(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), '');
  });
});

test('a caller off this machine is refused even with the operator key, and so is a client key', async () => {
  await withServer(async ({ port }, home) => {
    // A forwarding header is how a caller through a reverse proxy or a port
    // mapping looks from here: not this machine.
    const forwarded = await call(port, 'POST', { clients: ['claude'], action: 'connect' }, { 'x-api-key': OPERATOR, 'x-forwarded-for': '203.0.113.5' });
    assert.equal(forwarded.status, 403);
    assert.match(forwarded.body.error, /machine the proxy runs on/);
    assert.equal((await call(port, 'GET', undefined, { 'x-api-key': OPERATOR, 'x-forwarded-for': '203.0.113.5' })).status, 403);

    // A page rebound to 127.0.0.1 carries its own name in Host.
    const rebound = await call(port, 'POST', { clients: ['claude'], action: 'connect' }, { 'x-api-key': OPERATOR, host: 'attacker.example' });
    assert.equal(rebound.status, 403);

    const crossOrigin = await call(port, 'POST', { clients: ['claude'], action: 'connect' }, { origin: 'https://attacker.example' });
    assert.equal(crossOrigin.status, 403);

    const tenant = await call(port, 'POST', { clients: ['claude'], action: 'connect' }, { 'x-api-key': CLIENT_KEY });
    assert.equal(tenant.status, 403);
    assert.equal((await call(port, 'GET', undefined, { 'x-api-key': CLIENT_KEY })).status, 403);

    await assert.rejects(readFile(join(home, '.claude', 'settings.json')), { code: 'ENOENT' });
  });
});

test('a body that does not say what to do is refused', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await call(port, 'POST', { clients: ['claude'], action: 'erase' })).status, 400);
    assert.equal((await call(port, 'POST', { clients: [], action: 'connect' })).status, 400);
    assert.equal((await call(port, 'POST', { clients: ['cursor'], action: 'connect' })).status, 400);
  });
});

test('the local-caller check: a non-loopback peer is refused whatever it sends', () => {
  assert.equal(localCallerRefusal({ host: '127.0.0.1:3456' }, '192.168.1.5', {}, null, 'not here'), 'not here');
  assert.equal(localCallerRefusal({ host: '127.0.0.1:3456' }, '127.0.0.1', { trustLoopback: false }, null, 'not here'), 'not here');
  assert.equal(localCallerRefusal({ host: '127.0.0.1:3456' }, '127.0.0.1', {}, null, 'not here'), null);
});
