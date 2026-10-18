// Operator changes on the event log (the dashboard's Logs page): an account
// enabled, disabled or reprioritized, and the switch threshold moved. They are
// recorded where the change is applied, not by whoever asked for it, so the
// CLI (which edits the config file and asks the server to reload), the
// dashboard, MCP and a hand edit each leave exactly one entry, named with the
// account's provider so the page's provider filter finds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { thresholdEvent } from '../src/event-log.js';
import { spawnServer, closedPort } from '../test-helpers/spawn-server.js';

/** @param {AccountManager} am */
const controls = am => am.events.since(0).events.filter(e => e.kind === 'control');

test('setDisabled and setPriority record a real change once, with the provider', () => {
  const am = new AccountManager([
    { name: 'work', type: 'apikey', apiKey: 'k' },
    { name: 'gpt', type: 'oauth', provider: 'codex', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  ], 0.98);
  am.setDisabled(0, true);
  am.setDisabled(0, true);
  am.setPriority(1, 3);
  am.setPriority(1, 3);
  am.setDisabled(0, false);
  assert.deepEqual(controls(am).map(e => [e.type, e.account, e.provider]), [
    ['disabled', 'work', 'anthropic'],
    ['priority', 'gpt', 'codex'],
    ['enabled', 'work', 'anthropic'],
  ]);
  assert.equal(am.accounts[1].priority, 3);
});

// The TUI's switch key and MCP call setCurrentAccount directly; the HTTP
// handler calls it too and adds nothing of its own.
test('a manual switch is recorded by setCurrentAccount, saying whether rotation will use it', () => {
  const am = new AccountManager([
    { name: 'work', type: 'apikey', apiKey: 'k' },
    { name: 'spare', type: 'apikey', apiKey: 'k2', disabled: true },
  ], 0.98);
  am.setCurrentAccount(1);
  am.setCurrentAccount(0);
  const [toSpare, toWork] = controls(am);
  assert.deepEqual([toSpare.type, toSpare.account, toSpare.provider], ['switch', 'spare', 'anthropic']);
  assert.match(toSpare.message, /so rotation will not use it/);
  assert.deepEqual([toWork.type, toWork.account, toWork.reason], ['switch', 'work', 'manual']);
  assert.equal(am.setCurrentAccount(9), false);
  assert.equal(controls(am).length, 2);
});

test('a reload that picks up a disk edit records it; one that changes nothing records nothing', async () => {
  const disk = [{ name: 'work', type: 'apikey', apiKey: 'k' }, { name: 'spare', type: 'apikey', apiKey: 'k2' }];
  const am = new AccountManager(disk.map(a => ({ ...a })), 0.98);
  const mem = { accounts: disk.map(a => ({ ...a })) };
  const edited = [{ ...disk[0], disabled: true }, { ...disk[1], priority: 2 }];
  await syncAccountsFromDisk({ accounts: edited }, mem, am);
  assert.deepEqual(controls(am).map(e => [e.type, e.account, e.message]), [
    ['disabled', 'work', 'Disabled'],
    ['priority', 'spare', 'Priority 0 → 2'],
  ]);
  await syncAccountsFromDisk({ accounts: edited.map(a => ({ ...a })) }, mem, am);
  assert.equal(controls(am).length, 2);
});

test('thresholdEvent words one number as a percent and a table as per-bucket', () => {
  assert.equal(thresholdEvent(0.9).message, 'Switch threshold set to 90%');
  assert.equal(thresholdEvent(0.955).message, 'Switch threshold set to 95.5%');
  assert.equal(thresholdEvent({ unified7d: 0.9 }).message, 'Switch thresholds set per quota bucket');
});

// The CLI's path end to end: `teamclaude disable`, `priority` and `threshold`
// write the config file and POST /teamclaude/reload. The dashboard's own
// /teamclaude/disable goes through the same reload and must not add a second
// entry of its own.
test('through a running server: CLI-style edits and a dashboard disable each leave one entry', async () => {
  const deadPort = await closedPort();
  const server = await spawnServer({
    config: () => ({
      proxy: {},
      upstream: `http://127.0.0.1:${deadPort}`,
      upstreamProxy: false,
      switchThreshold: 0.98,
      accounts: [{ name: 'work', type: 'apikey', apiKey: 'k1' }, { name: 'spare', type: 'apikey', apiKey: 'k2' }],
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const logs = async () => (await (await fetch(`${base}/teamclaude/logs`)).json()).events.filter((/** @type {any} */ e) => e.kind === 'control');
  const reload = async () => assert.equal((await fetch(`${base}/teamclaude/reload`, { method: 'POST' })).status, 200);
  try {
    const config = JSON.parse(await readFile(server.configPath, 'utf8'));
    config.accounts[0].disabled = true;
    config.accounts[1].priority = 4;
    config.switchThreshold = 0.9;
    await writeFile(server.configPath, JSON.stringify(config, null, 2));
    await reload();
    assert.deepEqual((await logs()).map((/** @type {any} */ e) => [e.type, e.account, e.provider]), [
      ['disabled', 'work', 'anthropic'],
      ['priority', 'spare', 'anthropic'],
      ['threshold', null, null],
    ]);
    await reload();
    assert.equal((await logs()).length, 3, 'a reload with nothing new adds nothing');

    const res = await fetch(`${base}/teamclaude/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'work', disabled: false }),
    });
    assert.equal(res.status, 200, await res.text());
    const after = await logs();
    assert.equal(after.length, 4);
    assert.deepEqual([after[3].type, after[3].account, after[3].provider], ['enabled', 'work', 'anthropic']);

    // The switch endpoint (the dashboard, the CLI, attach mode) leaves one entry too.
    const sw = await fetch(`${base}/teamclaude/switch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'spare' }),
    });
    assert.equal(sw.status, 200, await sw.text());
    const switched = (await logs()).filter((/** @type {any} */ e) => e.type === 'switch');
    assert.deepEqual(switched.map((/** @type {any} */ e) => e.account), ['spare']);
  } finally {
    await server.stop();
  }
});
