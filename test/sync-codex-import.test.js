import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { syncAccountsFromDisk } from '../src/sync-accounts.js';

// A Codex account that reads its login from a Codex CLI auth.json
// (`importFrom`). Startup read it in that file's format; a reload read it with
// the Claude reader, which finds no token there, so `codex login` followed by
// a reload left the account on its old, rejected token. The dashboard sends a
// signed-out file-backed Codex account down exactly that path.

test('a reload reads a Codex importFrom file in the Codex format, and the fresh login brings the account back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-codex-import-'));
  try {
    const file = join(dir, 'auth.json');
    const entry = { id: 'id-c', name: 'c@example.com', type: 'oauth', provider: 'codex', importFrom: file };
    const accountManager = new AccountManager([{ ...entry, accessToken: 'old-access', refreshToken: 'old-refresh' }], 0.98);
    accountManager.accounts[0].status = 'error';

    await writeFile(file, JSON.stringify({ tokens: { access_token: 'new-access', refresh_token: 'new-refresh', account_id: 'acct-demo' } }));
    await syncAccountsFromDisk({ accounts: [{ ...entry }] }, { accounts: [{ ...entry }] }, accountManager);

    const account = accountManager.accounts[0];
    assert.equal(account.credential, 'new-access');
    assert.equal(account.refreshToken, 'new-refresh');
    assert.equal(account.status, 'active', 'the new login clears the error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a Claude importFrom file is still read in the Claude format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-claude-import-'));
  try {
    const file = join(dir, '.credentials.json');
    const entry = { id: 'id-a', name: 'a@example.com', type: 'oauth', importFrom: file };
    const accountManager = new AccountManager([{ ...entry, accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }], 0.98);
    await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 4102444800000 } }));
    await syncAccountsFromDisk({ accounts: [{ ...entry }] }, { accounts: [{ ...entry }] }, accountManager);
    assert.equal(accountManager.accounts[0].credential, 'new-access');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
