import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// /teamclaude/peer-links is what the dashboard's Linked instances card sends:
// the GET of what this machine can offer, and test, add, remove and key. Add
// and remove write the config file under its lock and then reload, like the
// client keys. Every test points TEAMCLAUDE_CONFIG (and TEAMROUTER_CONFIG,
// which wins over it) at a throwaway file, so the real config is never touched.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const ACCTS = [{ name: 'alice@example.com', type: 'apikey', apiKey: 'k1' }];

async function readPeers(path) {
  return JSON.parse(await readFile(path, 'utf-8')).peers;
}

function send(port, step, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/peer-links/${step}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A stand-in for another machine's proxy: records requests, answers `reply`. */
async function fakePeer(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      const [status, json] = reply(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return { server, seen, url: `http://127.0.0.1:${await listen(server)}` };
}

/**
 * A server whose config file is a throwaway, with the running `peers` kept in
 * step with the file by the reload hook, as index.js does. Pass `reload: null`
 * for a server without one.
 */
async function withServer(fn, { proxy = { apiKey: 'tc-local' }, peers, reload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-peer-links-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 3, ...proxy }, upstream: 'https://api.anthropic.com', accounts: ACCTS, ...(peers ? { peers } : {}) }));
  const saved = { tc: process.env.TEAMCLAUDE_CONFIG, tr: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  const config = { proxy: JSON.parse(JSON.stringify(proxy)), upstream: 'https://api.anthropic.com', peers };
  const reloads = { count: 0 };
  const hooks = reload === null ? {} : {
    reload: reload || (async () => { reloads.count++; config.peers = await readPeers(path); return {}; }),
  };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), config, hooks, null, null, null, { bindHost: '0.0.0.0' });
  const port = await listen(server);
  try {
    await fn({ port, path, reloads, config });
  } finally {
    server.closeAllConnections?.();
    server.close();
    for (const [name, value] of [['TEAMCLAUDE_CONFIG', saved.tc], ['TEAMROUTER_CONFIG', saved.tr]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('add stores the entry, reloads, and the relay can use it at once', async () => {
  const other = await fakePeer(() => [200, { accounts: [] }]);
  try {
    await withServer(async ({ port, path, reloads }) => {
      const res = await send(port, 'add', { name: 'desk', url: other.url + '/', apiKey: 'desk-key' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, name: 'desk', url: other.url });
      assert.deepEqual(await readPeers(path), [{ name: 'desk', url: other.url, apiKey: 'desk-key' }]);
      assert.equal(reloads.count, 1);
      const relayed = await fetch(`http://127.0.0.1:${port}/teamclaude/peers/desk/status`);
      assert.equal(relayed.status, 200);
      assert.equal(other.seen[0].key, 'desk-key');
    });
  } finally {
    other.server.close();
  }
});

test('a refused add or remove leaves the file as it was and does not reload', async () => {
  const peers = [{ name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'k' }];
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    for (const [step, body, why] of [
      ['add', { name: 'desk', url: 'http://h:2', apiKey: 'k' }, /already linked/],
      ['add', { name: 'new', url: 'http://u:p@h:2', apiKey: 'k' }, /key field/],
      ['add', { name: 'new', url: 'http://h:2' }, /proxy key/],
      ['remove', { name: 'nobody' }, /no linked instance/],
    ]) {
      const res = await send(port, step, body);
      assert.equal(res.status, 400, step);
      assert.match((await res.json()).error, why);
    }
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
    assert.equal((await send(port, 'add', '{not json')).status, 400);
  }, { peers });
});

test('remove drops the entry and reloads', async () => {
  const peers = [{ name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'k' }, { name: 'server', url: 'http://127.0.0.1:2', apiKey: 'k2' }];
  await withServer(async ({ port, path, reloads }) => {
    const res = await send(port, 'remove', { name: 'desk' });
    assert.deepEqual(await res.json(), { ok: true, name: 'desk', removed: 1 });
    assert.deepEqual((await readPeers(path)).map(p => p.name), ['server']);
    assert.equal(reloads.count, 1);
  }, { peers });
});

test('add with linkBack asks the new instance to list this machine, with this machine\'s own key', async () => {
  const other = await fakePeer(() => [200, { ok: true, name: 'hub', url: 'http://100.64.0.1:3456' }]);
  try {
    await withServer(async ({ port, path }) => {
      // `mesh: false` keeps this to the link back; the join is tested below.
      const res = await send(port, 'add', { name: 'desk', url: other.url, apiKey: 'desk-key', linkBack: { name: 'hub', url: '100.64.0.1:3456' }, mesh: false });
      const body = await res.json();
      assert.deepEqual(body, { ok: true, name: 'desk', url: other.url, linkBack: { ok: true } });
      assert.equal(other.seen.length, 1);
      assert.equal(other.seen[0].url, '/teamclaude/peer-links/add');
      assert.equal(other.seen[0].key, 'desk-key', 'asked with ITS key');
      assert.deepEqual(JSON.parse(other.seen[0].body), { name: 'hub', url: 'http://100.64.0.1:3456', apiKey: 'tc-local' });
      assert.equal((await readPeers(path)).length, 1);
    });
  } finally {
    other.server.close();
  }
});

test('a link back the other machine refuses still keeps the link made here, and says why', async () => {
  await withServer(async ({ port, path }) => {
    const down = `http://127.0.0.1:${await closedPort()}`;
    const res = await send(port, 'add', { name: 'desk', url: down, apiKey: 'desk-key', linkBack: { name: 'hub', url: 'http://100.64.0.1:3456' } });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.linkBack.ok, false);
    assert.match(body.linkBack.error, /desk is unreachable/);
    assert.equal((await readPeers(path)).length, 1);
  });
});

test('a link back that cannot be carried out is refused before anything is written', async () => {
  for (const [proxy, linkBack, why] of [
    [{ apiKey: 'tc-local' }, { name: '../x', url: 'http://h:1' }, /as the other one should list it: .*letters, digits/],
    [{ apiKey: 'tc-local' }, { name: 'hub', url: '' }, /as the other one should list it: enter the address/],
    // No key of its own to hand out: the other machine could never get in.
    [{}, { name: 'hub', url: 'http://h:1' }, /no proxy\.apiKey/],
  ]) {
    await withServer(async ({ port, path, reloads }) => {
      const before = await readFile(path, 'utf-8');
      const res = await send(port, 'add', { name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'k', linkBack });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, why);
      assert.equal(await readFile(path, 'utf-8'), before);
      assert.equal(reloads.count, 0);
    }, { proxy });
  }
});

test('test reports the state and whether the instance can link back, and writes nothing', async () => {
  const other = await fakePeer((req) => req.url === '/teamclaude/quota' ? [200, {}] : [200, { self: { name: 'desk' } }]);
  try {
    await withServer(async ({ port, path, reloads }) => {
      const before = await readFile(path, 'utf-8');
      const res = await send(port, 'test', { url: other.url.replace('http://', ''), apiKey: ' desk-key ' });
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { ok: true, url: other.url, state: 'online', linkable: true, name: 'desk' });
      assert.equal(other.seen[0].key, 'desk-key');
      assert.equal(await readFile(path, 'utf-8'), before);
      assert.equal(reloads.count, 0);
      assert.equal((await send(port, 'test', { url: other.url })).status, 400, 'no key, nothing to test');
      assert.equal((await send(port, 'test', { url: 'ftp://x', apiKey: 'k' })).status, 400);
    });
  } finally {
    other.server.close();
  }
});

test('key hands out this machine\'s proxy key, and says so when there is none', async () => {
  await withServer(async ({ port }) => {
    const res = await send(port, 'key', {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, key: 'tc-local' });
  });
  await withServer(async ({ port }) => {
    const res = await send(port, 'key', {});
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no proxy\.apiKey/);
  }, { proxy: {} });
});

test('the GET says what this machine can offer, and lists the links without their keys', async () => {
  await withServer(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/peer-links`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.self.offBox, true);
    assert.equal(body.self.hasKey, true);
    assert.match(body.self.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assert.ok(body.self.addresses.every(a => a.endsWith(`:${port}`)), 'addresses carry the port the request came in on');
    assert.deepEqual(body.peers.map(p => [p.name, p.url]), [['desk', 'http://127.0.0.1:1']]);
    assert.ok(!JSON.stringify(body).includes('secret-desk-key'));
  }, { peers: [{ name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'secret-desk-key' }] });
});

test('add with linkBack then reads what the new instance lists, and links this machine to it', async () => {
  // A fake desk that lists a server, and a fake server that answers tests.
  const server = await fakePeer((req) => {
    if (req.url === '/teamclaude/peer-links/peers') return [200, { ok: true, peers: [] }];
    if (req.url === '/teamclaude/peer-links/test') return [200, { ok: true, state: 'online', linkable: true }];
    return [200, { ok: true }];
  });
  const desk = await fakePeer((req) => {
    if (req.url === '/teamclaude/peer-links/peers') return [200, { ok: true, peers: [{ name: 'hub', url: 'http://100.64.0.1:3456', apiKey: 'tc-local' }, { name: 'server', url: server.url, apiKey: 'server-key' }] }];
    if (req.url === '/teamclaude/peer-links') return [200, { self: { name: 'server' } }];
    return [200, { ok: true }];
  });
  try {
    await withServer(async ({ port, path, config }) => {
      const res = await send(port, 'add', { name: 'desk', url: desk.url, apiKey: 'desk-key', linkBack: { name: 'hub', url: 'http://100.64.0.1:3456' } });
      const body = await res.json();
      assert.equal(body.linkBack.ok, true);
      assert.deepEqual(body.mesh, { linked: [{ from: 'hub', to: 'server' }, { from: 'server', to: 'hub' }], skipped: [] });
      // This machine now lists the server, in the file and in the running config.
      assert.deepEqual((await readPeers(path)).map(p => [p.name, p.apiKey]), [['desk', 'desk-key'], ['server', 'server-key']]);
      assert.deepEqual(config.peers.map(p => p.name), ['desk', 'server']);
      // The server was asked, with its own key, to test and then list this machine.
      const asked = server.seen.filter(r => r.method === 'POST' && r.url.startsWith('/teamclaude/peer-links/'));
      assert.deepEqual(asked.map(r => [r.url, r.key]), [
        ['/teamclaude/peer-links/peers', 'server-key'],
        ['/teamclaude/peer-links/test', 'server-key'],
        ['/teamclaude/peer-links/add', 'server-key'],
      ]);
      assert.deepEqual(JSON.parse(asked[2].body), { name: 'hub', url: 'http://100.64.0.1:3456', apiKey: 'tc-local' });
    });
  } finally {
    desk.server.close();
    server.server.close();
  }
});

test('peers hands the operator what this machine lists, keys included', async () => {
  const peers = [{ name: 'desk', url: 'http://127.0.0.1:1/', apiKey: 'desk-key' }, { name: 'broken' }];
  await withServer(async ({ port }) => {
    const res = await send(port, 'peers', {}, { 'x-api-key': 'tc-local' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, peers: [{ name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'desk-key' }] });
  }, { peers });
});

test('a client key cannot read, test, add, remove or take the key', async () => {
  const proxy = { apiKey: 'tc-local', clientKeys: [{ name: 'laptop', key: 'tc-client' }] };
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    const auth = { 'x-api-key': 'tc-client' };
    const get = await fetch(`http://127.0.0.1:${port}/teamclaude/peer-links`, { headers: auth });
    assert.equal(get.status, 403);
    for (const [step, body] of [['test', { url: 'http://h:1', apiKey: 'k' }], ['add', { name: 'x', url: 'http://h:1', apiKey: 'k' }], ['remove', { name: 'desk' }], ['key', {}], ['peers', {}]]) {
      const res = await send(port, step, body, auth);
      assert.equal(res.status, 403, step);
      assert.match((await res.json()).error, /client key cannot manage linked instances/);
    }
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
  }, { proxy, peers: [{ name: 'desk', url: 'http://127.0.0.1:1', apiKey: 'k' }] });
});

test('a web page cannot add a link through the loopback exemption', async () => {
  await withServer(async ({ port, path }) => {
    const before = await readFile(path, 'utf-8');
    const res = await send(port, 'add', { name: 'evil', url: 'http://attacker.example', apiKey: 'k' }, { Origin: 'http://attacker.example' });
    assert.equal(res.status, 403);
    const key = await send(port, 'key', {}, { Origin: 'http://attacker.example' });
    assert.equal(key.status, 403);
    assert.equal(await readFile(path, 'utf-8'), before);
  });
});

test('without a reload hook nothing is written', async () => {
  await withServer(async ({ port, path }) => {
    const before = await readFile(path, 'utf-8');
    const res = await send(port, 'add', { name: 'desk', url: 'http://h:1', apiKey: 'k' });
    assert.equal(res.status, 501);
    assert.equal(await readFile(path, 'utf-8'), before);
  }, { reload: null });
});

test('test tells a client key of the other proxy apart from its proxy key', async () => {
  // The other machine as a real proxy: its quota read admits a client key,
  // so only the second read can tell the two keys apart.
  const otherProxy = { apiKey: 'tc-other', clientKeys: [{ name: 'laptop', key: 'tc-other-client' }] };
  const other = createProxyServer(new AccountManager(ACCTS, 0.98), { proxy: otherProxy, upstream: 'https://api.anthropic.com' }, {});
  const otherUrl = `http://127.0.0.1:${await listen(other)}`;
  try {
    await withServer(async ({ port }) => {
      const asClient = await (await send(port, 'test', { url: otherUrl, apiKey: 'tc-other-client' })).json();
      assert.deepEqual(asClient, { ok: true, url: otherUrl, state: 'refused', linkable: false, clientKey: true });
      const asOperator = await (await send(port, 'test', { url: otherUrl, apiKey: 'tc-other' })).json();
      assert.equal(asOperator.state, 'online');
      assert.equal(asOperator.linkable, true);
      // A wrong key cannot be tried here: both proxies are on loopback, which
      // the other admits without a key. peers.test.js covers the refusal.
    });
  } finally {
    other.closeAllConnections?.();
    other.close();
  }
});
