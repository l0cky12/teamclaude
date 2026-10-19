import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/probe-interval is what the dashboard's Quota refresh picker
// sends, the headless equivalent of `teamclaude probe <seconds>`. A setting:
// it goes through the config file and a reload applies it, so what landed on
// disk and whether the reload ran are asserted separately. Every test points
// TEAMCLAUDE_CONFIG (and TEAMROUTER_CONFIG, which wins) at a throwaway file.

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];

async function readStored(path) {
  return JSON.parse(await readFile(path, 'utf-8')).quotaProbeSeconds;
}

async function post(port, body, key) {
  const res = await fetch(`http://127.0.0.1:${port}/teamclaude/probe-interval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function withServer(fn, { reload, proxy = { apiKey: 'tc-test' } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-http-probe-interval-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 3, apiKey: 'tc-test' }, accounts: ACCTS, quotaProbeSeconds: 300 }));
  const previous = { tc: process.env.TEAMCLAUDE_CONFIG, tr: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  const reloads = { count: 0 };
  const hooks = reload === null ? {} : { reload: reload || (async () => { reloads.count++; return 0; }) };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), { proxy, upstream: 'https://api.anthropic.com' }, hooks);
  const port = await listen(server);
  try {
    await fn({ port, path, reloads });
  } finally {
    server.close();
    for (const [name, value] of [['TEAMCLAUDE_CONFIG', previous.tc], ['TEAMROUTER_CONFIG', previous.tr]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('an interval is saved and the running server is reloaded', async () => {
  await withServer(async ({ port, path, reloads }) => {
    for (const seconds of [5, 120, 0]) {
      const res = await post(port, JSON.stringify({ seconds }));
      assert.equal(res.status, 200, String(seconds));
      assert.deepEqual(res.body, { ok: true, quotaProbeSeconds: seconds });
      assert.equal(await readStored(path), seconds);
    }
    assert.equal(reloads.count, 3, 'saving alone would leave the prober on the old interval');
  });
});

test('an interval the shared rule refuses is a 400 and nothing is written', async () => {
  for (const seconds of [4, -1, 1.5, '10', null]) {
    await withServer(async ({ port, path, reloads }) => {
      const res = await post(port, JSON.stringify({ seconds }));
      assert.equal(res.status, 400, JSON.stringify(seconds));
      assert.equal(res.body.ok, false);
      assert.equal(await readStored(path), 300);
      assert.equal(reloads.count, 0);
    });
  }
});

test('a body that is not JSON is refused', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, 'not json');
    assert.equal(res.status, 400);
    assert.equal(await readStored(path), 300);
  });
});

test('a reload failure is reported as saved-but-not-applied', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ seconds: 10 }));
    assert.equal(res.status, 500);
    assert.match(res.body.error, /saved/);
    assert.equal(await readStored(path), 10);
  }, { reload: async () => { throw new Error('boom'); } });
});

test('a server with no reload hook refuses up front and writes nothing', async () => {
  await withServer(async ({ port, path }) => {
    const res = await post(port, JSON.stringify({ seconds: 10 }));
    assert.equal(res.status, 501);
    assert.equal(await readStored(path), 300);
  }, { reload: null });
});

test('a client key is refused; the proxy key is not', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const refused = await post(port, JSON.stringify({ seconds: 10 }), 'ci-key');
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /client key/);
    assert.equal(await readStored(path), 300);
    assert.equal(reloads.count, 0);

    const allowed = await post(port, JSON.stringify({ seconds: 10 }), 'tc-test');
    assert.equal(allowed.status, 200);
    assert.equal(await readStored(path), 10);
  }, { proxy: { apiKey: 'tc-test', clientKeys: [{ name: 'ci', key: 'ci-key' }] } });
});
