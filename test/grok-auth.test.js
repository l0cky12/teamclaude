// Grok credentials: reading Grok Build's auth.json, refreshing at xAI's token
// endpoint, and the device sign-in, each against files and servers made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGrokCredentials, refreshGrokToken, startGrokLogin } from '../src/grok-auth.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { AccountManager } from '../src/account-manager.js';
import { sameIdentity, distinctAccounts } from '../src/identity.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

const b64u = (/** @type {any} */ obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (/** @type {any} */ claims) => `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`;
const SCOPE_KEY = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';

/** @param {any} contents */
async function writeAuth(contents) {
  const home = await mkdtemp(join(tmpdir(), 'tc-grok-'));
  await mkdir(join(home, '.grok'), { recursive: true });
  await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify(contents));
  return home;
}

const entry = (/** @type {Record<string, any>} */ over = {}) => ({
  key: 'at-1', auth_mode: 'oidc', create_time: '2026-01-01T00:00:00Z', user_id: 'user-1', email: 'one@example.com',
  principal_type: 'User', principal_id: 'user-1', refresh_token: 'rt-1', expires_at: '2030-01-01T00:00:00Z',
  oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828', ...over,
});

test('reads the token, its expiry and the user from Grok Build\'s auth.json', async () => {
  const home = await writeAuth({ [SCOPE_KEY]: entry() });
  const creds = await importGrokCredentials('~/.grok/auth.json', { home });
  assert.deepEqual(creds, {
    accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.parse('2030-01-01T00:00:00Z'),
    userId: 'user-1', email: 'one@example.com',
  });
});

test('Grok Build\'s own entry wins, and an older entry with a token is still read', async () => {
  const both = await writeAuth({
    'https://accounts.x.ai/sign-in': { key: 'legacy-at' },
    [SCOPE_KEY]: entry({ key: 'oidc-at' }),
  });
  assert.equal((await importGrokCredentials('~/.grok/auth.json', { home: both })).accessToken, 'oidc-at');

  const legacy = await writeAuth({ 'https://accounts.x.ai/sign-in': { key: 'legacy-at', user_id: 'user-9' } });
  const creds = await importGrokCredentials('~/.grok/auth.json', { home: legacy });
  assert.equal(creds.accessToken, 'legacy-at');
  assert.equal(creds.userId, 'user-9');
  assert.equal(creds.refreshToken, undefined);
});

test('a file with no entry holding a token yields no access token', async () => {
  const home = await writeAuth({ [SCOPE_KEY]: { email: 'x@example.com' } });
  assert.equal((await importGrokCredentials('~/.grok/auth.json', { home })).accessToken, undefined);
});

test('an importFrom Grok account takes its credentials from the file and keeps its config', async () => {
  const home = await writeAuth({ [SCOPE_KEY]: entry() });
  const path = join(home, '.grok', 'auth.json');
  const [acct] = await resolveAccounts({ accounts: [{ name: 'grok-a', type: 'oauth', provider: 'grok', importFrom: path, priority: 2 }] });
  assert.equal(acct.accessToken, 'at-1');
  assert.equal(acct.userId, 'user-1');
  assert.equal(acct.priority, 2);
  assert.equal(acct.provider, 'grok');
});

test('two Grok logins are told apart by their xAI user', () => {
  const a = { name: 'a', provider: 'grok', type: 'oauth', userId: 'u-1' };
  assert.equal(sameIdentity(a, { name: 'renamed', provider: 'grok', userId: 'u-1' }), true);
  assert.equal(sameIdentity(a, { name: 'a', provider: 'grok', userId: 'u-2' }), false);
  assert.equal(sameIdentity(a, { name: 'a', provider: 'codex', userId: 'u-1' }), false);
});

/**
 * A token server that answers each POST from `replies` in turn and records
 * the forms it was sent.
 * @param {Array<{ status: number, body: any }>} replies
 */
async function tokenServer(replies) {
  /** @type {Array<{ path: string, form: Record<string, string>, type: string }>} */
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      seen.push({ path: req.url || '', form: Object.fromEntries(new URLSearchParams(raw)), type: String(req.headers['content-type']) });
      const reply = replies.shift() || { status: 500, body: { error: 'unexpected' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise(resolve => server.close(resolve)) };
}

test('a refresh is a form-encoded refresh_token grant with Grok Build\'s client, and a rotated token replaces the old', async () => {
  const srv = await tokenServer([{ status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } }]);
  try {
    const tokens = await refreshGrokToken('rt-1', `${srv.url}/oauth2/token`);
    assert.equal(tokens.accessToken, 'at-2');
    assert.equal(tokens.refreshToken, 'rt-2');
    assert.ok(tokens.expiresAt > Date.now());
    assert.match(srv.seen[0].type, /application\/x-www-form-urlencoded/);
    assert.deepEqual(srv.seen[0].form, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'b1a00492-073a-47ea-816f-4c329264a828' });
  } finally { await srv.close(); }
});

test('a rejected refresh carries its status, so a dead token reads as needing a login', async () => {
  const srv = await tokenServer([{ status: 400, body: { error: 'invalid_grant' } }]);
  try {
    await assert.rejects(refreshGrokToken('rt-dead', `${srv.url}/oauth2/token`), (/** @type {any} */ err) => err.status === 400);
  } finally { await srv.close(); }
});

test('the account manager refreshes a Grok account with the Grok refresh', async () => {
  /** @type {string[]} */
  const calls = [];
  const am = new AccountManager([{ name: 'g', type: 'oauth', provider: 'grok', accessToken: 'old', refreshToken: 'rt-g', expiresAt: Date.now() - 1000, userId: 'u' }], 0.98, {
    refreshFn: async () => { calls.push('anthropic'); throw new Error('wrong provider'); },
    codexRefreshFn: async () => { calls.push('codex'); throw new Error('wrong provider'); },
    grokRefreshFn: async (/** @type {string} */ rt) => { calls.push(`grok:${rt}`); return { accessToken: 'new', refreshToken: 'rt-g2', expiresAt: Date.now() + 3600_000 }; },
  });
  await am.ensureTokenFresh(0);
  assert.deepEqual(calls, ['grok:rt-g']);
  assert.equal(am.accounts[0].credential, 'new');
  assert.equal(am.accounts[0].refreshToken, 'rt-g2');
});

test('a device sign-in shows the code, waits out pending and slow_down, and returns the user it signed in', async () => {
  const srv = await tokenServer([
    { status: 200, body: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://accounts.example/device', expires_in: 900, interval: 5 } },
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    { status: 200, body: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 900, id_token: jwt({ sub: 'user-42', email: 'g@example.com' }) } },
  ]);
  try {
    /** @type {number[]} */
    const waits = [];
    const flow = await startGrokLogin({
      deviceEndpoint: `${srv.url}/oauth2/device/code`, tokenEndpoint: `${srv.url}/oauth2/token`,
      wait: async (ms) => { waits.push(ms); },
    });
    assert.equal(flow.userCode, 'ABCD-1234');
    assert.equal(flow.url, 'https://accounts.example/device?user_code=ABCD-1234');
    const creds = await flow.credentials;
    assert.deepEqual({ ...creds, expiresAt: typeof creds.expiresAt },
      { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 'number', userId: 'user-42', email: 'g@example.com' });
    assert.equal(srv.seen[0].path, '/oauth2/device/code');
    assert.equal(srv.seen[0].form.client_id, 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.ok(srv.seen[0].form.scope.split(' ').includes('grok-cli:access'));
    assert.ok(srv.seen[0].form.scope.split(' ').includes('offline_access'));
    assert.deepEqual(srv.seen[1].form, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dev-1', client_id: 'b1a00492-073a-47ea-816f-4c329264a828' });
    // The interval grows by five seconds after slow_down.
    assert.deepEqual(waits, [5000, 5000, 10000]);
  } finally { await srv.close(); }
});

test('a refused device sign-in fails with the reason, and the issuer\'s own complete link is used', async () => {
  const srv = await tokenServer([
    { status: 200, body: { device_code: 'dev-2', user_code: 'WXYZ', verification_uri: 'https://accounts.example/device', verification_uri_complete: 'https://accounts.example/device?code=WXYZ' } },
    { status: 400, body: { error: 'access_denied' } },
  ]);
  try {
    const flow = await startGrokLogin({ deviceEndpoint: `${srv.url}/d`, tokenEndpoint: `${srv.url}/t`, wait: async () => {} });
    assert.equal(flow.url, 'https://accounts.example/device?code=WXYZ');
    await assert.rejects(flow.credentials, /refused/);
  } finally { await srv.close(); }
});

test('a device code reply with a page that is not http(s) is refused before anything is shown', async () => {
  const srv = await tokenServer([{ status: 200, body: { device_code: 'd', user_code: 'AB', verification_uri: 'javascript:alert(1)' } }]);
  try {
    await assert.rejects(startGrokLogin({ deviceEndpoint: `${srv.url}/d`, tokenEndpoint: `${srv.url}/t`, wait: async () => {} }), /usable/);
  } finally { await srv.close(); }
});

test('a cancelled device sign-in stops polling', async () => {
  const srv = await tokenServer([{ status: 200, body: { device_code: 'd', user_code: 'AB', verification_uri: 'https://accounts.example/device' } }]);
  try {
    const controller = new AbortController();
    const flow = await startGrokLogin({
      deviceEndpoint: `${srv.url}/d`, tokenEndpoint: `${srv.url}/t`, signal: controller.signal,
      wait: async (_ms, signal) => { controller.abort(); if (signal?.aborted) throw signal.reason; },
    });
    await assert.rejects(flow.credentials, (/** @type {any} */ err) => err?.name === 'AbortError');
    assert.equal(srv.seen.length, 1);
  } finally { await srv.close(); }
});

/**
 * An issuer that answers the device request, then stalls the way a dead
 * connection does: `body` sends the poll's headers and never finishes the
 * body, `headers` never answers at all, and `start` stalls the device request.
 * @param {'body'|'headers'|'start'} where
 */
async function stallingServer(where) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/d' && where !== 'start') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ device_code: 'd', user_code: 'AB', verification_uri: 'https://accounts.example/device', interval: 1 }));
      } else if (where === 'body') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.write('{"error":');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

for (const where of /** @type {const} */ (['body', 'headers'])) {
  test(`a device sign-in whose poll stalls (${where}) still ends at its deadline`, async () => {
    const srv = await stallingServer(where);
    try {
      const flow = await startGrokLogin({ deviceEndpoint: `${srv.url}/d`, tokenEndpoint: `${srv.url}/t`, timeoutMs: 200, wait: async () => {} });
      await assert.rejects(flow.credentials, /expired/);
    } finally { await srv.close(); }
  });
}

test('a device sign-in whose first request stalls ends at its deadline', async () => {
  const srv = await stallingServer('start');
  try {
    await assert.rejects(startGrokLogin({ deviceEndpoint: `${srv.url}/d`, tokenEndpoint: `${srv.url}/t`, timeoutMs: 200, wait: async () => {} }), /did not answer/);
  } finally { await srv.close(); }
});

test('only a Grok login is identified by its user id alone', () => {
  // A Codex record with no ChatGPT account id falls back to its name, as it did
  // before Grok: its user id says who signed in, not which plan the token is for.
  const a = { name: 'same', provider: 'codex', userId: 'u-1' };
  const b = { name: 'same', provider: 'codex', userId: 'u-2' };
  assert.equal(sameIdentity(a, b), true);
  assert.equal(distinctAccounts(a, b), false);
  const g = { name: 'same', provider: 'grok', userId: 'u-1' };
  assert.equal(distinctAccounts(g, { ...g, userId: 'u-2' }), true);
});
