import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/client-keys/create and /revoke are what the dashboard's
// Client keys card sends. Like /threshold they write the config file under its
// lock and then reload, so what landed on disk and whether the reload ran are
// asserted separately. Every test points TEAMCLAUDE_CONFIG (and
// TEAMROUTER_CONFIG, which wins over it) at a throwaway file, so the
// operator's real config is never touched.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];

async function writeConfig(proxy) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-client-keys-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 3, ...proxy }, upstream: 'https://api.anthropic.com', accounts: ACCTS }));
  return path;
}

async function readKeys(path) {
  return JSON.parse(await readFile(path, 'utf-8')).proxy.clientKeys;
}

function send(port, step, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/client-keys/${step}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * A server whose config file is a throwaway, its running proxy section the
 * same as the file's. `reloads` counts the hook calls; pass `reload` to
 * override it, or null for a server without one.
 */
async function withServer(fn, { proxy = { apiKey: 'tc-test' }, reload } = {}) {
  const path = await writeConfig(proxy);
  const saved = { tc: process.env.TEAMCLAUDE_CONFIG, tr: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  const reloads = { count: 0 };
  const hooks = reload === null ? {} : { reload: reload || (async () => { reloads.count++; return 0; }) };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), { proxy: JSON.parse(JSON.stringify(proxy)), upstream: 'https://api.anthropic.com' }, hooks);
  const port = await listen(server);
  try {
    await fn({ port, path, reloads });
  } finally {
    server.close();
    for (const [name, value] of [['TEAMCLAUDE_CONFIG', saved.tc], ['TEAMROUTER_CONFIG', saved.tr]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('create stores a new key under the name, reloads, and answers with the key once', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const res = await send(port, 'create', { name: 'laptop' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store', 'the reply carries a key');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'laptop');
    assert.equal(body.firstKey, false);
    assert.match(body.key, /^tc-/);
    assert.deepEqual(await readKeys(path), [{ name: 'laptop', key: body.key }]);
    assert.equal(reloads.count, 1, 'the running server is told to pick it up');
  });
});

test('a refused name writes nothing and is not reloaded', async () => {
  await withServer(async ({ port, path, reloads }) => {
    for (const body of [{}, { name: '' }, { name: 'bad\nname' }, { name: 'ci' }]) {
      const res = await send(port, 'create', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).ok, false);
    }
    assert.deepEqual(await readKeys(path), [{ name: 'ci', key: 'ci-key' }]);
    assert.equal(reloads.count, 0);
    const notJson = await send(port, 'create', 'not json');
    assert.equal(notJson.status, 400);
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
});

test('revoke drops the name from the file and reloads', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const res = await send(port, 'revoke', { name: 'ci' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'ci', removed: 1 });
    assert.deepEqual(await readKeys(path), [{ name: 'laptop', key: 'lap-key' }]);
    assert.equal(reloads.count, 1);

    const again = await send(port, 'revoke', { name: 'ci' });
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /no client key is named "ci"/);
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }, { name: 'laptop', key: 'lap-key' }] } });
});

test('the write re-reads the file, so a concurrent edit survives', async () => {
  await withServer(async ({ port, path }) => {
    const disk = JSON.parse(await readFile(path, 'utf-8'));
    disk.proxy.clientKeys = [{ name: 'hand-edit', key: 'tc-hand' }];
    disk.switchThreshold = 0.9;
    await writeFile(path, JSON.stringify(disk));

    assert.equal((await send(port, 'create', { name: 'laptop' })).status, 200);
    const after = JSON.parse(await readFile(path, 'utf-8'));
    assert.deepEqual(after.proxy.clientKeys.map(e => e.name), ['hand-edit', 'laptop']);
    assert.equal(after.switchThreshold, 0.9);
  });
});

test('a server with no reload hook refuses up front and writes nothing', async () => {
  await withServer(async ({ port, path }) => {
    const res = await send(port, 'create', { name: 'laptop' });
    assert.equal(res.status, 501);
    assert.equal(await readKeys(path), undefined);
  }, { reload: null });
});

test('a reload failure is reported as saved-but-not-applied', async () => {
  await withServer(async ({ port, path }) => {
    const res = await send(port, 'create', { name: 'laptop' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /saved/);
    assert.equal(body.key, undefined, 'a key that may not be live is not handed out');
    assert.equal((await readKeys(path)).length, 1);
  }, { reload: async () => { throw new Error('boom'); } });
});

// A client key is a tenant: one that could mint keys could grant access the
// operator never did, and one that could revoke could lock the others out.
test('a client key may neither create nor revoke; the shared key may', async () => {
  await withServer(async ({ port, path, reloads }) => {
    for (const step of ['create', 'revoke']) {
      const res = await send(port, step, { name: step === 'create' ? 'other' : 'ci' }, { 'x-api-key': 'ci-key' });
      assert.equal(res.status, 403, step);
      assert.match((await res.json()).error, /client key cannot manage client keys/);
    }
    assert.deepEqual(await readKeys(path), [{ name: 'ci', key: 'ci-key' }]);
    assert.equal(reloads.count, 0);

    const ok = await send(port, 'create', { name: 'other' }, { 'x-api-key': 'tc-test' });
    assert.equal(ok.status, 200);
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
});

test('a web page cannot create a key through the loopback exemption', async () => {
  await withServer(async ({ port, path }) => {
    const res = await send(port, 'create', { name: 'evil' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(res.status, 403);
    assert.equal(await readKeys(path), undefined);
  });
});

test('status lists the configured names and never a key', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text).clientKeys, ['ci', 'laptop']);
    assert.ok(!text.includes('ci-key') && !text.includes('lap-key'), 'no key in the status payload');
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }, { name: 'laptop', key: 'lap-key' }] } });
});

test('a client caller is told both routes are refused', async () => {
  await withServer(async ({ port }) => {
    const status = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'ci-key' } }).then(r => r.json());
    assert.ok(status.caller.refused.includes('/teamclaude/client-keys/create'));
    assert.ok(status.caller.refused.includes('/teamclaude/client-keys/revoke'));
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
});
