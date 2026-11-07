import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDashboardLogin, hashPassword, setDashboardLogin, verifyPassword } from '../src/dashboard-login.js';
import { passwordLoginOutcome } from '../src/dashboard.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

// A browser on another machine: the proxy never lets a forwarded request
// through the loopback exemption, so these are held to the key gate.
const REMOTE = { 'x-forwarded-for': '203.0.113.5' };
const KEY = 'tc-operator-key';

test('a stored hash accepts its password and nothing else, and never holds it', async () => {
  const stored = await hashPassword('correct horse');
  assert.ok(!stored.includes('correct horse'));
  assert.equal(await verifyPassword(stored, 'correct horse'), true);
  assert.equal(await verifyPassword(stored, 'correct horsf'), false);
  assert.notEqual(await hashPassword('correct horse'), stored, 'salted');
  assert.equal(await verifyPassword('plain-text', 'plain-text'), false);
  assert.equal(await verifyPassword('scrypt$1073741824$8$1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA', 'x'), false, 'a cost that would hang the server is refused');
});

test('setDashboardLogin checks the username, the password length and the proxy key', async () => {
  const config = { proxy: { apiKey: KEY } };
  await assert.rejects(setDashboardLogin(config, { username: 'me', password: 'short' }), /at least 8/);
  await assert.rejects(setDashboardLogin(config, { username: '-me', password: 'long enough' }), /username/);
  await assert.rejects(setDashboardLogin({ proxy: {} }, { username: 'me', password: 'long enough' }), /proxy key/);
  assert.equal(await setDashboardLogin(config, { username: ' me ', password: 'long enough' }), 'me');
  assert.equal(/** @type {any} */ (config.proxy).dashboardLogin.username, 'me');
  assert.equal(await setDashboardLogin(config, { username: '', password: '' }), null);
  assert.equal(/** @type {any} */ (config.proxy).dashboardLogin, undefined);
});

test('wrong guesses lock the address out, longer each time, and a right one clears it', async () => {
  let clock = 0;
  const login = createDashboardLogin({ now: () => clock });
  const proxy = { apiKey: KEY, dashboardLogin: { username: 'me', passwordHash: await hashPassword('long enough') } };
  const wrong = { username: 'me', password: 'nope nope' };
  for (let i = 0; i < 5; i++) assert.equal((await login.attempt(proxy, 'a', wrong)).reason, 'wrong');
  assert.equal((await login.attempt(proxy, 'a', wrong)).reason, 'wrong', 'the sixth is still checked');
  const locked = await login.attempt(proxy, 'a', { username: 'me', password: 'long enough' });
  assert.equal(locked.reason, 'locked', 'even the right password waits out the lock');
  assert.equal(locked.retryAfterSec, 60);
  assert.equal((await login.attempt(proxy, 'b', { username: 'me', password: 'long enough' })).key, KEY, 'another address is not locked');

  clock += 60_000;
  assert.equal((await login.attempt(proxy, 'a', wrong)).reason, 'wrong');
  assert.equal((await login.attempt(proxy, 'a', wrong)).retryAfterSec, 120, 'the next lock is twice as long');

  clock += 120_000;
  assert.equal((await login.attempt(proxy, 'a', { username: 'me', password: 'long enough' })).key, KEY);
  for (let i = 0; i < 5; i++) assert.equal((await login.attempt(proxy, 'a', wrong)).reason, 'wrong', 'a success resets the count');
});

test('a wrong username fails like a wrong password', async () => {
  const login = createDashboardLogin();
  const proxy = { apiKey: KEY, dashboardLogin: { username: 'me', passwordHash: await hashPassword('long enough') } };
  assert.deepEqual(await login.attempt(proxy, 'a', { username: 'you', password: 'long enough' }), { key: null, reason: 'wrong' });
  assert.equal((await login.attempt({ apiKey: KEY }, 'a', { username: 'me', password: 'long enough' })).reason, 'unavailable');
  assert.equal((await login.attempt({ dashboardLogin: proxy.dashboardLogin }, 'a', { username: 'me', password: 'long enough' })).reason, 'unavailable', 'no proxy key to hand out');
});

test('passwordLoginOutcome turns each reply into the key or a line for the page', () => {
  assert.deepEqual(passwordLoginOutcome(200, { ok: true, key: 'tc-k' }), { key: 'tc-k' });
  assert.match(/** @type {any} */ (passwordLoginOutcome(401, { ok: false })).error, /Wrong username or password/);
  assert.match(/** @type {any} */ (passwordLoginOutcome(429, { ok: false, retryAfterSec: 120 })).error, /120 seconds/);
  assert.match(/** @type {any} */ (passwordLoginOutcome(404, { ok: false })).error, /no dashboard password/);
});

test('a remote browser sets the password with the key, then signs in with it and gets the key', async () => {
  const server = await spawnServer({
    config: () => ({
      proxy: { apiKey: KEY },
      upstreamProxy: false,
      autoUpdate: false,
      accounts: [{ name: 'demo-a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }],
    }),
  });
  try {
    const base = `http://127.0.0.1:${server.port}/teamclaude`;
    const post = (path, body, headers = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...REMOTE, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const methods = async () => (await (await fetch(`${base}/auth/methods`, { headers: REMOTE })).json()).password;

    assert.equal(await methods(), false);
    assert.equal((await post('/auth/login', { username: 'me', password: 'long enough' })).status, 404);
    assert.equal((await post('/dashboard-login', { username: 'me', password: 'long enough' })).status, 401, 'setting it needs the key');

    const set = await post('/dashboard-login', { username: 'me', password: 'long enough' }, { 'x-api-key': KEY });
    assert.equal(set.status, 200);
    assert.deepEqual(await set.json(), { ok: true, username: 'me' });
    const onDisk = JSON.parse(await readFile(server.configPath, 'utf8'));
    assert.equal(onDisk.proxy.dashboardLogin.username, 'me');
    assert.ok(!JSON.stringify(onDisk).includes('long enough'), 'the config holds a hash, not the password');
    assert.equal(await methods(), true);

    const status = await fetch(`${base}/status`, { headers: { ...REMOTE, 'x-api-key': KEY } });
    assert.equal((await status.json()).dashboardLogin, 'me');

    const wrong = await post('/auth/login', { username: 'me', password: 'not it at all' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).key, undefined);

    const crossSite = await post('/auth/login', { username: 'me', password: 'long enough' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);

    // The dashboard page on the server's address sends its own Origin.
    const ok = await post('/auth/login', { username: 'me', password: 'long enough' }, { origin: `http://127.0.0.1:${server.port}` });
    assert.equal(ok.status, 200);
    const { key } = await ok.json();
    assert.equal(key, KEY);
    const withKey = await fetch(`${base}/status`, { headers: { ...REMOTE, 'x-api-key': key } });
    assert.equal(withKey.status, 200, 'the key it hands out opens the dashboard');

    const off = await post('/dashboard-login', { username: '', password: '' }, { 'x-api-key': KEY });
    assert.deepEqual(await off.json(), { ok: true, username: null });
    assert.equal(await methods(), false);
    assert.equal((await post('/auth/login', { username: 'me', password: 'long enough' })).status, 404);
  } finally {
    await server.stop();
  }
});
