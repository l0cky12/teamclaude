import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { configuredPeers, createPeerDirectory, parsePeerUrl } from '../src/peers.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// Linked instances: a proxy relays /teamclaude/peers/<name>/<route> to another
// of the operator's proxies with that one's key, so one dashboard can show and
// control both.

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function call(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A stand-in peer that records what it was asked and answers `reply`. */
async function fakePeer(reply = () => [200, { ok: true }]) {
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
  return { server, seen, port: await listen(server) };
}

async function withProxy(peers, fn) {
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }], 0.98);
  const config = { proxy: { apiKey: 'local-key', clientKeys: [{ name: 'laptop', key: 'tc-client' }] }, upstream: 'http://127.0.0.1:1', peers };
  const proxy = createProxyServer(am, config);
  const port = await listen(proxy);
  try { await fn(port, config); } finally { proxy.closeAllConnections?.(); proxy.close(); }
}

test('parsePeerUrl keeps the relay inside the control plane', () => {
  assert.deepEqual(parsePeerUrl('/teamclaude/peers/server/status'), { name: 'server', rest: 'status' });
  assert.deepEqual(parsePeerUrl('/teamclaude/peers/my%20box/logs?after=3'), { name: 'my box', rest: 'logs?after=3' });
  assert.deepEqual(parsePeerUrl('/teamclaude/peers/s/login/start'), { name: 's', rest: 'login/start' });
  for (const rest of ['', 'dashboard', 'mcp', 'peers/other/status', '../../v1/messages', '%2e%2e/v1/messages', 'Status', 'a//b']) {
    assert.equal(parsePeerUrl('/teamclaude/peers/s/' + rest)?.rest, null, rest);
  }
  assert.equal(parsePeerUrl('/teamclaude/peers'), null);
  assert.equal(parsePeerUrl('/teamclaude/status'), null);
});

test('configuredPeers skips unusable entries and duplicate names', () => {
  const peers = configuredPeers({ peers: [
    { name: 'server', url: 'http://100.64.0.2:3456/', apiKey: 'a' },
    { name: 'server', url: 'http://other:1', apiKey: 'b' },
    { name: 'nokey', url: 'http://x:1' },
    { name: 'badurl', url: 'ftp://x', apiKey: 'c' },
    { url: 'http://x:1', apiKey: 'd' },
    null,
  ] });
  assert.deepEqual(peers, [{ name: 'server', url: 'http://100.64.0.2:3456', apiKey: 'a' }]);
  assert.deepEqual(configuredPeers({}), []);
});

test('a relayed request reaches the peer with its key, path, query and body', async () => {
  const peer = await fakePeer(req => [200, { ok: true, route: req.url }]);
  try {
    await withProxy([{ name: 'server', url: `http://127.0.0.1:${peer.port}`, apiKey: 'peer-key' }], async (port) => {
      const got = await call(port, 'GET', '/teamclaude/peers/server/logs?after=3', { headers: { 'x-api-key': 'local-key' } });
      assert.equal(got.status, 200);
      assert.deepEqual(got.json(), { ok: true, route: '/teamclaude/logs?after=3' });

      const posted = await call(port, 'POST', '/teamclaude/peers/server/switch', {
        headers: { 'content-type': 'application/json' }, body: '{"account":"b"}',
      });
      assert.equal(posted.status, 200);
      assert.deepEqual(peer.seen.map(r => [r.method, r.url, r.key, r.body]), [
        ['GET', '/teamclaude/logs?after=3', 'peer-key', ''],
        ['POST', '/teamclaude/switch', 'peer-key', '{"account":"b"}'],
      ]);

      // The new name's prefix reaches the relay too.
      assert.equal((await call(port, 'GET', '/teamrouter/peers/server/status')).status, 200);
    });
  } finally { peer.server.close(); }
});

test('the relay refuses what it must not carry, without asking the peer', async () => {
  const peer = await fakePeer();
  try {
    await withProxy([{ name: 'server', url: `http://127.0.0.1:${peer.port}`, apiKey: 'peer-key' }], async (port) => {
      assert.equal((await call(port, 'GET', '/teamclaude/peers/nobody/status')).status, 404);
      for (const rest of ['dashboard', 'mcp', 'peers/server/status', '..%2f..%2fv1%2fmessages']) {
        assert.equal((await call(port, 'GET', '/teamclaude/peers/server/' + rest)).status, 404, rest);
      }
      // A client key is a tenant of this proxy, not of the operator's others.
      const tenant = await call(port, 'GET', '/teamclaude/peers/server/status', { headers: { 'x-api-key': 'tc-client' } });
      assert.equal(tenant.status, 403);
      assert.equal((await call(port, 'GET', '/teamclaude/peers', { headers: { 'x-api-key': 'tc-client' } })).status, 403);
      // A web page on another site gets the same refusal a local write does.
      const csrf = await call(port, 'POST', '/teamclaude/peers/server/reload', {
        headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      });
      assert.equal(csrf.status, 403);
      assert.equal(peer.seen.length, 0);
    });
  } finally { peer.server.close(); }
});

test('a peer that is down, or refuses its key, is a 502 the page will not read as its own key failing', async () => {
  const refusing = await fakePeer(() => [401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid proxy API key' } }]);
  const dead = await closedPort();
  try {
    await withProxy([
      { name: 'refusing', url: `http://127.0.0.1:${refusing.port}`, apiKey: 'wrong' },
      { name: 'dead', url: `http://127.0.0.1:${dead}`, apiKey: 'x' },
    ], async (port) => {
      const r = await call(port, 'GET', '/teamclaude/peers/refusing/status');
      assert.equal(r.status, 502);
      assert.match(r.json().error, /refusing refused the request \(401: Invalid proxy API key\)/);
      const d = await call(port, 'GET', '/teamclaude/peers/dead/status');
      assert.equal(d.status, 502);
      assert.equal(d.json().unreachable, true);
      assert.match(d.json().error, /^dead is unreachable/);
    });
  } finally { refusing.server.close(); }
});

test('status lists the peers for the operator only, never their keys', async () => {
  // A closed local port: listing starts a reachability check, which must not leave the machine.
  const dead = await closedPort();
  await withProxy([{ name: 'server', url: `http://user:pw@127.0.0.1:${dead}/`, apiKey: 'peer-key' }], async (port) => {
    const op = (await call(port, 'GET', '/teamclaude/status')).json();
    assert.deepEqual(op.peers.map(p => [p.name, p.url]), [['server', `http://127.0.0.1:${dead}`]]);
    assert.doesNotMatch(JSON.stringify(op), /peer-key|pw@/);
    const tenant = (await call(port, 'GET', '/teamclaude/status', { headers: { 'x-api-key': 'tc-client' } })).json();
    assert.equal(tenant.peers, undefined);
  });
});

test('the peer directory answers from what it last saw and re-checks only when stale', async () => {
  let clock = 0;
  const checks = [];
  const pending = [];
  const dir = createPeerDirectory({ ttlMs: 1000, now: () => clock, check: (p) => { checks.push(p.name); return new Promise(r => pending.push(r)); } });
  const config = { peers: [{ name: 'server', url: 'http://h:1', apiKey: 'k' }] };

  assert.equal(dir.list(config)[0].state, 'checking');
  dir.list(config);
  assert.deepEqual(checks, ['server'], 'one check in flight at a time');
  pending.shift()('online');
  await new Promise(r => setImmediate(r));
  assert.equal(dir.list(config)[0].state, 'online');
  assert.equal(checks.length, 1, 'fresh: no new check');

  clock = 1000;
  assert.equal(dir.list(config)[0].state, 'online', 'stale answers are still served while re-checking');
  assert.equal(checks.length, 2);
  pending.shift()('offline');
  await new Promise(r => setImmediate(r));
  assert.equal(dir.list(config)[0].state, 'offline');

  // A new key is a different peer: nothing seen about the old one applies.
  config.peers[0].apiKey = 'k2';
  assert.equal(dir.list(config)[0].state, 'checking');
  assert.equal(checks.length, 3);
});
