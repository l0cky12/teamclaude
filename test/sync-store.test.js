import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { CredentialSync, syncKeyFor } from '../src/credential-sync.js';
import { createSyncStore, getSyncStorePath, SyncStoreError } from '../src/sync-store.js';

// The account store one of your own instances keeps (sync-store.js): a file
// that answers the subset of callback.net's User/Credential API the account
// sync uses, so credential-sync.js runs against it unchanged. The first tests
// pin the API's shapes and the lock; the last ones run two installs' syncs
// against one store file, the way a host and a follower do.

const H = 3600_000;
const T0 = 1_700_000_000_000;

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-sync-store-'));
  let clock = T0;
  const store = createSyncStore({ path: join(dir, 'teamclaude.sync-store.json'), now: () => clock });
  try {
    await fn({ store, dir, tick: (/** @type {number} */ ms) => { clock += ms; }, now: () => clock });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const refusal = (token) => (err) => err instanceof SyncStoreError && err.token === token;

test('the store sits beside the config', () => {
  assert.equal(getSyncStorePath('/c/teamclaude.json'), '/c/teamclaude.sync-store.json');
  assert.equal(getSyncStorePath('/c/conf'), '/c/conf.sync-store');
});

test('rows are created, read, listed in pages, updated and deleted with the shapes the sync reads', async () => {
  await withStore(async ({ store, tick }) => {
    const a = await store.call('POST', 'User/Credential', { Key: 'teamrouter.a', Data: '{"x":1}' });
    assert.equal(a.Key, 'teamrouter.a');
    assert.equal(a.Data, '{"x":1}');
    assert.equal(a.Updated.unixms, T0);
    assert.match(a.User_Credential__, /^ucr-[0-9a-f]+$/);
    await assert.rejects(store.call('POST', 'User/Credential', { Key: 'teamrouter.a', Data: '{}' }), refusal('error_key_exists'));
    await store.call('POST', 'User/Credential', { Key: 'teamrouter.b', Data: '{}' });
    await store.call('POST', 'User/Credential', { Key: 'teamrouter.c', Data: '{}' });

    const p1 = await store.call('GET', 'User/Credential', { results_per_page: 2, page_no: 1 }, { envelope: true });
    const p2 = await store.call('GET', 'User/Credential', { results_per_page: 2, page_no: 2 }, { envelope: true });
    assert.deepEqual(p1.data.map(r => r.Key), ['teamrouter.a', 'teamrouter.b']);
    assert.deepEqual(p2.data.map(r => r.Key), ['teamrouter.c']);
    assert.equal(p1.paging.page_max, 2);
    // Without the envelope, the rows alone.
    assert.equal((await store.call('GET', 'User/Credential', { results_per_page: 100, page_no: 1 })).length, 3);

    tick(1000);
    const patched = await store.call('PATCH', `User/Credential/${a.User_Credential__}`, { Data: '{"x":2}' });
    assert.equal(patched.Data, '{"x":2}');
    assert.equal(patched.Updated.unixms, T0 + 1000);
    assert.equal((await store.call('GET', `User/Credential/${a.User_Credential__}`)).Data, '{"x":2}');

    await store.call('DELETE', `User/Credential/${a.User_Credential__}`);
    await assert.rejects(store.call('GET', `User/Credential/${a.User_Credential__}`), refusal('error_not_found'));
    await assert.rejects(store.call('PATCH', 'User/Credential/ucr-nope', { Data: '{}' }), refusal('error_not_found'));
  });
});

test('a lock refuses the next taker until it is released or older than the lease that taker names', async () => {
  await withStore(async ({ store, tick }) => {
    const { User_Credential__: id } = await store.call('POST', 'User/Credential', { Key: 'teamrouter.a', Data: 'd' });
    const locked = await store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 });
    // The lock answers with the row, Data included: the sync reads it under the lock.
    assert.equal(locked.Data, 'd');
    await assert.rejects(store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 }), refusal('error_credential_locked'));
    await store.call('POST', `User/Credential/${id}:unlock`, {});
    await store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 });

    // Held 29s: still refused. Held 30s: handed over.
    tick(29_000);
    await assert.rejects(store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 }), refusal('error_credential_locked'));
    tick(1_000);
    await store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 });
    await assert.rejects(store.call('POST', 'User/Credential/ucr-nope:lock', { timeout: 30 }), refusal('error_not_found'));
  });
});

test('what a caller sends is bounded: unknown routes, bad ids, oversized data', async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(store.call('GET', 'User/Other'), refusal('error_bad_request'));
    await assert.rejects(store.call('GET', 'User/Credential/../x'), refusal('error_bad_request'));
    await assert.rejects(store.call('GET', 'User/Credential/a b'), refusal('error_not_found'));
    await assert.rejects(store.call('PUT', 'User/Credential'), refusal('error_bad_request'));
    await assert.rejects(store.call('POST', 'User/Credential', { Key: '', Data: '{}' }), refusal('error_bad_request'));
    await assert.rejects(store.call('POST', 'User/Credential', { Key: 'k', Data: 'x'.repeat(64 * 1024 + 1) }), refusal('error_bad_request'));
    await assert.rejects(store.call('POST', 'User/Credential', { Key: 'k', Data: 5 }), refusal('error_bad_request'));
  });
});

test('a store write never goes ahead without the file lock: a live holder makes it refuse', async () => {
  await withStore(async ({ store }) => {
    await store.call('POST', 'User/Credential', { Key: 'teamrouter.a', Data: '{}' });
    const before = await readFile(store.path, 'utf8');
    // Held by a live process (this one), taken just now.
    await writeFile(`${store.path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const saved = process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS;
    process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS = '30';
    try {
      await assert.rejects(store.call('POST', 'User/Credential', { Key: 'teamrouter.b', Data: '{}' }), refusal('error_store_busy'));
      const { User_Credential__: id } = (await store.call('GET', 'User/Credential'))[0];
      await assert.rejects(store.call('POST', `User/Credential/${id}:lock`, { timeout: 30 }), refusal('error_store_busy'));
      assert.equal(await readFile(store.path, 'utf8'), before);
    } finally {
      if (saved === undefined) delete process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS;
      else process.env.TEAMCLAUDE_CONFIG_LOCK_WAIT_MS = saved;
      await rm(`${store.path}.lock`, { force: true });
    }
    // Released: writes go ahead again.
    await store.call('POST', 'User/Credential', { Key: 'teamrouter.b', Data: '{}' });
  });
});

test('the file holds the tokens: written 0600, and one it cannot read is never written over', { skip: process.platform === 'win32' }, async () => {
  await withStore(async ({ store }) => {
    await store.call('POST', 'User/Credential', { Key: 'teamrouter.a', Data: '{}' });
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    // A newer format, or a damaged file: refused, and left exactly as it was.
    await writeFile(store.path, '{"v":99,"rows":"later"}');
    await assert.rejects(store.call('GET', 'User/Credential', null, { envelope: true }), refusal('error_store_unreadable'));
    await assert.rejects(store.call('POST', 'User/Credential', { Key: 'teamrouter.b', Data: '{}' }), refusal('error_store_unreadable'));
    assert.equal(await readFile(store.path, 'utf8'), '{"v":99,"rows":"later"}');
  });
});

// ---- Two installs' syncs over one store file -------------------------------

const claude = (name, extra = {}) => ({
  name, type: 'oauth', accountUuid: `uuid-${name}`, orgUuid: `org-${name}`, orgName: `Org ${name}`,
  accessToken: `at-${name}-1`, refreshToken: `rt-${name}-1`, expiresAt: T0 + 8 * H, ...extra,
});

/** One install: the real account manager and sync, the provider stubbed. */
function install(by, entries, { store, now, tick = () => {}, seedsAll = true, api = store.call }) {
  const refreshed = [];
  const am = new AccountManager(entries, 0.98, {
    refreshFn: async (rt) => {
      refreshed.push(rt);
      return { accessToken: `${rt}-renewed-at`, refreshToken: `${rt}-renewed-rt`, expiresAt: now() + 8 * H };
    },
  });
  const sync = new CredentialSync({
    accountManager: am, api, by, now, log: () => {},
    isSignedIn: async () => true,
    seedsAll: () => seedsAll,
    where: () => 'the account store',
    // Waiting moves the clock, as it would: a lock holder's lease runs out.
    sleep: async (ms) => { tick(ms); },
    addAccount: (entry) => am.addAccount(entry),
  });
  am.onTokenRefresh((idx, tokens) => { sync.onLocalTokens(idx, tokens); });
  am.setRefreshCoordinator((account, refresh, info) => sync.coordinateRefresh(account, refresh, info));
  return { am, sync, refreshed };
}

test('a host shares the accounts it already has, and a follower with none picks them up', async () => {
  await withStore(async ({ store, now }) => {
    const host = install('hub', [claude('a'), claude('b')], { store, now });
    const desk = install('desk', [], { store, now });

    // Neither token was renewed this launch; the host stores them all the same,
    // since a store of your own was turned on to share what each machine has.
    const first = await host.sync.sync('start');
    assert.equal(first.created, 2);
    const second = await desk.sync.sync('start');
    assert.equal(second.added, 2);
    assert.deepEqual(desk.am.accounts.map(a => a.name).sort(), ['a', 'b']);
    assert.equal(desk.am.accounts.find(a => a.name === 'a').refreshToken, 'rt-a-1');
    // Nothing was renewed to get there.
    assert.deepEqual([...host.refreshed, ...desk.refreshed], []);
  });
});

test('without seedsAll a token not renewed here stays off the store (callback.net behaviour)', async () => {
  await withStore(async ({ store, now }) => {
    const host = install('hub', [claude('a')], { store, now, seedsAll: false });
    assert.equal((await host.sync.sync('start')).created, 0);
  });
});

test('a renewal on one install goes through the store lock, and the other adopts it instead of renewing', async () => {
  await withStore(async ({ store, now, tick }) => {
    const host = install('hub', [claude('a')], { store, now });
    await host.sync.sync('start');
    const desk = install('desk', [], { store, now });
    await desk.sync.sync('start');

    // Past expiry: the follower renews, under the lock, and stores the result.
    tick(9 * H);
    const deskA = desk.am.accounts[0];
    await desk.am.ensureTokenFresh(deskA.index);
    assert.deepEqual(desk.refreshed, ['rt-a-1']);
    assert.equal(deskA.refreshToken, 'rt-a-1-renewed-rt');
    const rows = await store.call('GET', 'User/Credential', { results_per_page: 100, page_no: 1 });
    const row = rows.find(r => r.Key === syncKeyFor(deskA));
    assert.equal(JSON.parse(row.Data).refreshToken, 'rt-a-1-renewed-rt');
    assert.equal(JSON.parse(row.Data).by, 'desk');

    // The host's copy is now the rotated-away one. Its own renewal finds the
    // newer token under the lock and takes it, without calling the provider:
    // calling it with rt-a-1 would be the call that signs the other out.
    const hostA = host.am.accounts[0];
    await host.am.ensureTokenFresh(hostA.index);
    assert.deepEqual(host.refreshed, []);
    assert.equal(hostA.refreshToken, 'rt-a-1-renewed-rt');
  });
});

test('a seed from an install that started with an old copy never replaces the newer token another holds', async () => {
  await withStore(async ({ store, now, tick }) => {
    // desk's config still has rt-a-1, which hub has since renewed to rt-a-2.
    const desk = install('desk', [claude('a', { expiresAt: T0 + 1 * H })], { store, now, tick });
    const hub = install('hub', [claude('a', { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 8 * H })], { store, now, tick });
    await desk.sync.sync('start');
    const key = syncKeyFor(desk.am.accounts[0]);
    const rowsByKey = {};
    const read = async () => {
      for (const r of await store.call('GET', 'User/Credential', { results_per_page: 100, page_no: 1 })) rowsByKey[r.Key] = r.Data;
      return JSON.parse(rowsByKey[key]);
    };
    assert.deepEqual([(await read()).refreshToken, (await read()).seeded], ['rt-a-1', true]);

    // hub renews before its own pass runs: under the lock it finds the older
    // seed, keeps its newer token and renews that, never rt-a-1.
    tick(8 * H);
    await hub.am.ensureTokenFresh(hub.am.accounts[0].index);
    assert.deepEqual(hub.refreshed, ['rt-a-2']);
    const stored = await read();
    assert.equal(stored.refreshToken, 'rt-a-2-renewed-rt');
    assert.equal(stored.seeded, undefined, 'a renewal is no seed');
  });
});

test('a pass replaces a seed older than the copy it holds', async () => {
  await withStore(async ({ store, now, tick }) => {
    const desk = install('desk', [claude('a', { expiresAt: T0 + 1 * H })], { store, now, tick });
    const hub = install('hub', [claude('a', { accessToken: 'at-a-2', refreshToken: 'rt-a-2', expiresAt: T0 + 8 * H })], { store, now, tick });
    await desk.sync.sync('start');
    assert.equal((await hub.sync.sync('start')).pushed, 1);
    // And desk takes the newer copy at its next pass, with no renewal anywhere.
    assert.equal((await desk.sync.sync('daily')).adopted, 1);
    assert.equal(desk.am.accounts[0].refreshToken, 'rt-a-2');
    assert.deepEqual([...desk.refreshed, ...hub.refreshed], []);
  });
});

test('two installs that start from one copy and renew before any pass renew it once, under one lock', async () => {
  await withStore(async ({ store, now, tick }) => {
    const a = install('a-box', [claude('a')], { store, now, tick });
    const b = install('b-box', [claude('a')], { store, now, tick });
    tick(9 * H);
    await Promise.all([a.am.ensureTokenFresh(0), b.am.ensureTokenFresh(0)]);
    // One provider call between them; the other install took its result.
    assert.equal(a.refreshed.length + b.refreshed.length, 1);
    assert.equal(a.am.accounts[0].refreshToken, 'rt-a-1-renewed-rt');
    assert.equal(b.am.accounts[0].refreshToken, 'rt-a-1-renewed-rt');
  });
});

test('switching stores lets a renewal under way finish in the store it locked', async () => {
  await withStore(async ({ store, now, tick, dir }) => {
    const other = createSyncStore({ path: join(dir, 'other.sync-store.json'), now });
    let current = store;
    const calls = [];
    const api = (method, path, params, opts) => { calls.push([current === store ? 'A' : 'B', method, path]); return current.call(method, path, params, opts); };
    const hub = install('hub', [claude('a')], { store, now, tick, api });
    await hub.sync.sync('start');
    tick(9 * H);
    let release;
    const gate = new Promise((r) => { release = r; });
    const refresh = hub.sync.coordinateRefresh(hub.am.accounts[0], async () => { await gate; return { accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: now() + 8 * H }; });
    // Let the refresh take its lock before the switch is asked for.
    while (!calls.some(([, , path]) => path.endsWith(':lock'))) await new Promise((r) => setImmediate(r));
    let applied = false;
    const switched = hub.sync.switchStore(60_000, () => { applied = true; current = other; });
    await new Promise((r) => setImmediate(r));
    assert.equal(applied, false, 'not while the renewal holds its lock');
    release();
    await refresh;
    await switched;
    hub.sync.stop();
    assert.equal(applied, true);
    // The lock, the store of the renewal and the unlock all went to A.
    const renewal = calls.slice(calls.findIndex(([, , p]) => p.endsWith(':lock')));
    const end = renewal.findIndex(([, , p]) => p.endsWith(':unlock'));
    assert.ok(end > 0, JSON.stringify(calls));
    assert.ok(renewal.slice(0, end + 1).every(([s]) => s === 'A'), JSON.stringify(calls));
    const rows = await store.call('GET', 'User/Credential', { results_per_page: 100, page_no: 1 });
    assert.equal(JSON.parse(rows[0].Data).refreshToken, 'rt-new');
  });
});
