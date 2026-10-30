import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { hostInstanceName } from '../src/peers.js';

// /teamclaude/instance-name is the dashboard's Instance name row on Settings:
// it writes `instanceName` under the config lock and reloads, and the status
// and the picker's /teamclaude/peers read then call this machine by it. Every
// test points TEAMCLAUDE_CONFIG (and TEAMROUTER_CONFIG, which wins over it) at
// a throwaway file, so the real config is never touched.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];
const PROXY = { apiKey: 'tc-local', clientKeys: [{ name: 'laptop', key: 'tc-client' }] };

/**
 * A server on a throwaway config file whose reload hook copies `instanceName`
 * onto the running config, as index.js does. Pass `reload: null` for a server
 * without one.
 */
async function withServer(fn, { instanceName, reload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-instance-name-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 3, ...PROXY }, accounts: ACCTS, ...(instanceName ? { instanceName } : {}) }));
  const saved = { tc: process.env.TEAMCLAUDE_CONFIG, tr: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  const config = { proxy: JSON.parse(JSON.stringify(PROXY)), upstream: 'https://api.anthropic.com', ...(instanceName ? { instanceName } : {}) };
  const reloads = { count: 0 };
  const hooks = reload === null ? {} : {
    reload: async () => {
      reloads.count++;
      const disk = JSON.parse(await readFile(path, 'utf-8'));
      if (disk.instanceName === undefined) delete config.instanceName;
      else config.instanceName = disk.instanceName;
      return {};
    },
  };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), config, hooks);
  const port = await listen(server);
  try {
    await fn({ port, path, reloads });
  } finally {
    server.closeAllConnections?.();
    server.close();
    for (const [name, value] of [['TEAMCLAUDE_CONFIG', saved.tc], ['TEAMROUTER_CONFIG', saved.tr]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function setName(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/instance-name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getJson(port, path, headers = {}) {
  return (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).json();
}

test('a name is saved, reloaded, and is what the status and the picker call this machine', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const res = await setName(port, { name: ' hermes ' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name: 'hermes', host: hostInstanceName(), custom: true });
    assert.equal(JSON.parse(await readFile(path, 'utf-8')).instanceName, 'hermes');
    assert.equal(reloads.count, 1);
    assert.deepEqual((await getJson(port, '/teamclaude/status')).instance, { name: 'hermes', host: hostInstanceName(), custom: true });
    assert.deepEqual((await getJson(port, '/teamclaude/peers')).self, { name: 'hermes' });
    assert.equal((await getJson(port, '/teamclaude/peer-links')).self.name, 'hermes', 'and what a link back offers');
  });
});

test('an empty name drops the key and the host name is used again', async () => {
  await withServer(async ({ port, path }) => {
    const res = await setName(port, { name: '' });
    assert.deepEqual(await res.json(), { ok: true, name: hostInstanceName(), host: hostInstanceName(), custom: false });
    assert.equal('instanceName' in JSON.parse(await readFile(path, 'utf-8')), false);
    assert.equal((await getJson(port, '/teamclaude/status')).instance.custom, false);
  }, { instanceName: 'hermes' });
});

test('a refused name leaves the file as it was and does not reload', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    for (const body of [{ name: 'my laptop' }, {}, { name: 5 }, 'not json']) {
      const res = await setName(port, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
  });
});

test('a client key cannot rename the instance, and is not told its name', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    const res = await setName(port, { name: 'other' }, { 'x-api-key': 'tc-client' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /client key cannot change settings/);
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
    const status = await getJson(port, '/teamclaude/status', { 'x-api-key': 'tc-client' });
    assert.equal(status.instance, undefined);
    assert.ok(status.caller.refused.includes('/teamclaude/instance-name'), 'the page knows to hide the row');
  }, { instanceName: 'hermes' });
});

test('without a reload hook nothing is written', async () => {
  await withServer(async ({ port, path }) => {
    const before = await readFile(path, 'utf-8');
    const res = await setName(port, { name: 'hermes' });
    assert.equal(res.status, 501);
    assert.equal(await readFile(path, 'utf-8'), before);
  }, { reload: null });
});
