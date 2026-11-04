import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { accountSyncMode, createSyncTransport, peerStoreApi, storeLabel } from '../src/instance-sync.js';
import { WebAccountSync, AccountSyncError } from '../src/web-account-sync.js';
import { closedPort, spawnServer, waitForStatus } from '../test-helpers/spawn-server.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// Account sync through one of your own instances (instance-sync.js): the
// config names the store — this machine (`host`) or a linked instance
// (`follow`) — and the sync's every call goes there instead of to
// callback.net. The last test runs two real proxies: one keeps the store,
// the other is switched to follow it from the dashboard's route and picks up
// the first one's account without a sign-in.

test('the mode is read from the config, and anything malformed is off', () => {
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'host' } }), { mode: 'host' });
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'follow', peer: ' desk ' } }), { mode: 'follow', peer: 'desk' });
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'follow' } }), { mode: 'off' });
  assert.deepEqual(accountSyncMode({ accountSync: { mode: 'follow', peer: 3 } }), { mode: 'off' });
  assert.deepEqual(accountSyncMode({ accountSync: 'host' }), { mode: 'off' });
  assert.deepEqual(accountSyncMode({}), { mode: 'off' });
  assert.deepEqual(accountSyncMode(null), { mode: 'off' });
  assert.equal(storeLabel({ mode: 'off' }), 'callback.net');
  assert.equal(storeLabel({ mode: 'follow', peer: 'desk' }), 'the account store on desk');
});

test('each call goes to the store the transport is pinned to, and a config change waits for pin', async () => {
  const calls = [];
  const config = { peers: [{ name: 'hub', url: 'http://127.0.0.1:9', apiKey: 'tc-hub' }] };
  const transport = createSyncTransport({
    getConfig: () => config,
    store: { call: async (...a) => { calls.push(['store', ...a]); return 'local'; } },
    callback: async (...a) => { calls.push(['callback', ...a]); return 'cb'; },
    callbackSignedIn: async () => false,
    request: async (peer, rest, opts) => {
      calls.push(['peer', peer.name, peer.url, rest, JSON.parse(opts.body.toString())]);
      return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, result: 'remote' })) };
    },
  });

  // Not pinned yet: the first call pins to the config as it is. Off: callback.net.
  assert.equal(await transport.isSignedIn(), false);
  assert.equal(await transport.api('GET', 'User/Credential'), 'cb');
  assert.equal(transport.where(), 'callback.net');
  assert.equal(transport.ownStore(), false);

  // The config changes; the calls stay where they were until pin.
  config.accountSync = { mode: 'host' };
  assert.equal(transport.differs(config), true);
  assert.equal(await transport.api('GET', 'User/Credential'), 'cb');
  transport.pin(config);
  assert.equal(transport.differs(config), false);
  assert.equal(await transport.isSignedIn(), true);
  assert.equal(await transport.api('GET', 'User/Credential', { page_no: 1 }, { envelope: true }), 'local');
  assert.equal(transport.where(), 'the account store on this machine');
  assert.equal(transport.ownStore(), true);

  config.accountSync = { mode: 'follow', peer: 'hub' };
  transport.pin(config);
  // A follower's peer address moving is a different store too.
  config.peers = [{ name: 'hub', url: 'http://127.0.0.1:10', apiKey: 'tc-hub' }];
  assert.equal(transport.differs(config), true);
  assert.equal(await transport.api('POST', 'User/Credential/x:lock', { timeout: 30 }), 'remote');
  assert.equal(transport.where(), 'the account store on hub');

  assert.deepEqual(calls, [
    ['callback', 'GET', 'User/Credential', null, {}],
    ['callback', 'GET', 'User/Credential', null, {}],
    ['store', 'GET', 'User/Credential', { page_no: 1 }, { envelope: true }],
    ['peer', 'hub', 'http://127.0.0.1:9', 'sync-store', { method: 'POST', path: 'User/Credential/x:lock', params: { timeout: 30 }, envelope: false }],
  ]);

  // Following an instance this machine does not list: an error, which makes
  // the sync hold its renewals back rather than renew on its own.
  config.accountSync = { mode: 'follow', peer: 'gone' };
  transport.pin(config);
  assert.equal(await transport.isSignedIn(), true);
  await assert.rejects(transport.api('GET', 'User/Credential'), /no linked instance named gone/);
});

test('a host refusal reaches the sync with its token, as callback.net reports one', async () => {
  const peer = { name: 'hub', url: 'http://127.0.0.1:9', apiKey: 'k' };
  const answer = (status, json) => peerStoreApi(peer, { request: async () => ({ status, body: Buffer.from(JSON.stringify(json)) }) });
  await assert.rejects(answer(409, { ok: false, token: 'error_credential_locked', error: 'the credential is locked' })('POST', 'User/Credential/x:lock'),
    (err) => err.token === 'error_credential_locked');
  await assert.rejects(answer(404, { ok: false, token: 'error_not_host', error: 'no' })('GET', 'User/Credential'),
    /hub does not keep the accounts; turn that on there first/);
  await assert.rejects(answer(401, { error: { message: 'Invalid proxy API key' } })('GET', 'User/Credential'),
    (err) => /hub refused its key in peers/.test(err.message) && err.token === undefined);
  const down = peerStoreApi(peer, { request: async () => { throw new Error('connect ECONNREFUSED'); } });
  await assert.rejects(down('GET', 'User/Credential'), /hub is unreachable \(connect ECONNREFUSED\)/);
});

/** WebAccountSync with the instance hooks, and what it was asked to do. */
function card({ signedIn = false, mode = { mode: 'off' }, peers = ['hub'], canHost = true, probe = async () => ({}) } = {}) {
  const set = [];
  let current = mode;
  const passes = [];
  const sync = new WebAccountSync({
    sync: { summary: () => ({ rows: 0 }), sync: async (r) => { passes.push(r); return {}; } },
    load: async () => (signedIn ? { access_token: 'a' } : null),
    whoami: async () => { throw new Error('not asked'); },
    mode: () => current,
    setMode: async (next) => { set.push(next); current = next; },
    peerNames: () => peers,
    canHost: () => canHost,
    probe,
    log: () => {},
  });
  return { sync, set, passes };
}

test('the card switches the store, and refuses what would leave an install on two stores or none it can reach', async () => {
  const c = card();
  assert.deepEqual(await c.sync.changeMode({ mode: 'host' }), { mode: 'host', peer: null });
  assert.deepEqual((await c.sync.view()).instance, { mode: 'host', peer: null, peers: ['hub'], canHost: true, supported: true });
  // Sync now works against a store of your own, signed in to nothing.
  await c.sync.syncNow();
  assert.deepEqual(c.passes, ['dashboard']);
  // And the callback.net sign-in is refused while it is on.
  await assert.rejects(c.sync.start(), /goes through your own instances; turn that off first/);
  assert.deepEqual(await c.sync.changeMode({ mode: 'off' }), { mode: 'off', peer: null });

  const probed = [];
  const f = card({ probe: async (p) => { probed.push(p); } });
  assert.deepEqual(await f.sync.changeMode({ mode: 'follow', peer: 'hub' }), { mode: 'follow', peer: 'hub' });
  assert.deepEqual(probed, ['hub']);
  assert.deepEqual(f.set, [{ mode: 'follow', peer: 'hub' }]);

  const refused = async (opts, body, re) => {
    const x = card(opts);
    await assert.rejects(x.sync.changeMode(body), (err) => err instanceof AccountSyncError && re.test(err.message));
    assert.deepEqual(x.set, [], 'nothing saved');
  };
  await refused({ signedIn: true }, { mode: 'host' }, /signed in to callback.net; sign out first/);
  await refused({ canHost: false }, { mode: 'host' }, /no proxy key/);
  await refused({}, { mode: 'follow', peer: 'elsewhere' }, /choose one of the linked instances/);
  await refused({ probe: async () => { throw new Error('hub does not keep the accounts; turn that on there first'); } },
    { mode: 'follow', peer: 'hub' }, /could not use the account store on hub: hub does not keep the accounts/);
  await refused({}, { mode: 'everywhere' }, /must be host, follow or off/);
});

test('the store answers only a caller holding this machine\'s proxy key, never a keyless one', async () => {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const calls = [];
  const hooks = { syncStore: () => ({ call: async (...a) => { calls.push(a); return []; } }) };
  const ask = (port, key) => fetch(`http://127.0.0.1:${port}/teamclaude/sync-store`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify({ method: 'GET', path: 'User/Credential' }),
  });
  const run = async (proxy, fn) => {
    const server = createProxyServer(new AccountManager([{ name: 'k', type: 'apikey', apiKey: 'sk-demo-1' }], 0.98), { proxy: { port: 3, ...proxy } }, hooks);
    const port = await listen(server);
    try { await fn(port); } finally { server.closeAllConnections?.(); server.close(); }
  };
  // No key at all: the gate would let anyone in; the store does not.
  await run({}, async (port) => {
    const res = await ask(port, null);
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /no proxy key/);
  });
  await run({ apiKey: 'tc-host', clientKeys: [{ name: 'laptop', key: 'tc-client' }] }, async (port) => {
    // Loopback without a key passes the gate, and is refused here.
    assert.equal((await ask(port, null)).status, 401);
    assert.equal((await ask(port, 'wrong')).status, 401);
    assert.equal((await ask(port, 'tc-client')).status, 403);
    assert.equal((await ask(port, 'tc-host')).status, 200);
  });
  assert.equal(calls.length, 1);
});

// ---- Two real proxies ------------------------------------------------------

const post = (port, key, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  body: JSON.stringify(body),
});

test('a proxy switched to follow another picks up its accounts, with no sign-in', async () => {
  const deadPort = await closedPort();
  const base = { upstream: `http://127.0.0.1:${deadPort}`, upstreamProxy: false, autoUpdate: false };
  const shared = {
    name: 'shared@example.com', email: 'shared@example.com', type: 'oauth',
    accountUuid: 'uuid-shared', orgUuid: 'org-shared', orgName: 'Shared Org', rateLimitTier: 'default_claude_max_20x',
    accessToken: 'at-shared-1', refreshToken: 'rt-shared-1', expiresAt: Date.now() + 8 * 3600_000,
  };
  const hub = await spawnServer({
    config: () => ({
      ...base,
      proxy: { apiKey: 'tc-hub-key', clientKeys: [{ name: 'laptop', key: 'tc-hub-client' }] },
      accountSync: { mode: 'host' },
      accounts: [shared],
    }),
  });
  let desk;
  try {
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    desk = await spawnServer({
      config: () => ({
        ...base,
        proxy: { apiKey: 'tc-desk-key' },
        peers: [{ name: 'hub', url: hubUrl, apiKey: 'tc-hub-key' }],
        accounts: [{ name: 'local@example.com', type: 'apikey', apiKey: 'sk-demo-1' }],
      }),
    });

    // The hub's store is for its proxy key only, and the desk keeps none.
    const asClient = await post(hub.port, 'tc-hub-client', '/teamclaude/sync-store', { method: 'GET', path: 'User/Credential' });
    assert.equal(asClient.status, 403);
    const notHost = await post(desk.port, 'tc-desk-key', '/teamclaude/sync-store', { method: 'GET', path: 'User/Credential' });
    assert.equal(notHost.status, 404);
    assert.equal((await notHost.json()).token, 'error_not_host');
    // Nor does the relay reach it.
    const relayed = await post(desk.port, 'tc-desk-key', '/teamclaude/peers/hub/sync-store', { method: 'GET', path: 'User/Credential' });
    assert.equal(relayed.status, 404);

    // The dashboard's switch, on the desk.
    const res = await post(desk.port, 'tc-desk-key', '/teamclaude/account-sync/mode', { mode: 'follow', peer: 'hub' });
    assert.equal(res.status, 200, desk.output());
    assert.deepEqual(await res.json(), { ok: true, mode: 'follow', peer: 'hub' });

    // The desk's first pass against the hub's store brings the account in.
    const status = await waitForStatus(desk.port, (s) => s.accounts?.some((/** @type {any} */ a) => a.name === 'shared@example.com'));
    assert.ok(status, desk.output());
    const saved = JSON.parse(await readFile(desk.configPath, 'utf8'));
    assert.deepEqual(saved.accountSync, { mode: 'follow', peer: 'hub' });
    const copy = saved.accounts.find((/** @type {any} */ a) => a.accountUuid === 'uuid-shared');
    assert.equal(copy.refreshToken, 'rt-shared-1');
    // Its own account is shared the other way: it is an API key, which is not.
    assert.ok(!JSON.parse(await readFile(hub.configPath, 'utf8')).accounts.some((/** @type {any} */ a) => a.name === 'local@example.com'));

    const view = await (await fetch(`http://127.0.0.1:${desk.port}/teamclaude/account-sync`, { headers: { 'x-api-key': 'tc-desk-key' } })).json();
    assert.equal(view.instance.mode, 'follow');
    assert.equal(view.instance.peer, 'hub');
    assert.equal(view.sync.rows, 1);
    assert.equal(view.sync.lastError, null);

    // A hand edit and a reload turn it off just as well: the reload re-points
    // the running sync, and the card says so.
    const edited = JSON.parse(await readFile(desk.configPath, 'utf8'));
    delete edited.accountSync;
    await writeFile(desk.configPath, JSON.stringify(edited));
    const reloaded = await post(desk.port, 'tc-desk-key', '/teamclaude/reload', {});
    assert.equal(reloaded.status, 200, desk.output());
    const off = await (await fetch(`http://127.0.0.1:${desk.port}/teamclaude/account-sync`, { headers: { 'x-api-key': 'tc-desk-key' } })).json();
    assert.equal(off.instance.mode, 'off');
    // Its accounts stay where they are.
    assert.ok(JSON.parse(await readFile(desk.configPath, 'utf8')).accounts.some((/** @type {any} */ a) => a.accountUuid === 'uuid-shared'));
  } finally {
    await desk?.stop();
    await hub.stop();
  }
});
