import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { WebAccountSync, AccountSyncError } from '../src/web-account-sync.js';

// /teamclaude/account-sync is what the dashboard's Account sync card sends:
// the GET of whether this install syncs with callback.net and as whom, and
// start, status, cancel, sync and sign-out. Operator only, and reachable on a
// linked instance through the relay, which is how one dashboard sets up every
// machine. The end-to-end test runs the real poll-token sign-in against a
// stand-in for callback.net, with the token file under a throwaway config.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];
const CLIENT = 'oaap-test00-aaaa-bbbb-cccc-dddddddd';

function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });
}

/** A proxy with the given hooks and config, closed after `fn`. */
async function withServer(fn, { hooks = {}, proxy = { apiKey: 'tc-local' }, peers } = {}) {
  const config = { proxy: { port: 3, ...proxy }, upstream: 'https://api.anthropic.com', ...(peers ? { peers } : {}) };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), config, hooks);
  const port = await listen(server);
  try {
    await fn({ port });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

/** A stand-in for the running CredentialSync. */
function fakeCredentialSync() {
  const passes = [];
  return {
    passes,
    summary: () => ({ lastSyncAt: null, lastError: null, rows: 2, tombstones: 0, signInNeeded: 0 }),
    sync: async (reason) => { passes.push(reason); return { signedIn: true, adopted: 1, added: 0 }; },
  };
}

test('a client key can neither read nor drive account sync', async () => {
  const proxy = { apiKey: 'tc-local', clientKeys: [{ name: 'laptop', key: 'tc-client' }] };
  const accountSync = { view: async () => ({ signedIn: true }), start: async () => ({ id: 'x', url: 'https://x.example/a' }) };
  await withServer(async ({ port }) => {
    const get = await fetch(`http://127.0.0.1:${port}/teamclaude/account-sync`, { headers: { 'x-api-key': 'tc-client' } });
    assert.equal(get.status, 403);
    assert.match((await get.json()).error, /client key cannot manage account sync/);
    for (const step of ['start', 'status', 'cancel', 'sync', 'sign-out']) {
      const res = await post(port, `/teamclaude/account-sync/${step}`, { id: 'x' }, { 'x-api-key': 'tc-client' });
      assert.equal(res.status, 403, step);
      assert.match((await res.json()).error, /client key cannot manage account sync/, step);
    }
    // The proxy key reads it.
    const ok = await fetch(`http://127.0.0.1:${port}/teamclaude/account-sync`, { headers: { 'x-api-key': 'tc-local' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, signedIn: true });
  }, { proxy, hooks: { accountSync } });
});

test('the status read tells the page to hide the card from a client key', async () => {
  const proxy = { apiKey: 'tc-local', clientKeys: [{ name: 'laptop', key: 'tc-client' }] };
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'tc-client' } });
    const { caller } = await res.json();
    assert.ok(caller.refused.includes('/teamclaude/account-sync/start'));
  }, { proxy });
});

test('a server without the hook says it is not supported', async () => {
  await withServer(async ({ port }) => {
    const get = await fetch(`http://127.0.0.1:${port}/teamclaude/account-sync`, { headers: { 'x-api-key': 'tc-local' } });
    assert.equal(get.status, 501);
    const res = await post(port, '/teamclaude/account-sync/start', {}, { 'x-api-key': 'tc-local' });
    assert.equal(res.status, 501);
  });
});

test('a refusal reaches the page as 400, and a callback.net failure as 502 with the reason', async () => {
  const accountSync = {
    start: async () => { throw new AccountSyncError('already signed in to callback.net; sign out first'); },
    syncNow: async () => { throw new Error('callback.net API error (HTTP 503)'); },
    status: () => ({ state: 'unknown' }),
  };
  await withServer(async ({ port }) => {
    const refused = await post(port, '/teamclaude/account-sync/start', {}, { 'x-api-key': 'tc-local' });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /sign out first/);
    const failed = await post(port, '/teamclaude/account-sync/sync', {}, { 'x-api-key': 'tc-local' });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /^callback\.net: .*HTTP 503/);
    const noId = await post(port, '/teamclaude/account-sync/status', {}, { 'x-api-key': 'tc-local' });
    assert.equal(noId.status, 400);
  }, { hooks: { accountSync } });
});

test('a linked instance is signed in through the relay', async () => {
  const calls = [];
  const remote = {
    view: async () => ({ signedIn: false, user: null, userError: null, sync: {}, signIn: null }),
    start: async () => { calls.push('start'); return { id: 'abc', url: 'https://oid.jp/XYZ', lifetimeSeconds: 900 }; },
    status: (id) => { calls.push('status:' + id); return { state: 'waiting', error: null }; },
    cancel: (id) => { calls.push('cancel:' + id); return true; },
    syncNow: async () => ({ signedIn: true }),
    signOut: async () => ({ wasSignedIn: true, revoked: true }),
  };
  await withServer(async ({ port: remotePort }) => {
    const peers = [{ name: 'server', url: `http://127.0.0.1:${remotePort}`, apiKey: 'tc-remote' }];
    await withServer(async ({ port }) => {
      const h = { 'x-api-key': 'tc-local' };
      const view = await fetch(`http://127.0.0.1:${port}/teamclaude/peers/server/account-sync`, { headers: h });
      assert.equal(view.status, 200);
      assert.equal((await view.json()).signedIn, false);
      const start = await post(port, '/teamclaude/peers/server/account-sync/start', {}, h);
      assert.deepEqual(await start.json(), { ok: true, id: 'abc', url: 'https://oid.jp/XYZ', lifetimeSeconds: 900 });
      await post(port, '/teamclaude/peers/server/account-sync/status', { id: 'abc' }, h);
      const cancel = await post(port, '/teamclaude/peers/server/account-sync/cancel', { id: 'abc' }, h);
      assert.deepEqual(await cancel.json(), { ok: true, cancelled: true, state: 'waiting' }, 'the state after the cancel rides along');
      const out = await post(port, '/teamclaude/peers/server/account-sync/sign-out', {}, h);
      assert.deepEqual(await out.json(), { ok: true, wasSignedIn: true, revoked: true });
      assert.deepEqual(calls, ['start', 'status:abc', 'cancel:abc', 'status:abc']);
    }, { peers });
  }, { proxy: { apiKey: 'tc-remote' }, hooks: { accountSync: remote } });
});

/** The stand-in callback.net API: approves the first poll. */
async function mockCallbackApi() {
  const seen = [];
  const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname.replace('/_special/rest/', '');
      seen.push(path);
      if (path === `OAuth2/App/${CLIENT}:token_create`) return json(res, { result: 'success', data: { polltoken: 'poll-1', lifetime: 900 } });
      if (path === `OAuth2/App/${CLIENT}:token_poll`) return json(res, { result: 'success', data: { response: { code: 'code-1' } } });
      if (path === 'OAuth2:token') return json(res, { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 });
      if (path === 'OAuth2:me') return json(res, { sub: 'u-1', email: 'me@example.com', name: 'Me' });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'error', error: 'not found' }));
    });
  });
  return { server, seen, base: `http://127.0.0.1:${await listen(server)}` };
}

test('end to end: start, approve at callback.net, the token is saved and a pass runs', async () => {
  const api = await mockCallbackApi();
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-account-sync-'));
  const vars = ['TEAMCLAUDE_CONFIG', 'TEAMROUTER_CONFIG', 'TEAMROUTER_CALLBACK_API_BASE', 'TEAMCLAUDE_CALLBACK_API_BASE', 'TEAMROUTER_CALLBACK_CLIENT_ID', 'TEAMCLAUDE_CALLBACK_CLIENT_ID'];
  const saved = Object.fromEntries(vars.map(v => [v, process.env[v]]));
  for (const v of vars) delete process.env[v];
  process.env.TEAMCLAUDE_CONFIG = join(dir, 'config.json');
  process.env.TEAMROUTER_CONFIG = join(dir, 'config.json');
  process.env.TEAMROUTER_CALLBACK_API_BASE = api.base;
  process.env.TEAMROUTER_CALLBACK_CLIENT_ID = CLIENT;
  const credentialSync = fakeCredentialSync();
  try {
    await withServer(async ({ port }) => {
      const h = { 'x-api-key': 'tc-local' };
      const before = await (await fetch(`http://127.0.0.1:${port}/teamclaude/account-sync`, { headers: h })).json();
      assert.equal(before.signedIn, false);

      const start = await (await post(port, '/teamclaude/account-sync/start', {}, h)).json();
      assert.equal(start.ok, true);
      assert.ok(start.url.startsWith(`${api.base}/_rest/OAuth2:auth?`), start.url);
      assert.match(start.url, /redirect_uri=polltoken%3Apoll-1/);

      // The poll answers with the code at once; ask until the server says so.
      let st;
      for (let i = 0; i < 50; i++) {
        st = await (await post(port, '/teamclaude/account-sync/status', { id: start.id }, h)).json();
        if (st.state !== 'waiting' && st.state !== 'finishing') break;
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(st.state, 'succeeded');

      const file = JSON.parse(await readFile(join(dir, 'config.callback.json'), 'utf-8'));
      assert.equal(file.access_token, 'at-1');
      assert.equal(file.client_id, CLIENT);
      assert.deepEqual(credentialSync.passes, ['dashboard sign-in']);

      const after = await (await fetch(`http://127.0.0.1:${port}/teamclaude/account-sync`, { headers: h })).json();
      assert.equal(after.signedIn, true);
      assert.deepEqual(after.user, { email: 'me@example.com', name: 'Me' });
      assert.equal(after.sync.rows, 2);

      const again = await post(port, '/teamclaude/account-sync/start', {}, h);
      assert.equal(again.status, 400, 'a second sign-in is refused while signed in');
    }, { hooks: { accountSync: new WebAccountSync({ sync: credentialSync, log: () => {} }) } });
  } finally {
    api.server.close();
    for (const v of vars) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  }
});
