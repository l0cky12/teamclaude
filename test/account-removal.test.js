import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createAccountRemover, serialQueue, RemovalRefused } from '../src/account-removal.js';
import { removedAccountIds } from '../src/account-pairing.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// The dashboard's Remove against a running fleet. What matters is that it
// never lands inside a reload: a reload walks the fleet by position and awaits
// between steps, so a splice in one of those gaps sends the reload's next
// write to whichever account slid into the removed one's place.

// Lets every queued microtask run, so a job that could start has started.
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function fleet() {
  const entries = [
    { id: 'id-a', name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' },
    { id: 'id-b', name: 'b@example.com', type: 'apikey', apiKey: 'sk-demo-2' },
    { id: 'id-c', name: 'c@example.com', type: 'apikey', apiKey: 'sk-demo-3' },
  ];
  const config = { accounts: entries.map(e => ({ ...e })) };
  const accountManager = new AccountManager(entries.map(e => ({ ...e })), 0.98);
  return { config, accountManager };
}

test('the queue runs jobs one at a time, in order, past a failure', async () => {
  const queue = serialQueue();
  const order = [];
  const gate = deferred();
  const first = queue(async () => { order.push('first:start'); await gate.promise; order.push('first:end'); throw new Error('boom'); });
  const second = queue(async () => { order.push('second'); return 2; });
  await settle();
  assert.deepEqual(order, ['first:start'], 'the second waits for the first');
  gate.resolve();
  await assert.rejects(first, /boom/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('a removal waits for a reload in flight, so the reload writes to the account it meant', async () => {
  const { config, accountManager } = fleet();
  const queue = serialQueue();
  const remove = createAccountRemover({ accountManager, config, exclusive: queue, persist: async () => {} });
  const [a, b] = accountManager.accounts;

  // A reload the way sync-accounts walks the fleet: a position read, an await
  // (an importFrom file being read), then a write to that position.
  const fileRead = deferred();
  const reload = queue(async () => {
    const index = accountManager.accounts.indexOf(b);
    await fileRead.promise;
    accountManager.accounts[index].credential = 'fresh-for-b';
  });

  const removal = remove(a);
  await settle();
  assert.equal(accountManager.accounts.length, 3, 'nothing is spliced while the reload is mid-walk');

  fileRead.resolve();
  await reload;
  const result = await removal;
  assert.equal(result.name, 'a@example.com');
  assert.deepEqual(accountManager.accounts.map(x => x.name), ['b@example.com', 'c@example.com']);
  assert.equal(b.credential, 'fresh-for-b', 'the reload\'s write reached b');
  assert.notEqual(accountManager.accounts[1].credential, 'fresh-for-b', 'and not the account that slid into its place');
  assert.deepEqual(config.accounts.map(x => x.id), ['id-b', 'id-c']);
});

test('a removal saves, records the id as removed, and lands on the event log', async () => {
  const { config, accountManager } = fleet();
  let saves = 0;
  const remove = createAccountRemover({ accountManager, config, exclusive: serialQueue(), persist: async () => { saves++; } });
  await remove(accountManager.accounts[2]);
  assert.equal(saves, 1);
  // The save adopts disk rows that are not in memory; the mark is what keeps
  // it from reading the removed row straight back in.
  assert.ok(removedAccountIds(config).has('id-c'), 'the removed id is remembered for the save');
  const events = accountManager.events.since(0).events;
  assert.ok(events.some(e => e.type === 'account_removed' && e.account === 'c@example.com'));
});

test('an account a reload already removed is a 404, not a second removal', async () => {
  const { config, accountManager } = fleet();
  const remove = createAccountRemover({ accountManager, config, exclusive: serialQueue(), persist: async () => {} });
  const a = accountManager.accounts[0];
  accountManager.removeAccount(0);
  await assert.rejects(remove(a), err => err instanceof RemovalRefused && err.status === 404);
  assert.equal(accountManager.accounts.length, 2);
});

test('the last account is refused, because a server with none will not start', async () => {
  const config = { accounts: [{ id: 'id-a', name: 'a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }] };
  const accountManager = new AccountManager(config.accounts.map(e => ({ ...e })), 0.98);
  let saves = 0;
  const remove = createAccountRemover({ accountManager, config, exclusive: serialQueue(), persist: async () => { saves++; } });
  await assert.rejects(remove(accountManager.accounts[0]), err => err instanceof RemovalRefused && err.status === 409 && /sign in another/.test(err.message));
  assert.equal(accountManager.accounts.length, 1);
  assert.equal(config.accounts.length, 1);
  assert.equal(saves, 0);
});

test('a reload keeps the "sign-in comes from a file" flag in step with the config', async () => {
  const entry = { id: 'id-a', name: 'a@example.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: 4102444800000 };
  const memConfig = { accounts: [{ ...entry }] };
  const accountManager = new AccountManager([{ ...entry }], 0.98);
  assert.equal(accountManager.accounts[0].credentialsFromFile, false);
  // A file that does not exist: the re-import fails and is reported, and the
  // account keeps its tokens, but where they come from has still changed.
  const orig = console.error;
  console.error = () => {};
  try {
    await syncAccountsFromDisk({ accounts: [{ ...entry, importFrom: '/nonexistent/tc-demo-creds.json' }] }, memConfig, accountManager);
  } finally {
    console.error = orig;
  }
  assert.equal(accountManager.accounts[0].credentialsFromFile, true);
  await syncAccountsFromDisk({ accounts: [{ ...entry }] }, memConfig, accountManager);
  assert.equal(accountManager.accounts[0].credentialsFromFile, false);
});
