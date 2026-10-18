// POST /teamclaude/login/{start,finish,cancel} through the real request
// handler: who may reach them (the operator only), what each answers over
// HTTP, what /teamclaude/status tells the page about them, and a server that
// starts with no accounts so the first can be signed in from the dashboard.
// The flows are the real paste-only ones with the token endpoint stubbed, and
// the save is a stub hook: nothing here reaches a provider or a real config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, signInRefusal } from '../src/server.js';
import { WebLogins, startWebFlow, WEB_LOGIN_TIMEOUT_MS } from '../src/web-login.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

const PROXY_KEY = 'tc-test-operator';
const CLIENT_KEY = 'tc-test-client';
const LOGIN_PATHS = ['/teamclaude/login/start', '/teamclaude/login/finish', '/teamclaude/login/cancel'];
const START = 1_000_000_000_000;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/**
 * An in-process server over a fake clock, stubbed flows and recording hooks.
 * @param {{ proxy?: any, accounts?: any[], hooks?: any }} opts
 * @param {(ctx: any) => Promise<void>} fn
 */
async function withServer({ proxy = { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] }, accounts = [], hooks } = {}, fn) {
  const config = { proxy, upstream: 'http://127.0.0.1:9', accounts };
  const am = new AccountManager(accounts, 0.98);
  const clock = { now: START };
  /** @type {any[]} */
  const saved = [];
  let reloads = 0;
  const h = hooks ?? {
    saveWebSignIn: async (/** @type {any} */ signIn) => { saved.push(signIn); return { action: 'added', name: signIn.name ?? 'account-1' }; },
    reload: async () => { reloads++; return { added: 1, removed: 0 }; },
  };
  const webLogins = new WebLogins({
    hooks: h, events: am.events, accounts: () => am.accounts, configAccounts: () => config.accounts,
    now: () => clock.now, timer: false,
    startFlow: (provider, opts) => startWebFlow(provider, {
      ...opts,
      exchange: async () => (provider === 'codex'
        ? { accessToken: 'fake-codex-access', refreshToken: 'fake-codex-refresh', expiresAt: 0, accountId: 'chatgpt-acct-1' }
        : { accessToken: 'fake-claude-access', refreshToken: 'fake-claude-refresh', expiresAt: 0 }),
    }),
  });
  const server = createProxyServer(am, config, h, null, null, null, { webLogins });
  const port = await listen(server);
  try {
    await fn({ port, am, clock, saved, webLogins, reloads: () => reloads });
  } finally {
    server.close();
  }
}

// The request the page sends: a same-origin browser POST.
const post = (/** @type {number} */ port, /** @type {string} */ path, /** @type {any} */ body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const caller = async (/** @type {number} */ port, headers = {}) =>
  (await (await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers })).json()).caller;

/** @param {string} url */
const claudePaste = url => `test-code#${new URL(url).searchParams.get('state')}`;

test('start, a bad paste, a good one: the HTTP contract the page relies on', async () => {
  await withServer({}, async ({ port, saved, reloads, am }) => {
    const auth = { 'x-api-key': PROXY_KEY };
    const start = await post(port, '/teamclaude/login/start', { provider: 'claude', name: 'laptop' }, auth);
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const { ok, id, provider, url, expiresAt } = await start.json();
    assert.deepEqual([ok, provider, expiresAt], [true, 'claude', START + WEB_LOGIN_TIMEOUT_MS]);

    const bad = await post(port, '/teamclaude/login/finish', { id, input: 'test-code#another-attempt' }, auth);
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.retry, true);
    assert.equal(badBody.ok, false);

    const good = await post(port, '/teamclaude/login/finish', { id, input: claudePaste(url) }, auth);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { ok: true, account: 'laptop', action: 'added' });
    assert.equal(saved.length, 1);
    assert.equal(reloads(), 1);

    const unknown = await post(port, '/teamclaude/login/finish', { id, input: claudePaste(url) }, auth);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).ok, false);

    // The sign-in is on the log the dashboard's Logs page reads.
    const log = await (await fetch(`http://127.0.0.1:${port}/teamclaude/logs`, { headers: auth })).json();
    assert.deepEqual(log.events.map((/** @type {any} */ e) => e.type), ['signin_started', 'signin_succeeded']);
    assert.equal(am.events.since(0).events.at(-1)?.account, 'laptop');
  });
});

// The dashboard at http://<tailscale-ip>:port: browsers send no fetch metadata
// to a plain-http address that is not localhost, only Origin. The proxy key
// and an Origin naming this very host are what let the sign-in through.
test('a sign-in from a browser on a plain-http address works with the proxy key, and only with it', async () => {
  await withServer({}, async ({ port }) => {
    const plain = (/** @type {Record<string, string>} */ headers) => fetch(`http://127.0.0.1:${port}/teamclaude/login/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers },
      body: JSON.stringify({ provider: 'claude' }),
    });
    const keyed = await plain({ 'x-api-key': PROXY_KEY });
    assert.equal(keyed.status, 200, await keyed.text());
    assert.equal((await plain({})).status, 403, 'no key: a page could have sent it');
    assert.equal((await plain({ 'x-api-key': CLIENT_KEY })).status, 403, 'a client key may not sign in');
  });
});

test('cancel over HTTP, and a body that is not JSON', async () => {
  await withServer({}, async ({ port, am }) => {
    const auth = { 'x-api-key': PROXY_KEY };
    const { id } = await (await post(port, '/teamclaude/login/start', { provider: 'codex' }, auth)).json();
    const cancel = await post(port, '/teamclaude/login/cancel', { id }, auth);
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { ok: true });
    assert.equal(am.events.since(0).events.at(-1)?.type, 'signin_cancelled');
    assert.equal((await post(port, '/teamclaude/login/cancel', { id }, auth)).status, 404);
    assert.equal((await post(port, '/teamclaude/login/start', 'not json', auth)).status, 400);
    assert.equal((await post(port, '/teamclaude/login/start', 'null', auth)).status, 400, 'no provider');
  });
});

test('a client key is refused all three routes before any hook runs, and status says so', async () => {
  await withServer({}, async ({ port, saved, webLogins }) => {
    for (const path of LOGIN_PATHS) {
      const res = await post(port, path, { provider: 'claude' }, { 'x-api-key': CLIENT_KEY });
      assert.equal(res.status, 403, path);
      assert.deepEqual(await res.json(), { ok: false, error: 'a client key cannot sign accounts in' });
    }
    assert.equal(webLogins.pending.size, 0);
    assert.equal(saved.length, 0);

    const client = await caller(port, { 'x-api-key': CLIENT_KEY });
    assert.equal(client.signIn, false);
    for (const path of LOGIN_PATHS) assert.ok(client.refused.includes(path), path);
    // The operator, by key or as a key-exempt loopback caller, may sign in.
    assert.equal((await caller(port, { 'x-api-key': PROXY_KEY })).signIn, true);
    assert.equal((await caller(port)).signIn, true);
  });
});

test('with no key configured, sign-in is for this machine only', async () => {
  await withServer({ proxy: {} }, async ({ port }) => {
    // A key-less caller on this machine is the operator.
    assert.equal((await caller(port)).signIn, true);
    const local = await post(port, '/teamclaude/login/start', { provider: 'claude' });
    assert.equal(local.status, 200);

    // Through a reverse proxy the peer is loopback but the caller is not. The
    // key gate admits everyone here, so this route has to refuse it itself.
    const forwarded = { 'x-forwarded-for': '203.0.113.7' };
    const remote = await post(port, '/teamclaude/login/start', { provider: 'claude' }, forwarded);
    assert.equal(remote.status, 403);
    assert.match((await remote.json()).error, /set proxy\.apiKey to sign in from another machine/);
    assert.equal((await caller(port, forwarded)).signIn, false);
  });
});

test('signInRefusal: the operator, by key or on this machine, and nobody else', () => {
  const localHost = { host: 'localhost:3456' };
  const keyless = {};
  const keyed = { apiKey: PROXY_KEY };
  // Key-less: only a loopback peer with no forwarding header and a local Host.
  assert.equal(signInRefusal(null, localHost, '127.0.0.1', keyless), null);
  assert.match(String(signInRefusal(null, localHost, '203.0.113.7', keyless)), /only from this machine/);
  assert.match(String(signInRefusal(null, { ...localHost, 'x-real-ip': '203.0.113.7' }, '127.0.0.1', keyless)), /only from this machine/);
  assert.match(String(signInRefusal(null, localHost, '127.0.0.1', { trustLoopback: false })), /only from this machine/);
  assert.match(String(signInRefusal(null, { host: 'attacker.example' }, '127.0.0.1', keyless)), /Host header/);
  // Keyed: the key gate has decided; a client key is refused whatever its address.
  assert.equal(signInRefusal(null, localHost, '203.0.113.7', keyed), null);
  assert.equal(signInRefusal('ci', localHost, '127.0.0.1', keyed), 'a client key cannot sign accounts in');
});

test('a server without the save hook answers 501 and starts nothing', async () => {
  await withServer({ hooks: { reload: async () => ({}) } }, async ({ port, webLogins }) => {
    const res = await post(port, '/teamclaude/login/start', { provider: 'claude' }, { 'x-api-key': PROXY_KEY });
    assert.equal(res.status, 501);
    assert.equal(webLogins.pending.size, 0);
  });
});

test('the routes answer under /teamrouter/ too, and only to POST', async () => {
  await withServer({}, async ({ port }) => {
    const res = await post(port, '/teamrouter/login/start', { provider: 'codex' }, { 'x-api-key': PROXY_KEY });
    assert.equal(res.status, 200);
    const get = await fetch(`http://127.0.0.1:${port}/teamclaude/login/start`, { headers: { 'x-api-key': PROXY_KEY } });
    assert.equal(get.status, 404);
  });
});

// The real server, started with no accounts at all.
const emptyConfig = () => ({ proxy: { apiKey: PROXY_KEY }, upstream: 'http://127.0.0.1:9', upstreamProxy: false, accounts: [] });

test('server --allow-empty starts with no accounts, refuses requests clearly, and a reload brings the first in', async () => {
  const server = await spawnServer({ config: emptyConfig, args: ['--allow-empty'], env: { TEAMCLAUDE_ALLOW_EMPTY: undefined, TEAMROUTER_ALLOW_EMPTY: undefined } });
  try {
    const auth = { 'x-api-key': PROXY_KEY };
    const base = `http://127.0.0.1:${server.port}`;
    const status = await (await fetch(`${base}/teamclaude/status`, { headers: auth })).json();
    assert.equal(status.accounts.length, 0);
    assert.equal(status.caller.signIn, true);

    const refused = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error.message, /no accounts are configured yet/);

    // A sign-in can start with nothing in the pool.
    const start = await fetch(`${base}/teamclaude/login/start`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'claude' }),
    });
    assert.equal(start.status, 200);

    // What a finished sign-in leaves behind: a row on disk, then the reload.
    // (The save itself is index.js's upsert, which needs the provider; the
    // reload taking a first account into an empty pool is what is checked.)
    const disk = JSON.parse(await readFile(server.configPath, 'utf8'));
    disk.accounts = [{ name: 'first', type: 'apikey', apiKey: 'fake-key-1' }];
    await writeFile(server.configPath, JSON.stringify(disk));
    const reload = await fetch(`${base}/teamclaude/reload`, { method: 'POST', headers: auth });
    assert.equal(reload.status, 200);
    assert.equal((await reload.json()).added, 1);
    const after = await (await fetch(`${base}/teamclaude/status`, { headers: auth })).json();
    assert.deepEqual(after.accounts.map((/** @type {any} */ a) => a.name), ['first']);
  } finally {
    await server.stop();
    await rm(server.dir, { recursive: true, force: true });
  }
});

test('TEAMCLAUDE_ALLOW_EMPTY=1 does the same, and without either an empty pool still exits', async () => {
  // An undefined value leaves the variable out of the child's environment, so
  // one exported in the developer's shell cannot decide either case: the
  // TEAMROUTER_ spelling wins over TEAMCLAUDE_ whenever it is set.
  const viaEnv = await spawnServer({ config: emptyConfig, env: { TEAMCLAUDE_ALLOW_EMPTY: '1', TEAMROUTER_ALLOW_EMPTY: undefined } });
  try {
    const status = await (await fetch(`http://127.0.0.1:${viaEnv.port}/teamclaude/status`, { headers: { 'x-api-key': PROXY_KEY } })).json();
    assert.equal(status.accounts.length, 0);
  } finally {
    await viaEnv.stop();
    await rm(viaEnv.dir, { recursive: true, force: true });
  }

  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-web-login-'));
  try {
    await assert.rejects(
      spawnServer({ config: emptyConfig, dir, env: { TEAMCLAUDE_ALLOW_EMPTY: undefined, TEAMROUTER_ALLOW_EMPTY: undefined } }),
      /No accounts configured[\s\S]*--allow-empty/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
