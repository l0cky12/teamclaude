import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebAccountSync, AccountSyncError } from '../src/web-account-sync.js';

// The dashboard's Account sync card holds a callback.net sign-in across
// requests: `start` hands out the approval link, the approval is waited for in
// the background, and `status` says how it went. Every collaborator is a
// stand-in here (the sign-in, the token file, whoami, sign-out and the
// running CredentialSync), so nothing reaches callback.net or a config file.

/** Let the promise chains the class starts run to their end. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * A WebAccountSync over stand-ins. `approve()` lets the pending sign-in
 * finish with a token; `fail(err)` makes it fail.
 */
function harness({ token = null, whoami, beforeUrl } = {}) {
  const state = { token, saved: [], syncs: [], logouts: 0, whoamiCalls: 0, logs: [], loginOpts: null };
  let approve = () => {};
  let fail = () => {};
  const login = async (opts) => {
    state.loginOpts = opts;
    if (beforeUrl) throw beforeUrl;
    const approved = new Promise((resolve, reject) => { approve = resolve; fail = reject; });
    opts.onUrl('https://oid.jp/ABC123', { lifetimeSeconds: 900 });
    await approved;
    return { access_token: 'at-new', refresh_token: 'rt-new', client_id: 'oaap-x', obtained_at: 1 };
  };
  const sync = new WebAccountSync({
    sync: {
      summary: () => ({ lastSyncAt: null, lastError: null, rows: 0, tombstones: 0, signInNeeded: 0 }),
      sync: async (reason) => { state.syncs.push(reason); return { signedIn: !!state.token, added: 1 }; },
    },
    login,
    load: async () => state.token,
    save: async (t) => { state.saved.push(t); state.token = t; },
    whoami: whoami || (async () => { state.whoamiCalls++; return { id: 'u1', email: 'me@example.com', name: 'Me' }; }),
    logout: async () => { state.logouts++; const was = !!state.token; state.token = null; return { wasSignedIn: was, revoked: was }; },
    log: (l) => state.logs.push(l),
  });
  return { sync, state, approve: () => approve(), fail: (e) => fail(e) };
}

test('start answers with the approval link and the wait goes on in the background', async () => {
  const { sync, state, approve } = harness();
  const started = await sync.start();
  assert.equal(started.url, 'https://oid.jp/ABC123');
  assert.equal(started.lifetimeSeconds, 900);
  assert.match(started.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(sync.status(started.id), { state: 'waiting', error: null });
  assert.deepEqual((await sync.view()).signIn, { id: started.id, state: 'waiting' });

  approve();
  await settle();
  assert.deepEqual(sync.status(started.id), { state: 'succeeded', error: null });
  assert.equal(state.saved.length, 1, 'the token is saved once approved');
  assert.equal(state.saved[0].access_token, 'at-new');
  assert.deepEqual(state.syncs, ['dashboard sign-in'], 'a first pass runs at once');
  assert.ok(state.logs.some(l => /Signed in to callback\.net from the dashboard/.test(l)));
  assert.equal((await sync.view()).signIn, null, 'a settled sign-in is no longer offered as in progress');
});

test('start is refused while signed in, so a sign-in never switches the store silently', async () => {
  const { sync, state } = harness({ token: { access_token: 'at-1', refresh_token: 'rt-1' } });
  await assert.rejects(sync.start(), (err) => err instanceof AccountSyncError && /sign out first/.test(err.message));
  assert.equal(state.loginOpts, null, 'no sign-in was begun');
});

test('an approval that lands after Cancel is not kept', async () => {
  const { sync, state, approve } = harness();
  const { id } = await sync.start();
  assert.equal(sync.cancel(id), true);
  approve();
  await settle();
  assert.equal(sync.status(id).state, 'cancelled');
  assert.deepEqual(state.saved, [], 'nothing saved');
  assert.deepEqual(state.syncs, [], 'no pass');
  assert.equal(sync.cancel(id), false, 'a second cancel has nothing to stop');
});

test('cancel cuts the pause between polls short', async () => {
  const { sync, state } = harness();
  const { id } = await sync.start();
  const pause = state.loginOpts.sleep(60_000);
  sync.cancel(id);
  await assert.rejects(pause, { name: 'AbortError' });
});

test('a sign-in that fails after the link says why, one line', async () => {
  const { sync, state, fail } = harness();
  const { id } = await sync.start();
  fail(new Error('the sign-in was not approved within 15 minutes\nsecond line'));
  await settle();
  const st = sync.status(id);
  assert.equal(st.state, 'failed');
  assert.match(st.error, /not approved within 15 minutes/);
  assert.doesNotMatch(st.error, /\n/);
  assert.deepEqual(state.saved, []);
});

test('a failure before any link is the start request\'s own', async () => {
  const { sync } = harness({ beforeUrl: new Error('callback.net API error (HTTP 503)') });
  await assert.rejects(sync.start(), /HTTP 503/);
});

test('starting again replaces a sign-in still waiting', async () => {
  const { sync } = harness();
  const first = await sync.start();
  const second = await sync.start();
  assert.notEqual(first.id, second.id);
  assert.equal(sync.status(first.id).state, 'unknown', 'only the current sign-in is known');
  assert.equal(sync.status(second.id).state, 'waiting');
});

test('view asks callback.net who is signed in once per session', async () => {
  const { sync, state } = harness({ token: { access_token: 'at-1', refresh_token: 'rt-1' } });
  const a = await sync.view();
  const b = await sync.view();
  assert.equal(a.signedIn, true);
  assert.deepEqual(a.user, { email: 'me@example.com', name: 'Me' });
  assert.deepEqual(b.user, a.user);
  assert.equal(state.whoamiCalls, 1);
  // A new session (another refresh token) is asked about again.
  state.token = { access_token: 'at-2', refresh_token: 'rt-2' };
  await sync.view();
  assert.equal(state.whoamiCalls, 2);
});

test('view reports an expired session without failing', async () => {
  const expired = Object.assign(new Error('not signed in'), { loginRequired: true });
  const { sync } = harness({ token: { access_token: 'at-1' }, whoami: async () => { throw expired; } });
  const v = await sync.view();
  assert.equal(v.signedIn, true);
  assert.equal(v.user, null);
  assert.match(v.userError, /session has expired/);
});

test('view when signed out does not call callback.net', async () => {
  const { sync, state } = harness();
  const v = await sync.view();
  assert.equal(v.signedIn, false);
  assert.equal(v.user, null);
  assert.equal(state.whoamiCalls, 0);
});

test('syncNow needs a session; signOut ends it and runs a pass that forgets the store', async () => {
  const { sync, state } = harness();
  await assert.rejects(sync.syncNow(), (err) => err instanceof AccountSyncError);
  state.token = { access_token: 'at-1', refresh_token: 'rt-1' };
  assert.deepEqual(await sync.syncNow(), { signedIn: true, added: 1 });
  const out = await sync.signOut();
  assert.deepEqual(out, { wasSignedIn: true, revoked: true });
  assert.equal(state.logouts, 1);
  assert.deepEqual(state.syncs, ['dashboard', 'sign-out']);
  assert.ok(state.logs.some(l => /Signed out of callback\.net from the dashboard/.test(l)));
});
