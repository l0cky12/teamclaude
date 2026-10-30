import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { askPeerToLinkBack, bindsLoopbackOnly, configuredPeers, createPeerDirectory, hostInstanceName, instanceAddress, instanceName, parsePeerUrl, selfAddresses, selfLinkInfo, testPeerLink } from '../src/peers.js';
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
async function fakePeer(reply = () => [200, { ok: true }], contentType = 'application/json') {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body });
      const [status, json] = reply(req);
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(typeof json === 'string' ? json : JSON.stringify(json));
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
    // Dot segments: a browser would fold the relay path onto a local route.
    { name: '.', url: 'http://x:1', apiKey: 'e' },
    { name: '..', url: 'http://x:1', apiKey: 'e' },
    // A query or fragment would swallow the control path appended after it.
    { name: 'query', url: 'http://x:1/other?x=1', apiKey: 'f' },
    { name: 'fragment', url: 'http://x:1/#f', apiKey: 'f' },
    { name: 'based', url: 'http://x:1/base/?', apiKey: 'g' },
  ] });
  assert.deepEqual(peers, [
    { name: 'server', url: 'http://100.64.0.2:3456', apiKey: 'a' },
    { name: 'based', url: 'http://x:1/base', apiKey: 'g' },
  ]);
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

test('a peer behind a base path is asked under it, with the route\'s query kept apart', async () => {
  const peer = await fakePeer();
  try {
    await withProxy([{ name: 'server', url: `http://127.0.0.1:${peer.port}/base/`, apiKey: 'peer-key' }], async (port) => {
      assert.equal((await call(port, 'GET', '/teamclaude/peers/server/logs?after=3')).status, 200);
      assert.deepEqual(peer.seen.map(r => r.url), ['/base/teamclaude/logs?after=3']);
    });
  } finally { peer.server.close(); }
});

test('a peer\'s reply reaches the browser as inert JSON, whatever it claims to be', async () => {
  const peer = await fakePeer(() => [200, '<script>alert(localStorage.length)</script>'], 'text/html');
  try {
    await withProxy([{ name: 'server', url: `http://127.0.0.1:${peer.port}`, apiKey: 'peer-key' }], async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/teamclaude/peers/server/status`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/json');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
      assert.equal(await res.text(), '<script>alert(localStorage.length)</script>');
    });
  } finally { peer.server.close(); }
});

test('selfAddresses offers Tailscale, then the LAN, and never a container bridge or loopback', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    'br-095a': [{ address: '172.26.0.1', family: 'IPv4', internal: false }],
    eth0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    enp0s31f6: [{ address: '10.2.1.121', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.119.13.105', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(selfAddresses('0.0.0.0', 3456, ifaces), ['http://100.119.13.105:3456', 'http://10.2.1.121:3456', 'http://203.0.113.7:3456']);
  assert.deepEqual(selfAddresses('::', 3456, ifaces)[0], 'http://100.119.13.105:3456');
  // Bound to one address, that is the only one anything can reach.
  assert.deepEqual(selfAddresses('100.119.13.105', 3456, ifaces), ['http://100.119.13.105:3456']);
  assert.deepEqual(selfAddresses('fd7a::5', 3456, ifaces), ['http://[fd7a::5]:3456']);
  for (const bound of ['127.0.0.1', 'localhost', '::1', '[::1]', null, undefined]) {
    assert.deepEqual(selfAddresses(bound, 3456, ifaces), [], String(bound));
    assert.equal(bindsLoopbackOnly(bound), true, String(bound));
  }
  assert.equal(bindsLoopbackOnly('0.0.0.0'), false);
});

test('testPeerLink says whether the key works, and whether that instance can link back', async () => {
  const current = await fakePeer((req) => req.url === '/teamclaude/quota' ? [200, {}] : [200, { self: { name: 'desk', addresses: [] } }]);
  const older = await fakePeer((req) => req.url === '/teamclaude/quota' ? [200, {}] : [404, { error: 'unknown teamclaude control route' }]);
  const refusing = await fakePeer(() => [401, { error: 'Invalid proxy API key' }]);
  const oddName = await fakePeer((req) => req.url === '/teamclaude/quota' ? [200, {}] : [200, { self: { name: '../x' } }]);
  const clientKeyed = await fakePeer((req) => req.url === '/teamclaude/quota' ? [200, {}] : [403, { ok: false, error: 'a client key cannot manage linked instances' }]);
  try {
    const at = (p) => ({ name: 'test', url: `http://127.0.0.1:${p.port}`, apiKey: 'their-key' });
    assert.deepEqual(await testPeerLink(at(current)), { state: 'online', linkable: true, name: 'desk' });
    assert.deepEqual(current.seen.map(r => [r.url, r.key]), [['/teamclaude/quota', 'their-key'], ['/teamclaude/peer-links', 'their-key']]);
    assert.deepEqual(await testPeerLink(at(older)), { state: 'online', linkable: false });
    assert.deepEqual(await testPeerLink(at(refusing)), { state: 'refused', linkable: false });
    assert.equal(refusing.seen.length, 1, 'a refused key is not tried again');
    assert.deepEqual(await testPeerLink(at(oddName)), { state: 'online', linkable: true }, 'a name the relay path cannot carry is not suggested');
    assert.deepEqual(await testPeerLink(at(clientKeyed)), { state: 'refused', linkable: false, clientKey: true }, 'a client key is not an older version');
    assert.deepEqual(await testPeerLink({ name: 'test', url: `http://127.0.0.1:${await closedPort()}`, apiKey: 'k' }), { state: 'offline', linkable: false });
  } finally {
    for (const p of [current, older, refusing, oddName, clientKeyed]) p.server.close();
  }
});

test('askPeerToLinkBack posts this machine to the peer with the peer\'s key, and explains a refusal', async () => {
  const answers = [[200, { ok: true }], [400, { ok: false, error: 'an instance named "hub" is already linked; remove it first to change it' }], [404, {}], [401, {}], [500, 'not json']];
  const peer = await fakePeer(() => answers.shift());
  try {
    const target = { name: 'desk', url: `http://127.0.0.1:${peer.port}`, apiKey: 'desk-key' };
    const entry = { name: 'hub', url: 'http://100.64.0.1:3456', apiKey: 'hub-key' };
    assert.deepEqual(await askPeerToLinkBack(target, entry), { ok: true });
    assert.equal(peer.seen[0].method, 'POST');
    assert.equal(peer.seen[0].url, '/teamclaude/peer-links/add');
    assert.equal(peer.seen[0].key, 'desk-key');
    assert.deepEqual(JSON.parse(peer.seen[0].body), entry);
    assert.match((await askPeerToLinkBack(target, entry)).error, /desk did not add this machine \(an instance named "hub" is already linked/);
    assert.match((await askPeerToLinkBack(target, entry)).error, /runs a version that cannot be linked/);
    assert.match((await askPeerToLinkBack(target, entry)).error, /refused the key/);
    assert.match((await askPeerToLinkBack(target, entry)).error, /status 500/);
  } finally {
    peer.server.close();
  }
  const down = await askPeerToLinkBack({ name: 'desk', url: `http://127.0.0.1:${await closedPort()}`, apiKey: 'k' }, { name: 'hub', url: 'http://h:1', apiKey: 'k' });
  assert.equal(down.ok, false);
  assert.match(down.error, /desk is unreachable/);
});

test('hostInstanceName cuts the host name to what a link name may hold', () => {
  assert.equal(hostInstanceName('hermes.tail1234.ts.net'), 'hermes');
  assert.equal(hostInstanceName('My Laptop'), 'My-Laptop');
  assert.equal(hostInstanceName('--box'), 'box');
  assert.equal(hostInstanceName(''), 'teamclaude');
  assert.equal(hostInstanceName('x'.repeat(80)).length, 64);
});

test('instanceName is instanceName from the config, else the host name, and is what a link is offered', () => {
  assert.equal(instanceName({ instanceName: ' hermes ' }), 'hermes');
  assert.equal(instanceName({}), hostInstanceName());
  // A hand edit a link could not store is passed over rather than offered.
  assert.equal(instanceName({ instanceName: 'my laptop' }), hostInstanceName());
  assert.equal(instanceName({ instanceName: 7 }), hostInstanceName());
  assert.equal(selfLinkInfo({ instanceName: 'hermes', proxy: {} }, '127.0.0.1', 3456).name, 'hermes');
});

test('selfLinkInfo offers the instanceAddress set before any guess, even on loopback', () => {
  const ifaces = { eth0: [{ address: '172.30.0.2', family: 'IPv4', internal: false }] };
  // What a Docker container sees: only its own bridge address.
  assert.deepEqual(selfAddresses('0.0.0.0', 3456, ifaces), ['http://172.30.0.2:3456']);
  assert.equal(instanceAddress({ instanceAddress: ' http://100.64.0.9:3456 ' }), 'http://100.64.0.9:3456');
  assert.equal(instanceAddress({ instanceAddress: 5 }), '');
  assert.equal(instanceAddress({}), '');
  const set = selfLinkInfo({ instanceAddress: 'http://100.64.0.9:3456', proxy: {} }, '100.64.0.9', 3456);
  assert.equal(set.address, 'http://100.64.0.9:3456');
  assert.deepEqual(set.addresses, ['http://100.64.0.9:3456'], 'the bound address it matches is not listed twice');
  const loop = selfLinkInfo({ instanceAddress: 'https://hub.tail.ts.net', proxy: {} }, '127.0.0.1', 3456);
  assert.deepEqual(loop.addresses, ['https://hub.tail.ts.net'], 'a reverse proxy in front of a loopback proxy');
  assert.equal(loop.offBox, false);
  assert.equal(selfLinkInfo({ proxy: {} }, '127.0.0.1', 3456).address, '');
});
