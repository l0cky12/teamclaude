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
