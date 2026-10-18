import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, distributionMode, distributesSessions } from '../src/account-manager.js';
import { DISTRIBUTE_MODES, setDistribution } from '../src/config-ops.js';
import { DEFAULT_PROVIDER } from '../src/provider.js';

// Drain mode (`distributeSessions: "drain"`): every session on one account, the
// one whose governing weekly resets soonest, until it cannot serve; then the
// next. Every test sets quota directly and asserts the pick. Resets are placed
// at whole-hour offsets from the top of the NEXT hour, read off the clock at
// the start of the test, so which hour bucket a reset falls in is fixed by the
// fixture rather than by when the suite happens to run.

const H = 3600_000;
const M = 60_000;
const OPUS = 'claude-opus-5';
const FABLE = 'claude-fable-5';
const HAIKU = 'claude-haiku-5';
const CODEX = 'gpt-5-codex';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

function mgr(accounts, opts = {}) {
  const list = accounts.map(a => (typeof a === 'string' ? oauth(a) : a));
  return new AccountManager(list, 0.98, { distributeSessions: 'drain', ...opts });
}

// The top of the next hour: `hourBase() + n * H + m * M` with 0 <= m < 60 lies
// in hour bucket n of the fixture whatever the wall clock reads.
function hourBase() {
  return (Math.floor(Date.now() / H) + 1) * H;
}

// The shared weekly window: used fraction, reset timestamp.
function weekly(am, index, used, resetAt) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = resetAt;
  am.accounts[index].probing = false;
}

// The Fable weekly window.
function fableWeekly(am, index, used, resetAt) {
  const q = am.accounts[index].quota;
  q.unified7dFable = used;
  q.unified7dFableReset = resetAt;
}

// The 5-hour window.
function session(am, index, used, resetAt) {
  const q = am.accounts[index].quota;
  q.unified5h = used;
  q.unified5hReset = resetAt;
}

function pick(am, model = OPUS, provider = DEFAULT_PROVIDER) {
  return am.getActiveAccount(null, model, null, null, provider).name;
}

// Run `fn` with console.log captured; returns the drain-mode lines it printed.
function drainLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines.filter(l => l.includes('Drain:'));
}

// ── Mode plumbing ───────────────────────────────────────────────────────────

test('drain is a named mode that does not count as distributing', () => {
  assert.equal(distributionMode('drain'), 'drain');
  assert.equal(distributionMode(' Drain '), 'drain');
  assert.equal(distributesSessions('drain'), false);
  assert.equal(distributesSessions('off'), false);
  for (const mode of ['even', 'adaptive', 'affinity']) assert.equal(distributesSessions(mode), true);

  const am = mgr(['a', 'b']);
  assert.equal(am.distributionMode, 'drain');
  assert.equal(am.distributeSessions, false);
  assert.equal(am.sessionStats().mode, 'drain');
  const status = am.getStatus();
  assert.equal(status.sessions.mode, 'drain');
  assert.equal(status.sessions.distribute, false);
});

test('the config writer stores drain as the router reads it', () => {
  assert.equal(DISTRIBUTE_MODES.drain.value, 'drain');
  const config = {};
  assert.equal(setDistribution(config, 'drain'), true);
  assert.equal(config.distributeSessions, 'drain');
  assert.equal(setDistribution(config, 'drain'), false);
  assert.equal(distributionMode(config.distributeSessions), 'drain');
});

test('drain routes sessions as off does: no spreading, no pin honoured', () => {
  const base = hourBase();
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.2, base + 24 * H);
  weekly(am, 1, 0.2, base + 48 * H);
  // A pin on 'b' from earlier traffic. Distribution would send sess-1 back
  // there; drain, like off, keeps every session on the one account.
  am.recordSession('sess-1', 1, OPUS);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-2').name, 'a');
  // Untagged requests are not round-robined either.
  assert.equal(pick(am), 'a');
  assert.equal(pick(am), 'a');
});

test('switching to drain from a distributing mode drains pinned sessions as off does', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { distributeSessions: true });
  const s1 = am.getActiveAccount(null, null, null, 'sess-1');
  am.recordSession('sess-1', s1.index);
  const s2 = am.getActiveAccount(null, null, null, 'sess-2');
  am.recordSession('sess-2', s2.index);
  assert.equal(s2.name, 'b');
  am.setDistributeSessions('drain');
  assert.equal(am.distributionMode, 'drain');
  assert.equal(am.distributeSessions, false);
  // The session pinned before the switch keeps its account and its cache...
  assert.equal(am.getActiveAccount(null, null, null, 'sess-2').name, 'b');
  assert.equal(am.getStatus().sessions.draining, 2);
  // ...and a new one is not distributed.
  assert.equal(am.getActiveAccount(null, null, null, 'sess-3').name, 'a');
  // Re-applying drain (every config reload) does not restart that drain, and
  // a distributing mode cancels it.
  am.setDistributeSessions('drain');
  assert.equal(am.getStatus().sessions.draining, 2);
  am.setDistributeSessions('adaptive');
  assert.equal(am.getStatus().sessions.draining, 0);
});

test('drain is applied live from off and back', () => {
  const base = hourBase();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  weekly(am, 0, 0.2, base + 48 * H);
  weekly(am, 1, 0.2, base + 24 * H);
  // Off: sticky on the current account, however soon another resets.
  assert.equal(pick(am), 'a');
  am.setDistributeSessions('drain');
  assert.equal(am.getStatus().sessions.draining, 0);
  drainLog(() => assert.equal(pick(am), 'b'));
  am.setDistributeSessions(false);
  assert.equal(am.distributionMode, 'off');
  assert.equal(am.getStatus().drainQueue, null);
});

// ── Selection order ─────────────────────────────────────────────────────────

test('drain stays on the soonest-resetting account until it runs out, then takes the next soonest', () => {
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  weekly(am, 0, 0.10, base + 72 * H);
  weekly(am, 1, 0.50, base + 24 * H);
  weekly(am, 2, 0.30, base + 48 * H);
  drainLog(() => am.selectActiveAccount());
  assert.equal(am.currentIndex, 1);
  for (let i = 0; i < 3; i++) assert.equal(pick(am), 'b');

  // Usage climbing on 'b' moves nothing while it is under the threshold.
  am.accounts[1].quota.unified7d = 0.95;
  assert.equal(pick(am), 'b');

  am.accounts[1].quota.unified7d = 0.99;
  let lines = drainLog(() => assert.equal(pick(am), 'c'));
  assert.equal(am.currentIndex, 2);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: switched to account "c" — "b" cannot serve/);
  // Logged once: the next request finds the cursor already there.
  lines = drainLog(() => assert.equal(pick(am), 'c'));
  assert.equal(lines.length, 0);
});

test('a Fable request ranks by the Fable weekly reset and moves only its own scope', () => {
  const base = hourBase();
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.2, base + 24 * H);
  fableWeekly(am, 0, 0.1, base + 100 * H);
  weekly(am, 1, 0.2, base + 72 * H);
  fableWeekly(am, 1, 0.1, base + 30 * H);
  drainLog(() => am.selectActiveAccount());
  assert.equal(am.currentIndex, 0);

  const lines = drainLog(() => {
    for (let i = 0; i < 3; i++) {
      assert.equal(pick(am, OPUS), 'a', 'shared weekly: a resets first');
      assert.equal(pick(am, FABLE), 'b', 'Fable weekly: b resets first');
    }
  });
  // Neither scope drags the other: the shared cursor never left 'a', and the
  // Fable scope moved once.
  assert.equal(am.currentIndex, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: routing "claude-fable-5" to "b" — its weekly quota resets sooner than "a"'s/);
  // Status names where Fable traffic actually goes.
  assert.equal(am.getStatus().routes.find(r => r.name === 'fable').target, 'b');
});

test('a holder that runs out is replaced by the full drain order, not by the shared cursor', () => {
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  // 'a' holds the shared cursor. For Fable, 'b' resets first; 'a' and 'c'
  // reset in the same later hour, 'a' with 10% of its Fable weekly left and
  // 'c' with 70%.
  weekly(am, 0, 0.2, base + 24 * H);
  fableWeekly(am, 0, 0.90, base + 50 * H + 5 * M);
  weekly(am, 1, 0.2, base + 72 * H);
  fableWeekly(am, 1, 0.10, base + 30 * H);
  weekly(am, 2, 0.2, base + 72 * H);
  fableWeekly(am, 2, 0.30, base + 50 * H + 40 * M);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(pick(am, FABLE), 'b');
  });

  // The Fable holder runs out. Its conversations lose their cache wherever
  // they go, so the shared cursor has no claim on them: the pick is the drain
  // order's, and the same-hour tie goes to the most remaining.
  am.accounts[1].quota.unified7dFable = 0.99;
  assert.deepEqual(am._drainOrder(null, FABLE).map(a => a.name), ['c', 'a']);
  assert.equal(am.getStatus().routes.find(r => r.name === 'fable').target, 'c');
  const lines = drainLog(() => assert.equal(pick(am, FABLE), 'c'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: routing "claude-fable-5" to "c" — "b" cannot serve/);
  // The shared scope did not move, and 'c' now holds Fable.
  assert.equal(am.currentIndex, 0);
  assert.equal(drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(pick(am, FABLE), 'c');
  }).length, 0);
});

test('a same-hour tie is broken by the most weekly remaining', () => {
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  // 'a' resets 35 minutes before 'b', but in the same hour; 'b' has more left.
  weekly(am, 0, 0.60, base + 24 * H + 5 * M);
  weekly(am, 1, 0.20, base + 24 * H + 40 * M);
  weekly(am, 2, 0.00, base + 48 * H);
  assert.deepEqual(am._drainOrder().map(a => a.name), ['b', 'a', 'c']);
  drainLog(() => am.selectActiveAccount());
  assert.equal(am.currentIndex, 1);
});

test('no flap within one reset hour: the remaining-quota tie-break never moves the cursor', () => {
  const base = hourBase();
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.60, base + 24 * H + 5 * M);
  weekly(am, 1, 0.20, base + 24 * H + 40 * M);
  drainLog(() => am.selectActiveAccount());
  assert.equal(pick(am), 'b');
  // 'b' now has less left than 'a'. A fresh pick would choose 'a'; the account
  // in use stays.
  am.accounts[1].quota.unified7d = 0.90;
  assert.equal(am._drainOrder()[0].name, 'a');
  const lines = drainLog(() => {
    for (let i = 0; i < 5; i++) assert.equal(pick(am), 'b');
  });
  assert.equal(lines.length, 0);
  // The queue says what the router will do, not what a fresh pick would.
  assert.deepEqual(am.getStatus().drainQueue[DEFAULT_PROVIDER], ['b', 'a']);
  // Only running out moves it.
  am.accounts[1].quota.unified7d = 0.99;
  drainLog(() => assert.equal(pick(am), 'a'));
});

test('an account whose 5-hour window is used up is skipped, and the cursor returns when it resets', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  weekly(am, 0, 0.30, base + 24 * H);
  session(am, 0, 0.99, Date.now() + 2 * H);
  weekly(am, 1, 0.30, base + 48 * H);
  weekly(am, 2, 0.30, base + 72 * H);
  drainLog(() => am.selectActiveAccount());
  assert.equal(am.currentIndex, 1, 'a is gated by its 5-hour window');
  assert.equal(pick(am), 'b');

  t.mock.timers.tick(2 * H + 1);
  // Its 5-hour window reset: 'a' is available again and resets a day sooner,
  // so the cursor goes back to it at once rather than when 'b' runs out.
  const lines = drainLog(() => assert.equal(pick(am), 'a'));
  assert.equal(am.currentIndex, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: switched to account "a" — its weekly quota resets sooner than "b"'s/);
});

test('an account whose rate-limit hold ends with a sooner reset takes the cursor back', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', 'b']);
  weekly(am, 0, 0.30, base + 24 * H);
  weekly(am, 1, 0.30, base + 48 * H);
  assert.equal(pick(am), 'a');
  drainLog(() => am.markRateLimited(0, 60));
  drainLog(() => assert.equal(pick(am), 'b'));
  assert.equal(pick(am), 'b');
  t.mock.timers.tick(61_000);
  drainLog(() => assert.equal(pick(am), 'a'));
  assert.equal(am.currentIndex, 0);
});

test('a better priority tier beats a sooner reset, and takes the cursor back when it returns', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr([oauth('a', { priority: 1 }), oauth('b', { priority: 0 })]);
  weekly(am, 0, 0.30, base + 2 * H);
  weekly(am, 1, 0.30, base + 100 * H);
  drainLog(() => am.selectActiveAccount());
  assert.equal(am.currentIndex, 1);
  assert.equal(pick(am), 'b');

  session(am, 1, 0.99, Date.now() + H);
  drainLog(() => assert.equal(pick(am), 'a'));
  t.mock.timers.tick(H + 1);
  const lines = drainLog(() => assert.equal(pick(am), 'b'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: switched to account "b" — higher priority than "a"/);
});

test('an unknown weekly reset ranks first for a new pick but never displaces the account in use', () => {
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  weekly(am, 0, 0.30, base + 24 * H);
  // 'b' has no weekly reading at all (a lapsed window reads like this).
  weekly(am, 2, 0.30, base + 72 * H);
  assert.equal(pick(am), 'a');
  const lines = drainLog(() => assert.equal(pick(am), 'a'));
  assert.equal(lines.length, 0);
  // Once 'a' cannot serve, a pick has to be made, and the unknown goes first
  // so its window is learned.
  am.accounts[0].quota.unified7d = 0.99;
  drainLog(() => assert.equal(pick(am), 'b'));
});

test('a move off a usable account goes only to one that may displace it, never to an unknown reset', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  weekly(am, 0, 0.30, base + 48 * H);
  weekly(am, 1, 0.30, base + 24 * H);
  session(am, 1, 0.99, Date.now() + 2 * H);
  // 'c' has no weekly reading yet, so it heads a fresh pick.
  assert.equal(am._drainOrder()[0].name, 'c');
  assert.equal(pick(am), 'a');

  t.mock.timers.tick(2 * H + 1);
  // 'b' is back and resets a day sooner than 'a': a reason to move. The move
  // goes to 'b' itself, not to the head of a fresh pick: moving to 'c' would
  // be a move an unknown reset made, and would move again to 'b' as soon as
  // c's window came back later than b's.
  const status = am.getStatus();
  assert.deepEqual(status.drainQueue[DEFAULT_PROVIDER], ['b', 'c', 'a']);
  assert.equal(status.defaultTarget, 'b');
  const lines = drainLog(() => assert.equal(pick(am), 'b'));
  assert.equal(am.currentIndex, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: switched to account "b" — its weekly quota resets sooner than "a"'s/);

  // Learning c's window later than b's moves nothing.
  weekly(am, 2, 0.30, base + 72 * H);
  assert.equal(drainLog(() => assert.equal(pick(am), 'b')).length, 0);
});

test('a move to a better tier prefers a known reset there, and the unknown waits for a pick that has to be made', () => {
  const base = hourBase();
  const am = mgr([oauth('a', { priority: 1 }), oauth('b'), oauth('c'), oauth('d', { priority: 1 })]);
  weekly(am, 0, 0.30, base + 48 * H);
  weekly(am, 1, 0.30, base + 24 * H);
  // 'c' has no weekly reading.
  am.setDisabled(1, true);
  am.setDisabled(2, true);
  weekly(am, 3, 0.30, base + 2 * H);
  drainLog(() => assert.equal(pick(am), 'd'));

  // 'b' and 'c' come back in the better tier: the tier is reason enough to
  // move, whatever either reset reads. A fresh pick would take 'c' to learn
  // its window; a move off an account that could have stayed takes 'b', whose
  // reset is known, rather than move to 'c' and very likely on again.
  am.setDisabled(1, false);
  am.setDisabled(2, false);
  assert.equal(am._drainOrder()[0].name, 'c');
  assert.deepEqual(am.getStatus().drainQueue[DEFAULT_PROVIDER], ['b', 'c', 'd', 'a']);
  let lines = drainLog(() => assert.equal(pick(am), 'b'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Drain: switched to account "b" — higher priority than "d"/);
  assert.equal(drainLog(() => assert.equal(pick(am), 'b')).length, 0);

  // When 'b' runs out the pick has to be made, and the unknown goes first.
  am.accounts[1].quota.unified7d = 0.99;
  lines = drainLog(() => assert.equal(pick(am), 'c'));
  assert.match(lines[0], /Drain: switched to account "c" — "b" cannot serve/);
});

test('the Claude and Codex pools are ranked independently', () => {
  const base = hourBase();
  const am = mgr([
    oauth('a1'), oauth('a2'),
    oauth('c1', { provider: 'codex' }), oauth('c2', { provider: 'codex' }),
  ]);
  weekly(am, 0, 0.3, base + 48 * H);
  weekly(am, 1, 0.3, base + 24 * H);
  weekly(am, 2, 0.3, base + 24 * H);
  weekly(am, 3, 0.3, base + 12 * H);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a2');
    assert.equal(pick(am, CODEX, 'codex'), 'c2');
  });
  const lines = drainLog(() => {
    for (let i = 0; i < 3; i++) {
      assert.equal(pick(am, OPUS), 'a2');
      assert.equal(pick(am, CODEX, 'codex'), 'c2');
    }
  });
  assert.equal(lines.length, 0, 'neither pool moves the other');
  assert.deepEqual(am.getStatus().drainQueue, { anthropic: ['a2', 'a1'], codex: ['c2', 'c1'] });

  // Running one pool's account out moves that pool alone.
  am.accounts[3].quota.unified7d = 0.99;
  drainLog(() => assert.equal(pick(am, CODEX, 'codex'), 'c1'));
  assert.equal(pick(am, OPUS), 'a2');
});

test('a route keeps its own account while the shared account is gated and after it recovers', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', 'b', 'c'], { routes: [{ name: 'small', match: ['*haiku*'], accounts: ['b', 'c'] }] });
  weekly(am, 0, 0.20, base + 12 * H);
  // 'b' and 'c' reset in the same hour, 'b' with more left to begin with.
  weekly(am, 1, 0.20, base + 24 * H + 5 * M);
  weekly(am, 2, 0.30, base + 24 * H + 40 * M);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(pick(am, HAIKU), 'b');
  });
  // The tie-break turns: 'c' now has more left. Nothing moves.
  am.accounts[1].quota.unified7d = 0.60;
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);

  // The shared account hits its 5-hour gate. The route never used it, and its
  // own account can still serve: the route stays, and the shared cursor is
  // not the route's to move.
  session(am, 0, 0.99, Date.now() + 2 * H);
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);
  assert.equal(am.currentIndex, 0);
  // The shared scope has to move, and the drain order takes it to 'c'. The
  // shared cursor now names an account the route may use; the route stays.
  drainLog(() => assert.equal(pick(am, OPUS), 'c'));
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);
  assert.equal(am.getStatus().routes.find(r => r.name === 'small').target, 'b');

  // 'a' recovers and takes the shared cursor back with its earlier reset. The
  // route is where it was throughout: no b → c → b.
  t.mock.timers.tick(2 * H + 1);
  drainLog(() => assert.equal(pick(am, OPUS), 'a'));
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);
});

test('a model only some accounts claim keeps its own account while the shared account is gated', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', oauth('b', { models: [HAIKU] }), oauth('c', { models: [HAIKU] })]);
  weekly(am, 0, 0.20, base + 12 * H);
  weekly(am, 1, 0.20, base + 24 * H + 5 * M);
  weekly(am, 2, 0.30, base + 24 * H + 40 * M);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(pick(am, HAIKU), 'b');
  });
  am.accounts[1].quota.unified7d = 0.60;
  session(am, 0, 0.99, Date.now() + 2 * H);
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);
  assert.equal(am.currentIndex, 0);
  drainLog(() => assert.equal(pick(am, OPUS), 'c'));
  assert.equal(pick(am, HAIKU), 'b');
  t.mock.timers.tick(2 * H + 1);
  drainLog(() => assert.equal(pick(am, OPUS), 'a'));
  assert.equal(drainLog(() => assert.equal(pick(am, HAIKU), 'b')).length, 0);
});

test('an advisor request keeps its own account while the shared account is gated', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = hourBase();
  const am = mgr(['a', 'b', 'c']);
  const advised = () => am.getActiveAccount(null, OPUS, FABLE, null).name;
  // 'a' cannot serve a Fable advisor: its Fable weekly is spent.
  weekly(am, 0, 0.20, base + 12 * H);
  fableWeekly(am, 0, 0.99, base + 100 * H);
  weekly(am, 1, 0.20, base + 24 * H + 5 * M);
  weekly(am, 2, 0.30, base + 24 * H + 40 * M);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(advised(), 'b');
  });
  am.accounts[1].quota.unified7d = 0.60;
  session(am, 0, 0.99, Date.now() + 2 * H);
  assert.equal(drainLog(() => assert.equal(advised(), 'b')).length, 0);
  assert.equal(am.currentIndex, 0);
  drainLog(() => assert.equal(pick(am, OPUS), 'c'));
  assert.equal(advised(), 'b');
  t.mock.timers.tick(2 * H + 1);
  // A 5-hour reset drops the family readings as stale; the next one says
  // a's Fable weekly is still spent.
  drainLog(() => assert.equal(pick(am, OPUS), 'a'));
  fableWeekly(am, 0, 0.99, base + 100 * H);
  assert.equal(drainLog(() => assert.equal(advised(), 'b')).length, 0);
});

test('a holder follows its account when an earlier account is removed', () => {
  const base = hourBase();
  const am = mgr(['x', 'a', 'b']);
  weekly(am, 0, 0.2, base + 200 * H);
  weekly(am, 1, 0.2, base + 24 * H);
  fableWeekly(am, 1, 0.1, base + 100 * H);
  weekly(am, 2, 0.2, base + 72 * H);
  fableWeekly(am, 2, 0.1, base + 30 * H);
  drainLog(() => {
    assert.equal(pick(am, OPUS), 'a');
    assert.equal(pick(am, FABLE), 'b');
  });
  am.removeAccount(0);
  const lines = drainLog(() => {
    assert.equal(pick(am, FABLE), 'b');
    assert.equal(pick(am, OPUS), 'a');
  });
  assert.equal(lines.length, 0);
});

// ── Status ──────────────────────────────────────────────────────────────────

test('getStatus reports drainQueue by provider and each account\'s drainRank', () => {
  const base = hourBase();
  const am = mgr(['a', 'b', 'c', 'd', oauth('x', { provider: 'codex' })]);
  weekly(am, 0, 0.3, base + 72 * H);
  weekly(am, 1, 0.3, base + 24 * H);
  weekly(am, 2, 0.3, base + 48 * H);
  weekly(am, 3, 0.3, base + 12 * H);
  am.setDisabled(3, true);
  weekly(am, 4, 0.3, base + 24 * H);
  drainLog(() => assert.equal(pick(am), 'b'));
  const status = am.getStatus();
  assert.deepEqual(status.drainQueue, { anthropic: ['b', 'c', 'a'], codex: ['x'] });
  const rank = Object.fromEntries(status.accounts.map(a => [a.name, a.drainRank]));
  assert.deepEqual(rank, { a: 3, b: 1, c: 2, d: null, x: 1 });
  // Where an unrouted request lands agrees with the head of the queue.
  assert.equal(status.defaultTarget, 'b');
});

test('drainQueue and drainRank are null in every other mode', () => {
  const base = hourBase();
  for (const mode of [false, true, 'adaptive', 'affinity']) {
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { distributeSessions: mode });
    weekly(am, 0, 0.3, base + 48 * H);
    weekly(am, 1, 0.3, base + 24 * H);
    const status = am.getStatus();
    assert.equal(status.drainQueue, null, `mode ${mode}`);
    assert.ok(status.accounts.every(a => a.drainRank === null), `mode ${mode}`);
  }
});

test('off mode keeps its own order: sticky, with no move to a sooner reset', () => {
  const base = hourBase();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  weekly(am, 0, 0.3, base + 48 * H);
  weekly(am, 1, 0.3, base + 24 * H);
  for (let i = 0; i < 3; i++) assert.equal(pick(am), 'a');
  assert.equal(am.currentIndex, 0);
});
