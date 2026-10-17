import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, AFFINITY_DEFAULTS, distributionMode } from '../src/account-manager.js';

// Affinity distribution: a 5-hour window about to reset is spent first, the
// 5-hour window counts in the fullest-first score, and a pinned conversation
// moves only when its account cannot serve it. Every test sets quota directly
// and asserts the pick, never the clock.

const H = 3600_000;
const M = 60_000;
const OPUS = 'claude-opus-5';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + H, ...extra };
}

function mgr(accounts, opts = {}) {
  const list = accounts.map(a => (typeof a === 'string' ? oauth(a) : a));
  return new AccountManager(list, 0.98, { distributeSessions: 'affinity', ...opts });
}

// Set an account's 5-hour window: used fraction, minutes until it resets.
function session(am, index, used, minutes) {
  const q = am.accounts[index].quota;
  q.unified5h = used;
  q.unified5hReset = Date.now() + minutes * M;
  am.accounts[index].probing = false;
}

// Set an account's shared weekly window: used fraction, hours until it resets.
function weekly(am, index, used, hours = 72) {
  const q = am.accounts[index].quota;
  q.unified7d = used;
  q.unified7dReset = Date.now() + hours * H;
  am.accounts[index].probing = false;
}

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines;
}

// ── Mode plumbing ───────────────────────────────────────────────────────────

test('affinity is a fourth distribution mode and counts as distributing', () => {
  assert.equal(distributionMode('affinity'), 'affinity');
  assert.equal(distributionMode(' Affinity '), 'affinity');
  const am = mgr(['a', 'b']);
  assert.equal(am.distributionMode, 'affinity');
  assert.equal(am.distributeSessions, true);
  assert.equal(am.sessionStats().mode, 'affinity');
  assert.equal(am.getStatus().sessions.mode, 'affinity');
  // The adaptive readout is what explains the fullest-first tier.
  assert.ok(Array.isArray(am.getStatus().adaptive));
  assert.ok(am.getStatus().adaptive.length > 0);
});

test('the affinity block takes defaults for anything absent or out of range', () => {
  assert.deepEqual(mgr(['a']).affinity, { ...AFFINITY_DEFAULTS });
  assert.deepEqual(mgr(['a'], { affinity: null }).affinity, { ...AFFINITY_DEFAULTS });
  assert.deepEqual(mgr(['a'], { affinity: [] }).affinity, { ...AFFINITY_DEFAULTS });
  assert.deepEqual(mgr(['a'], { affinity: { nearResetMinutes: 30, weeklyHeadroom: 0.2 } }).affinity,
    { nearResetMinutes: 30, weeklyHeadroom: 0.2 });
  for (const bad of ['15', -1, NaN, Infinity, null]) {
    assert.equal(mgr(['a'], { affinity: { nearResetMinutes: bad } }).affinity.nearResetMinutes,
      AFFINITY_DEFAULTS.nearResetMinutes, `nearResetMinutes: ${bad}`);
  }
  for (const bad of ['0.1', -0.1, 1.5, NaN]) {
    assert.equal(mgr(['a'], { affinity: { weeklyHeadroom: bad } }).affinity.weeklyHeadroom,
      AFFINITY_DEFAULTS.weeklyHeadroom, `weeklyHeadroom: ${bad}`);
  }
  // Applied live, like expiryRouting.
  const am = mgr(['a']);
  am.setAffinity({ nearResetMinutes: 5 });
  assert.equal(am.affinity.nearResetMinutes, 5);
  assert.equal(am.affinity.weeklyHeadroom, AFFINITY_DEFAULTS.weeklyHeadroom);
  assert.deepEqual(am.getStatus().affinity, am.affinity);
});

// ── Tier 1: near reset first ────────────────────────────────────────────────

test('an account whose 5-hour window resets within the horizon is placed first, however little it has used', () => {
  const am = mgr(['a', 'b']);
  // 'a' is far fuller on both clocks; 'b' has barely been touched but resets in 9 minutes.
  session(am, 0, 0.70, 180); weekly(am, 0, 0.60);
  session(am, 1, 0.17, 9); weekly(am, 1, 0.40);
  const picked = am.getActiveAccount(null, OPUS, null, 'sess-1');
  assert.equal(picked.name, 'b');
});

test('the near-reset tier takes the soonest reset among several', () => {
  const am = mgr(['a', 'b', 'c']);
  session(am, 0, 0.50, 12); weekly(am, 0, 0.30);
  session(am, 1, 0.10, 4); weekly(am, 1, 0.30);
  session(am, 2, 0.90, 14); weekly(am, 2, 0.30);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
});

test('a reset beyond nearResetMinutes earns no preference', () => {
  const am = mgr(['a', 'b'], { affinity: { nearResetMinutes: 10 } });
  session(am, 0, 0.70, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.17, 11); weekly(am, 1, 0.30);
  // Nothing is near reset, so the fullest account wins.
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
});

test('a near-reset account whose weekly lacks headroom is ranked normally', () => {
  const am = mgr(['a', 'b']);
  session(am, 0, 0.70, 180); weekly(am, 0, 0.92);
  // Resets in 9 minutes, but the weekly is 0.90 — above 0.98 - 0.10 — so it
  // competes on fullness alone, where 'a' at 92% weekly is ahead.
  session(am, 1, 0.17, 9); weekly(am, 1, 0.90);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
  // The margin is the knob: with no headroom required, the preference returns.
  am.setAffinity({ weeklyHeadroom: 0 });
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-2').name, 'b');
});

test('an unreported weekly does not disqualify a near-reset account', () => {
  const am = mgr(['a', 'b']);
  session(am, 0, 0.70, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.17, 9); // no weekly reading at all
  am.accounts[1].probing = false;
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
});

test('priority still wins over the near-reset preference', () => {
  const am = mgr([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })]);
  session(am, 0, 0.10, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.17, 9); weekly(am, 1, 0.30);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
});

// ── Tier 2: fullest first, 5-hour aware ─────────────────────────────────────

test('with nothing near reset, the account with the fuller 5-hour window is placed first', () => {
  const am = mgr(['a', 'b']);
  // Equal weeklies; only the 5-hour windows differ. Adaptive alone could not
  // tell these apart, so this is the 5-hour window joining the score.
  session(am, 0, 0.20, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.75, 180); weekly(am, 1, 0.30);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
  // The scored window names the 5-hour bucket for the fuller account.
  assert.equal(am._adaptiveWindow(am.accounts[1], OPUS).bucket, 'unified5h');
});

test('adaptive mode keeps its weekly-only view of the window', () => {
  const am = mgr(['a', 'b'], { distributeSessions: 'adaptive' });
  session(am, 0, 0.75, 180); weekly(am, 0, 0.30);
  assert.equal(am._adaptiveWindow(am.accounts[0], OPUS).bucket, 'unified7d');
});

test('the 5-hour window tapers toward its own threshold bucket', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], { default: 0.98, unified5h: 0.80 },
    { distributeSessions: 'affinity' });
  session(am, 0, 0.79, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.50, 180); weekly(am, 1, 0.30);
  // 'a' is 1% from its 5-hour wall, so its score is tapered to nothing and
  // 'b' is placed even though 'a' is fuller.
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
});

// ── The pin ─────────────────────────────────────────────────────────────────

test('a pinned conversation stays put when a higher-priority account becomes available', () => {
  const am = mgr([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })]);
  session(am, 0, 0.99, 180); weekly(am, 0, 0.30); // 'a' is over its 5h threshold
  session(am, 1, 0.20, 180); weekly(am, 1, 0.30);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  assert.equal(first.name, 'b');
  am.recordSession('sess-1', first.index, OPUS);
  // 'a' comes back. Adaptive mode would preempt the pin for the better tier;
  // affinity holds it.
  session(am, 0, 0.10, 180);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
  // A NEW conversation still goes to the preferred tier.
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-2').name, 'a');
});

test('the same pin would have moved under adaptive mode', () => {
  const am = mgr([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], { distributeSessions: 'adaptive' });
  session(am, 0, 0.99, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.20, 180); weekly(am, 1, 0.30);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  am.recordSession('sess-1', first.index, OPUS);
  session(am, 0, 0.10, 180);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'a');
});

test('a pinned conversation is not moved by a weekly rollover', () => {
  const am = mgr(['a', 'b'], { expiryRouting: { enabled: true, preempt: true } });
  session(am, 0, 0.20, 180); weekly(am, 0, 0.60, 2);
  session(am, 1, 0.20, 180); weekly(am, 1, 0.30, 100);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  am.recordSession('sess-1', first.index, OPUS);
  // The request after placement takes the reading the rollover is measured against.
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, first.name);
  // The pinned account's weekly rolls over a full week out.
  weekly(am, first.index, 0.01, 168);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, first.name);
});

test('the pin breaks when the account is out of usage, re-pins, and never moves back', () => {
  const am = mgr(['a', 'b']);
  session(am, 0, 0.70, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.20, 180); weekly(am, 1, 0.30);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  assert.equal(first.name, 'a');
  am.recordSession('sess-1', first.index, OPUS);
  // 'a' crosses its 5-hour threshold: the pin is unusable and the thread moves.
  session(am, 0, 0.99, 180);
  const moved = am.getActiveAccount(null, OPUS, null, 'sess-1');
  assert.equal(moved.name, 'b');
  am.recordSession('sess-1', moved.index, OPUS);
  // 'a' resets and is now the account the placement rules would prefer, but
  // the thread is pinned to 'b' and stays there.
  session(am, 0, 0.05, 9);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, 'b');
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-2').name, 'a');
});

test('a throttled pin breaks; a short pause does not', () => {
  const am = mgr(['a', 'b']);
  session(am, 0, 0.70, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.20, 180); weekly(am, 1, 0.30);
  const first = am.getActiveAccount(null, OPUS, null, 'sess-1');
  am.recordSession('sess-1', first.index, OPUS);
  // A pause is not unavailability: the pin holds.
  am.pauseAccount(first.index, 5);
  assert.equal(am.getActiveAccount(null, OPUS, null, 'sess-1').name, first.name);
  // A rate-limit hold is.
  am.markRateLimited(first.index, 60);
  assert.equal(am.unavailableReason(am.accounts[first.index], OPUS), 'throttled');
  assert.notEqual(am.getActiveAccount(null, OPUS, null, 'sess-1').name, first.name);
});

// ── Visibility ──────────────────────────────────────────────────────────────

test('a placement logs its reason; a status read does not', () => {
  const am = mgr(['a', 'b']);
  session(am, 0, 0.70, 180); weekly(am, 0, 0.30);
  session(am, 1, 0.17, 9); weekly(am, 1, 0.30);
  const near = captureLog(() => am.getActiveAccount(null, OPUS, null, 'sess-1'));
  assert.equal(near.filter(l => l.includes('Affinity: placing')).length, 1, near.join('\n'));
  assert.match(near.find(l => l.includes('Affinity: placing')), /"b" — 5h window resets in 9m/);

  session(am, 1, 0.17, 180);
  const fullest = captureLog(() => am.getActiveAccount(null, OPUS, null, 'sess-2'));
  assert.match(fullest.find(l => l.includes('Affinity: placing')), /"a" — fullest \(unified5h 70%\)/);

  const status = captureLog(() => { am.getStatus(); am.adaptiveStats(OPUS); });
  assert.equal(status.filter(l => l.includes('Affinity: placing')).length, 0, status.join('\n'));
});
