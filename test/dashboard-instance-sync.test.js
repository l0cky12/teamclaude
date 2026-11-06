import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSyncOwnMode, accountSyncMembers, accountSyncLine, peerSyncCell, accountSyncOutcome, accountSyncRequest } from '../src/dashboard.js';

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
  assert.deepEqual(accountSyncLine(view({ mode: 'follow', peer: 'hub', peers: ['hub'] }), 'desk'), { kind: 'ok', text: 'On: desk follows the accounts kept on hub. 3 accounts in the store.' });
  // The instance it follows was unlinked: nothing syncs, and the card says so.
  assert.deepEqual(accountSyncLine(view({ mode: 'follow', peer: 'hub', peers: [] }), 'desk'),
    { kind: 'error', text: 'On, but desk follows hub, which is no longer a linked instance: nothing is synced, and a sign-in that runs out is not renewed. Link it again, or turn this off.' });
  assert.deepEqual(accountSyncLine(view({ mode: 'follow', peer: 'hub', peers: ['hub'] }, { sync: { lastSyncAt: 1, rows: 0, lastError: 'hub is unreachable (timed out)' } }), 'this machine'),
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

// A master and backups (sync-cluster.js): the card names the master and this
// machine's place, lists each member, and says when there is no master.
test('the card and a Linked instances row for a master and backups', () => {
  const cluster = (cl, self = 'desk') => view({ mode: 'cluster', members: ['server', 'desk', 'laptop'], self, cluster: cl });
  const states = [
    { name: 'server', self: false, state: 'up', role: 'master' },
    { name: 'desk', self: true, state: 'up', role: 'backup' },
    { name: 'laptop', self: false, state: 'down', role: null },
  ];
  const backup = cluster({ role: 'backup', master: 'server', memberStates: states });
  assert.equal(accountSyncOwnMode(backup), 'cluster');
  assert.deepEqual(accountSyncLine(backup, 'this machine'), { kind: 'ok', text: 'On: server is the master, and this machine keeps a copy to take over with. 3 accounts in the store.' });
  assert.deepEqual(accountSyncMembers(backup).map(m => [m.kind, m.text]), [
    ['ok', 'server: master'],
    ['', 'desk (this machine): up, backup 1'],
    ['error', 'laptop: down, backup 2'],
  ]);
  assert.deepEqual(accountSyncLine(cluster({ role: 'master', master: 'server', memberStates: [] }, 'server'), 'this machine'),
    { kind: 'ok', text: 'On: this machine is the master. 3 accounts in the store.' });
  assert.deepEqual(accountSyncLine(cluster({ role: 'follower', master: 'server', memberStates: [] }, 'pi'), 'pi'),
    { kind: 'ok', text: 'On: server is the master, and pi follows it. 3 accounts in the store.' });
  assert.deepEqual(accountSyncLine(cluster({ role: 'backup', master: null, reason: 'waiting to hear from server', memberStates: [] }), 'this machine'),
    { kind: 'warn', text: 'On, with a master and backups, but there is no master right now: waiting to hear from server. Sign-ins that run out wait until there is one.' });

  assert.deepEqual(peerSyncCell(backup, 200, view({ mode: 'off' })), { kind: 'ok', text: 'master and backups: a backup (master: server)', setUp: false });
  assert.deepEqual(peerSyncCell(cluster({ role: 'master', master: 'server' }, 'server'), 200, view({ mode: 'off' })), { kind: 'ok', text: 'master and backups: the master', setUp: false });
  assert.deepEqual(peerSyncCell(cluster({ role: 'backup', master: null }), 200, view({ mode: 'off' })), { kind: 'warn', text: 'master and backups: no master right now', setUp: false });

  assert.deepEqual(accountSyncOutcome({ ok: true, mode: 'cluster', peer: null, members: ['server', 'desk'] }, 'mode', 'this machine'),
    { kind: 'ok', text: 'On: master and backups server, desk. Set the same list, in the same order, on each of them. The first one up is the master.' });
  // An older server, or another mode: no member lines.
  assert.deepEqual(accountSyncMembers(view({ mode: 'host' })), []);
});
