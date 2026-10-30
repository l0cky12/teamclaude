import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, callerView } from '../src/server.js';
import { WebSignIns } from '../src/web-login.js';
import { RemovalRefused } from '../src/account-removal.js';

// The dashboard's Sign in to Claude / Codex buttons and its Remove button call
// POST /teamclaude/login/{start,code,status,cancel} and POST /teamclaude/remove.
// The flow and the removal are hooks `teamclaude server` installs; what the
// server owns is the contract between them and the page, and the gates: these
// add and drop credentials, so a client key and a web page are both refused.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const PROXY_KEY = 'tc-test';
const CLIENT_KEY = 'tc-client';
const CONFIG = {
  proxy: { apiKey: PROXY_KEY, clientKeys: [{ name: 'ci', key: CLIENT_KEY }] },
  upstream: 'http://127.0.0.1:9',
};
// One email with a Claude login and a Codex login: the page sends the provider
// with the name, and the server must remove the one the button sat on.
const ACCTS = [
  { name: 'me@example.com', type: 'apikey', apiKey: 'k1' },
  { name: 'me@example.com', type: 'oauth', provider: 'codex', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  { name: 'other@example.com', type: 'apikey', apiKey: 'k2' },
];

async function withServer(hooks, fn) {
  const am = new AccountManager(ACCTS.map(a => ({ ...a })), 0.98);
  const proxy = createProxyServer(am, CONFIG, hooks);
  const port = await listen(proxy);
  try {
    await fn(port, am);
  } finally {
    proxy.close();
  }
}

// The request the page sends: a same-origin browser POST from loopback, which
// the key gate exempts.
const post = (port, path, body, headers = {}) =>
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

/** A real tracker over a flow the test settles by hand. */
function signInHooks() {
  const runs = [];
  const webSignIns = new WebSignIns({
    signIn: (provider, { signal, onPrompt }) => new Promise((resolve, reject) => {
      runs.push({ provider, resolve });
      signal.addEventListener('abort', () => { const e = new Error('cancelled'); e.name = 'AbortError'; reject(e); });
      onPrompt({ provider, url: 'https://example.invalid/authorize', browserUrl: null, remote: false, listening: true, note: null, submit: t => t === 'the-code' });
    }),
  });
  return { webSignIns, runs };
}

test('a dashboard sign-in: start, paste, and the status that names the account', async () => {
  const { webSignIns, runs } = signInHooks();
  await withServer({ webSignIns }, async (port) => {
    const start = await post(port, '/teamclaude/login/start', { provider: 'codex' });
    assert.equal(start.status, 200);
    const started = await start.json();
    assert.equal(started.ok, true);
    assert.equal(started.provider, 'codex');
    assert.equal(started.url, 'https://example.invalid/authorize');
    assert.equal(start.headers.get('cache-control'), 'no-store');

    const wrong = await post(port, '/teamclaude/login/code', { id: started.id, code: '' });
    assert.equal(wrong.status, 400, 'nothing pasted');
    const code = await post(port, '/teamclaude/login/code', { id: started.id, code: 'the-code' });
    assert.equal(code.status, 200);

    runs[0].resolve({ name: 'me@example.com', action: 'updated' });
    await new Promise(resolve => setImmediate(resolve));
    const status = await (await post(port, '/teamclaude/login/status', { id: started.id })).json();
    assert.deepEqual(status, { ok: true, state: 'succeeded', provider: 'codex', account: 'me@example.com', action: 'updated', error: null, fileBacked: false });
  });
});

test('a sign-in can be cancelled, and an unknown id is said to be unknown', async () => {
  const { webSignIns } = signInHooks();
  await withServer({ webSignIns }, async (port) => {
    const { id } = await (await post(port, '/teamclaude/login/start', { provider: 'claude' })).json();
    assert.deepEqual(await (await post(port, '/teamclaude/login/cancel', { id })).json(), { ok: true, cancelled: true });
    assert.equal((await (await post(port, '/teamclaude/login/status', { id: 'nope' })).json()).state, 'unknown');
    assert.equal((await post(port, '/teamclaude/login/status', {})).status, 400, 'missing id');
  });
});

test('a sign-in for a provider the dashboard does not sign in is a 400', async () => {
  const { webSignIns, runs } = signInHooks();
  await withServer({ webSignIns }, async (port) => {
    const res = await post(port, '/teamclaude/login/start', { provider: 'deepseek' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /claude.*codex/);
    assert.equal(runs.length, 0);
  });
});

test('a flow that breaks before it starts is a 500 whose reason stays in the log', async () => {
  const webSignIns = new WebSignIns({ signIn: async () => { throw new Error('upstream said {"secret":"x"}'); } });
  await withServer({ webSignIns }, async (port) => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      const res = await post(port, '/teamclaude/login/start', { provider: 'claude' });
      assert.equal(res.status, 500);
      assert.doesNotMatch(JSON.stringify(await res.json()), /secret/);
    } finally {
      console.error = orig;
    }
    assert.ok(errors.some(e => /secret/.test(e)), 'the reason is logged');
  });
});

test('remove takes the account the provider names, not its namesake', async () => {
  const calls = [];
  const removeAccount = async (account) => { calls.push(account); return { name: 'me@example.com', provider: 'codex', persisted: true }; };
  await withServer({ removeAccount }, async (port, am) => {
    const res = await post(port, '/teamclaude/remove', { account: 'me@example.com', provider: 'codex' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'me@example.com', provider: 'codex', persisted: true });
    // The account object itself, so a reload that runs first cannot shift it.
    assert.equal(calls.length, 1);
    assert.equal(calls[0], am.accounts[1]);
  });
});

test('a refused removal answers with its own status and reason', async () => {
  const removeAccount = async () => { throw new RemovalRefused('refused for this test', 409); };
  await withServer({ removeAccount }, async (port) => {
    const res = await post(port, '/teamclaude/remove', { account: 'other@example.com' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /refused for this test/);
  });
});

test('remove refuses a name it cannot pin to one account', async () => {
  const calls = [];
  await withServer({ removeAccount: async (i) => { calls.push(i); return { name: 'x' }; } }, async (port) => {
    const ambiguous = await post(port, '/teamclaude/remove', { account: 'me@example.com' });
    assert.equal(ambiguous.status, 400);
    assert.match((await ambiguous.json()).error, /provider/);
    assert.equal((await post(port, '/teamclaude/remove', { account: 'nobody@example.com' })).status, 404);
    assert.equal((await post(port, '/teamclaude/remove', {})).status, 400);
    assert.equal((await post(port, '/teamclaude/remove', 'not json')).status, 400);
    assert.deepEqual(calls, [], 'nothing was removed');
  });
});

test('a remove whose save failed says so rather than reading as a refusal', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    await withServer({ removeAccount: async () => { throw new Error('EACCES'); } }, async (port) => {
      const res = await post(port, '/teamclaude/remove', { account: 'other@example.com' });
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /saving the config file failed/);
    });
  } finally {
    console.error = orig;
  }
});

test('a server without the hooks answers 501, not the forwarder', async () => {
  await withServer({}, async (port) => {
    assert.equal((await post(port, '/teamclaude/remove', { account: 'other@example.com' })).status, 501);
    for (const step of ['start', 'code', 'status', 'cancel']) {
      assert.equal((await post(port, `/teamclaude/login/${step}`, { provider: 'claude', id: 'x' })).status, 501, step);
    }
  });
});

test('a client key may neither sign accounts in nor remove them, and the page is told so', async () => {
  const { webSignIns, runs } = signInHooks();
  const calls = [];
  await withServer({ webSignIns, removeAccount: async (i) => { calls.push(i); return { name: 'x' }; } }, async (port) => {
    for (const path of ['/teamclaude/remove', '/teamclaude/login/start', '/teamclaude/login/code', '/teamclaude/login/status', '/teamclaude/login/cancel']) {
      const res = await post(port, path, { account: 'other@example.com', provider: 'claude', id: 'x' }, { 'x-api-key': CLIENT_KEY });
      assert.equal(res.status, 403, path);
    }
    // The operator's key is let through.
    assert.equal((await post(port, '/teamclaude/login/start', { provider: 'claude' }, { 'x-api-key': PROXY_KEY })).status, 200);
  });
  assert.deepEqual(calls, []);
  assert.equal(runs.length, 1, 'only the operator\'s start ran');
  const refused = callerView('ci').refused;
  for (const path of ['/teamclaude/remove', '/teamclaude/login/start', '/teamclaude/login/status']) assert.ok(refused.includes(path), path);
});

test('a web page cannot start a sign-in or remove an account', async () => {
  const { webSignIns, runs } = signInHooks();
  const calls = [];
  await withServer({ webSignIns, removeAccount: async (i) => { calls.push(i); return { name: 'x' }; } }, async (port) => {
    const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    assert.equal((await post(port, '/teamclaude/login/start', { provider: 'claude' }, crossSite)).status, 403);
    assert.equal((await post(port, '/teamclaude/remove', { account: 'other@example.com' }, crossSite)).status, 403);
  });
  assert.equal(runs.length, 0);
  assert.deepEqual(calls, []);
});
