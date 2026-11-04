import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSyncOwnMode, accountSyncLine, peerSyncCell, accountSyncOutcome, accountSyncRequest } from '../src/dashboard.js';

// The Account sync card's words for a store one of your own instances keeps
// (instance-sync.js): what the card and a Linked instances row say about a
// machine that keeps the accounts or follows one that does, and what the
// switch answers.

const view = (instance, extra = {}) => ({ ok: true, signedIn: false, sync: { lastSyncAt: 1, rows: 3 }, instance: { peers: [], canHost: true, supported: true, ...instance }, ...extra });

test('the own-store mode a view names', () => {
  assert.equal(accountSyncOwnMode(view({ mode: 'host' })), 'host');
  assert.equal(accountSyncOwnMode(view({ mode: 'follow', peer: 'hub' })), 'follow');
  assert.equal(accountSyncOwnMode(view({ mode: 'off' })), '');
  // An older server says nothing about it.
  assert.equal(accountSyncOwnMode({ ok: true, signedIn: true }), '');
  assert.equal(accountSyncOwnMode(null), '');
});

test('the card line for a machine that keeps the accounts, or follows one that does', () => {
  assert.deepEqual(accountSyncLine(view({ mode: 'host' }), 'this machine'), { kind: 'ok', text: 'On: this machine keeps the accounts for your other machines. 3 accounts in the store.' });
  assert.deepEqual(accountSyncLine(view({ mode: 'follow', peer: 'hub' }), 'desk'), { kind: 'ok', text: 'On: desk follows the accounts kept on hub. 3 accounts in the store.' });
  assert.deepEqual(accountSyncLine(view({ mode: 'follow', peer: 'hub' }, { sync: { lastSyncAt: 1, rows: 0, lastError: 'hub is unreachable (timed out)' } }), 'this machine'),
    { kind: 'error', text: 'On: this machine follows the accounts kept on hub. The last sync failed: hub is unreachable (timed out)' });
  assert.deepEqual(accountSyncLine(view({ mode: 'host' }, { sync: {} }), 'this machine'), { kind: 'ok', text: 'On: this machine keeps the accounts for your other machines. The first sync is under way.' });
  // Off both ways: as before.
  assert.deepEqual(accountSyncLine(view({ mode: 'off' }), 'this machine'), { kind: '', text: 'Off: this machine keeps its own sign-ins.' });
});

test('a Linked instances row says which machine keeps the accounts, and offers no callback.net sign-in beside a store of your own', () => {
  assert.deepEqual(peerSyncCell(view({ mode: 'host' }), 200, view({ mode: 'follow', peer: 'hub' })), { kind: 'ok', text: 'keeps the accounts', setUp: false });
  assert.deepEqual(peerSyncCell(view({ mode: 'follow', peer: 'hub' }), 200, view({ mode: 'host' })), { kind: 'ok', text: 'follows hub', setUp: false });
  assert.deepEqual(peerSyncCell(view({ mode: 'off' }), 200, view({ mode: 'host' })), { kind: '', text: 'off', setUp: false });
  assert.deepEqual(peerSyncCell(view({ mode: 'off' }), 200, view({ mode: 'off' })), { kind: '', text: 'off', setUp: true });
});

test('what the switch answers', () => {
  assert.deepEqual(accountSyncRequest('mode', { mode: 'host' }, 'k').url, '/teamclaude/account-sync/mode');
  assert.deepEqual(accountSyncOutcome({ ok: true, mode: 'host', peer: null }, 'mode', 'this machine'),
    { kind: 'ok', text: 'On: this machine keeps the accounts. On each of your other machines, choose Follow it here.' });
  assert.deepEqual(accountSyncOutcome({ ok: true, mode: 'host', peer: null }, 'mode', 'hub'),
    { kind: 'ok', text: 'On: hub keeps the accounts. On each of your other machines, choose Follow hub here.' });
  assert.deepEqual(accountSyncOutcome({ ok: true, mode: 'follow', peer: 'hub' }, 'mode', 'this machine'),
    { kind: 'ok', text: 'On: this machine follows hub. The accounts arrive with the first sync, in a moment.' });
  assert.deepEqual(accountSyncOutcome({ ok: true, mode: 'off', peer: null }, 'mode', 'this machine'), { kind: 'ok', text: 'Off. The accounts stay where they are.' });
  assert.deepEqual(accountSyncOutcome({ ok: false, error: 'this machine is signed in to callback.net; sign out first, so it syncs with one store only' }, 'mode', 'this machine'),
    { kind: 'error', text: 'could not change account sync: this machine is signed in to callback.net; sign out first, so it syncs with one store only' });
});
