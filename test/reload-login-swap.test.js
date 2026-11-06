// A reload re-reads an importFrom account's credentials file. When the CLI
// that owns the file signs in as someone else, the file then holds a different
// login: its token has to travel with that login's identity, and nothing the
// proxy learned about the previous login (its quota above all) may be read as
// the new one's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';
import { applyAuthHeaders } from '../src/provider.js';
import { Prober } from '../src/prober.js';
import { normalizeGrokBilling } from '../src/grok-usage.js';

const GROK_KEY = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';

/** Grok Build's auth.json holding one login. */
function grokFile(user, token) {
  return JSON.stringify({
    [GROK_KEY]: { key: token, refresh_token: `r-${token}`, expires_at: new Date(Date.now() + 3600_000).toISOString(), user_id: user, email: `${user}@example.com` },
  });
}

/** Codex's auth.json holding one login. */
function codexFile(accountId, token) {
  return JSON.stringify({ tokens: { access_token: token, refresh_token: `r-${token}`, account_id: accountId } });
}

async function fleet(entry, contents) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-login-swap-'));
  const file = join(dir, 'auth.json');
  await writeFile(file, contents);
  const disk = { accounts: [{ ...entry, importFrom: file }] };
  ensureAccountIds(disk.accounts);
  const memConfig = { accounts: disk.accounts.map(a => ({ ...a })) };
  const am = new AccountManager(await resolveAccounts(disk), 0.98);
  return { dir, file, disk, memConfig, am };
}

test('a Grok file now holding another login sends that login\'s identity and starts its quota fresh', async () => {
  const { dir, file, disk, memConfig, am } = await fleet({ name: 'grok', type: 'oauth', provider: 'grok' }, grokFile('user-a', 'tok-a'));
  try {
    const before = am.accounts[0];
    assert.equal(before.userId, 'user-a');
    before.quota.unified7d = 0.9;

    await writeFile(file, grokFile('user-b', 'tok-b'));
    await syncAccountsFromDisk(disk, memConfig, am);

    assert.equal(am.accounts.length, 1, 'the row keeps one running account');
    const after = am.accounts[0];
    assert.equal(after.id, disk.accounts[0].id, 'still paired with its config row');
    assert.equal(after.credential, 'tok-b');
    assert.equal(after.userId, 'user-b');
    const headers = {};
    applyAuthHeaders(headers, after);
    assert.equal(headers.authorization, 'Bearer tok-b');
    assert.equal(headers['x-userid'], 'user-b', 'the new token went out under the old login\'s user id');
    assert.equal(headers['x-email'], 'user-b@example.com');
    assert.notEqual(after.quota.unified7d, 0.9, 'the previous login\'s quota was read as the new one\'s');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same Grok login with a rotated token keeps what was learned about it', async () => {
  const { dir, file, disk, memConfig, am } = await fleet({ name: 'grok', type: 'oauth', provider: 'grok' }, grokFile('user-a', 'tok-a'));
  try {
    const before = am.accounts[0];
    before.quota.unified7d = 0.9;

    await writeFile(file, grokFile('user-a', 'tok-a2'));
    await syncAccountsFromDisk(disk, memConfig, am);

    assert.equal(am.accounts[0], before, 'the account object was replaced for a token rotation');
    assert.equal(before.credential, 'tok-a2');
    assert.equal(before.quota.unified7d, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Codex file now holding another ChatGPT account scopes the new token to it', async () => {
  const { dir, file, disk, memConfig, am } = await fleet({ name: 'codex', type: 'oauth', provider: 'codex' }, codexFile('acct-a', 'tok-a'));
  try {
    am.accounts[0].quota.unified7d = 0.9;

    await writeFile(file, codexFile('acct-b', 'tok-b'));
    await syncAccountsFromDisk(disk, memConfig, am);

    const after = am.accounts[0];
    const headers = {};
    applyAuthHeaders(headers, after);
    assert.equal(headers.authorization, 'Bearer tok-b');
    assert.equal(headers['chatgpt-account-id'], 'acct-b');
    assert.notEqual(after.quota.unified7d, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a swapped login stays in place across later reloads when the config row still names the old one', async () => {
  // A row written by a sign-in carries the login's ids, and nothing rewrites
  // them when the file changes hands, so pairing must not hang on them.
  const { dir, file, disk, memConfig, am } = await fleet({ name: 'grok', type: 'oauth', provider: 'grok', userId: 'user-a' }, grokFile('user-a', 'tok-a'));
  try {
    await writeFile(file, grokFile('user-b', 'tok-b'));
    for (let i = 0; i < 3; i++) await syncAccountsFromDisk(disk, memConfig, am);
    assert.equal(am.accounts.length, 1);
    assert.equal(memConfig.accounts.length, 1);
    assert.equal(am.accounts[0].credential, 'tok-b');
    assert.equal(am.accounts[0].userId, 'user-b');
    assert.equal(am.accounts[0].id, disk.accounts[0].id);
    assert.equal(memConfig.accounts[0].userId, 'user-b', 'the running config still names the old login');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a probe of the previous login that answers after the swap is not read as the new login\'s', async () => {
  const { dir, file, disk, memConfig, am } = await fleet({ name: 'grok', type: 'oauth', provider: 'grok' }, grokFile('user-a', 'tok-a'));
  try {
    /** @type {(value: any) => void} */
    let answer = () => {};
    /** @type {() => void} */
    let asked = () => {};
    const probing = new Promise(resolve => { asked = () => resolve(undefined); });
    const prober = new Prober(am, {
      log: () => {},
      grokProbeFn: () => { asked(); return new Promise(resolve => { answer = resolve; }); },
    });
    const probe = prober.probeOne(am.accounts[0]);
    await probing;

    await writeFile(file, grokFile('user-b', 'tok-b'));
    await syncAccountsFromDisk(disk, memConfig, am);
    answer(normalizeGrokBilling({ config: { creditUsagePercent: 100, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: new Date(Date.now() + 86_400_000).toISOString() } } }));
    await probe;

    assert.equal(am.accounts[0].userId, 'user-b');
    assert.notEqual(am.accounts[0].quota.unified7d, 1, 'the old login\'s reading landed on the new login');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a refresh of the previous login that finishes after the swap is not persisted for the new login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-login-swap-'));
  const file = join(dir, 'auth.json');
  try {
    await writeFile(file, grokFile('user-a', 'tok-a'));
    const disk = { accounts: [{ name: 'grok', type: 'oauth', provider: 'grok', importFrom: file }] };
    ensureAccountIds(disk.accounts);
    const memConfig = { accounts: disk.accounts.map(a => ({ ...a })) };
    /** @type {(tokens: any) => void} */
    let finish = () => {};
    /** @type {() => void} */
    let started = () => {};
    const refreshStarted = new Promise(resolve => { started = () => resolve(undefined); });
    const am = new AccountManager(await resolveAccounts(disk), 0.98, {
      grokRefreshFn: () => { started(); return new Promise(resolve => { finish = resolve; }); },
    });
    /** @type {number[]} */
    const persisted = [];
    am.onTokenRefresh((/** @type {number} */ idx) => { persisted.push(idx); });
    const refreshing = am.ensureTokenFresh(0, true);
    await refreshStarted;

    await writeFile(file, grokFile('user-b', 'tok-b'));
    await syncAccountsFromDisk(disk, memConfig, am);
    finish({ accessToken: 'tok-a-renewed', refreshToken: 'r-a-renewed', expiresAt: Date.now() + 3600_000 });
    await refreshing;

    assert.equal(am.accounts[0].credential, 'tok-b');
    assert.deepEqual(persisted, [], 'the old login\'s renewed tokens were persisted onto the new login\'s row');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
