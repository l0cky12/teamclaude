import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { CREDIT_DETAILS_RETRY_MS, CREDIT_EXPIRY_WINDOW_MS, creditDetailsDue, heldCreditExpiries } from '../src/codex-reset-credits.js';
import { codexResetExpiry, resetsLeftText, resetCreditAlerts, logEventTone, RESET_ALERT_NEW_MS } from '../src/dashboard.js';

// Telling the operator about Codex reset credits: when each one expires, a
// Logs entry when one is granted or about to lapse, and the Quota page banner
// built from the same reading. Nothing here reaches the network: the usage and
// credit-row reads are injected.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** @param {string} name */
function codex(name) {
  return { name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name, accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + HOUR };
}

/** @param {number} available */
const usage = available => ({ sevenDay: { utilization: 0.2, resetAt: Date.now() + DAY }, resetCredits: { available, applicable: 0 } });

/** @param {number|null} expiresAt @param {string} [status] */
const row = (expiresAt, status = 'available') => ({ id: 'c' + Math.random(), status, supportedByPlan: true, expiresAt, title: null });

/** @param {AccountManager} am @param {string} type */
const eventsOf = (am, type) => am.events.since(0).events.filter(e => e.type === type);

test('heldCreditExpiries keeps available credits, soonest first, a never-expiring one last', () => {
  const now = Date.now();
  assert.deepEqual(heldCreditExpiries([row(now + 9 * DAY), row(null), row(now + DAY, 'redeemed'), row(now + 2 * DAY)]), [now + 2 * DAY, now + 9 * DAY, null]);
  assert.deepEqual(heldCreditExpiries(), []);
});

test('creditDetailsDue reads the rows for a new count or old dates, and never for no credits', () => {
  const now = Date.now();
  assert.equal(creditDetailsDue(null, now), false);
  assert.equal(creditDetailsDue({ available: 0 }, now), false);
  assert.equal(creditDetailsDue({ available: 1 }, now), true, 'no dates yet');
  const read = { available: 1, expiries: [now + DAY], expiriesAt: now, expiriesFor: 1 };
  assert.equal(creditDetailsDue(read, now + HOUR), false, 'same count, fresh dates');
  assert.equal(creditDetailsDue({ ...read, available: 2 }, now + HOUR), true, 'count went up');
  assert.equal(creditDetailsDue(read, now + 7 * HOUR), true, 'dates older than the detail TTL');
});

test('a usage read whose count went up records when, and logs the grant once', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, usage(1));
  assert.equal(am.accounts[0].quota.resetCredits.grantedAt, undefined, 'a first reading is not a grant');
  assert.equal(eventsOf(am, 'credit_granted').length, 0);

  am.applyCodexUsageData(0, usage(2));
  const grantedAt = am.accounts[0].quota.resetCredits.grantedAt;
  assert.ok(Number.isFinite(grantedAt));
  const [event] = eventsOf(am, 'credit_granted');
  assert.equal(event.kind, 'credits');
  assert.equal(event.account, 'a');
  assert.match(event.message, /2 left/);

  am.applyCodexUsageData(0, usage(2));
  assert.equal(eventsOf(am, 'credit_granted').length, 1, 'an unchanged count is not another grant');
  assert.equal(am.accounts[0].quota.resetCredits.grantedAt, grantedAt, 'and keeps the grant time');
});

test('a usage read carries the dates over while the count holds, and drops their trust when it falls', () => {
  const now = Date.now();
  const am = new AccountManager([codex('a')], 0.98);
  /** @param {any} q */
  const shown = q => codexResetExpiry({ name: 'a', provider: 'codex', quota: q });
  am.applyCodexUsageData(0, usage(2));
  // A credit this plan cannot spend expires first; a redemption skips it and
  // spends the supported one, so the count alone cannot say which one went.
  am.applyResetCreditDetails(0, [{ ...row(now + DAY), supportedByPlan: false }, row(now + 2 * DAY)]);
  assert.deepEqual(am.accounts[0].quota.resetCredits.expiries, [now + DAY, now + 2 * DAY]);

  am.applyCodexUsageData(0, usage(2));
  assert.deepEqual(am.accounts[0].quota.resetCredits.expiries, [now + DAY, now + 2 * DAY]);
  assert.equal(creditDetailsDue(am.accounts[0].quota.resetCredits), false);
  assert.equal(shown(am.accounts[0].quota), now + DAY);

  am.applyCodexUsageData(0, usage(1));
  const q = am.accounts[0].quota.resetCredits;
  assert.equal(q.expiriesFor, null);
  assert.equal(creditDetailsDue(q), true, 'the rows are read again');
  assert.equal(shown(am.accounts[0].quota), null, 'no date is guessed meanwhile');

  am.applyResetCreditDetails(0, [{ ...row(now + DAY), supportedByPlan: false }]);
  assert.equal(shown(am.accounts[0].quota), now + DAY);
});

test('rows that disagree with the count are not shown, and the next count change reads them again', () => {
  const now = Date.now();
  const am = new AccountManager([codex('a')], 0.98);
  /** @param {any} q */
  const shown = q => codexResetExpiry({ name: 'a', provider: 'codex', quota: q });
  am.applyCodexUsageData(0, usage(2));
  // Rows read after one of the two was spent, before a usage read caught up.
  am.applyResetCreditDetails(0, [row(now + 5 * DAY)]);
  assert.equal(shown(am.accounts[0].quota), null, 'one row against a count of two');

  am.applyCodexUsageData(0, usage(1));
  assert.equal(creditDetailsDue(am.accounts[0].quota.resetCredits), true);
  am.applyResetCreditDetails(0, [row(now + 5 * DAY)]);
  assert.equal(shown(am.accounts[0].quota), now + 5 * DAY);
});

test('dates left out of step by a grant stay untrusted when the count falls back', () => {
  const now = Date.now();
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, usage(1));
  am.applyResetCreditDetails(0, [row(now + DAY)]);
  // A grant whose date was never read, then the OLD credit redeemed: the count
  // is back to 1, but the date on hand is the spent credit's.
  am.applyCodexUsageData(0, usage(2));
  am.applyCodexUsageData(0, usage(1));
  const q = am.accounts[0].quota.resetCredits;
  assert.equal(q.expiriesFor, null);
  assert.equal(creditDetailsDue(q), true, 'the rows must be read again');
  assert.equal(codexResetExpiry({ name: 'a', provider: 'codex', quota: am.accounts[0].quota }), null, 'and the page shows no date meanwhile');

  am.applyResetCreditDetails(0, [row(now + 30 * DAY)]);
  assert.equal(codexResetExpiry({ name: 'a', provider: 'codex', quota: am.accounts[0].quota }), now + 30 * DAY);
});

test('a credit expiring within the window is logged once, a later one not at all', () => {
  const now = Date.now();
  const am = new AccountManager([codex('a')], 0.98);
  am.applyCodexUsageData(0, usage(2));
  const soon = now + CREDIT_EXPIRY_WINDOW_MS - HOUR;
  am.applyResetCreditDetails(0, [row(soon), row(now + CREDIT_EXPIRY_WINDOW_MS + DAY)]);
  am.applyResetCreditDetails(0, [row(soon), row(now + CREDIT_EXPIRY_WINDOW_MS + DAY)]);
  const events = eventsOf(am, 'credit_expiring');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'credits');
  assert.equal(events[0].account, 'a');
  assert.match(events[0].message, /expires in \d+ days/);
});

test('a probe reads the credit rows only when its count holds a credit the dates do not cover', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  let available = 1;
  let rowReads = 0;
  const expiry = Date.now() + 10 * DAY;
  const prober = new Prober(am, {
    intervalMs: 0,
    codexProbeFn: async () => usage(available),
    codexCreditsFn: async () => { rowReads++; return { credits: Array.from({ length: available }, () => row(expiry)) }; },
    log: () => {},
  });
  await prober.probeAll();
  assert.equal(rowReads, 1);
  assert.deepEqual(am.accounts[0].quota.resetCredits.expiries, [expiry]);

  await prober.probeAll();
  assert.equal(rowReads, 1, 'same count, fresh dates: no second read');

  available = 2;
  await prober.probeAll();
  assert.equal(rowReads, 2, 'a new credit: read its date');

  available = 0;
  await prober.probeAll();
  assert.equal(rowReads, 2, 'no credits: nothing to read');
});

test('a failed credit-row read leaves the probe ok and the dates unknown', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  const prober = new Prober(am, {
    intervalMs: 0,
    codexProbeFn: async () => usage(1),
    codexCreditsFn: async () => ({ error: 'HTTP 500' }),
    log: () => {},
  });
  await prober.probeAll();
  assert.equal(prober.getStatus().accounts[0].status, 'ok');
  assert.equal(am.accounts[0].quota.resetCredits.expiries, undefined);
});

test('a failed credit-row read is not retried on every probe, only after the retry wait', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  let rowReads = 0;
  let fail = true;
  const prober = new Prober(am, {
    intervalMs: 0,
    codexProbeFn: async () => usage(1),
    codexCreditsFn: async () => { rowReads++; return fail ? { error: 'HTTP 429', status: 429 } : { credits: [row(Date.now() + 10 * DAY)] }; },
    log: () => {},
  });
  await prober.probeAll();
  await prober.probeAll();
  await prober.probeAll();
  assert.equal(rowReads, 1, 'one failed read holds the next ones back');

  // The wait elapsing, stated as the mechanism rather than by moving a clock.
  prober._creditReadFailedAt.set(am.accounts[0], Date.now() - CREDIT_DETAILS_RETRY_MS - 1);
  fail = false;
  await prober.probeAll();
  assert.equal(rowReads, 2);
  assert.equal(am.accounts[0].quota.resetCredits.expiries.length, 1);
  assert.equal(prober._creditReadFailedAt.has(am.accounts[0]), false, 'a read that worked clears the wait');
});

/** A status-payload Codex row. @param {Record<string, any>} credits */
function card(credits, name = 'a') {
  return { name, provider: 'codex', quota: { resetCredits: { applicable: 0, seenAt: Date.now(), ...credits } } };
}

test('codexResetExpiry names the soonest future expiry, only for dates read against this count', () => {
  const now = Date.now();
  assert.equal(codexResetExpiry(card({ available: 3, expiries: [now - DAY, now + 5 * DAY, null], expiriesFor: 3 }), now), now + 5 * DAY);
  assert.equal(codexResetExpiry(card({ available: 2, expiries: [now + 5 * DAY], expiriesFor: 2 }), now), null, 'fewer rows than the count');
  assert.equal(codexResetExpiry(card({ available: 2, expiries: [now + 5 * DAY], expiriesFor: 1 }), now), null, 'a credit granted since');
  assert.equal(codexResetExpiry(card({ available: 1 }), now), null, 'no dates read');
  assert.equal(codexResetExpiry(card({ available: 0, expiries: [], expiriesFor: 0 }), now), null);
  assert.equal(codexResetExpiry({ name: 'c', provider: 'anthropic', quota: {} }, now), null);
});

test('resetsLeftText adds the expiry when it is known', () => {
  const at = Date.now() + 5 * DAY;
  assert.equal(resetsLeftText(1), '1 reset left');
  assert.equal(resetsLeftText(0, at), 'no resets left');
  assert.match(resetsLeftText(2, at), /^2 resets left · expires \S/);
});

test('resetCreditAlerts warns of a credit about to expire and names a recent grant, until dismissed', () => {
  const now = Date.now();
  const accounts = [
    card({ available: 1, expiries: [now + 2 * DAY], expiriesFor: 1 }, 'soon'),
    card({ available: 1, expiries: [now + 20 * DAY], expiriesFor: 1 }, 'later'),
    card({ available: 2, grantedAt: now - HOUR }, 'new'),
    card({ available: 1, grantedAt: now - RESET_ALERT_NEW_MS - HOUR }, 'old'),
    card({ available: 0, grantedAt: now - HOUR, expiries: [], expiriesFor: 0 }, 'spent'),
  ];
  const alerts = resetCreditAlerts(accounts, [], now);
  assert.deepEqual(alerts.map(x => x.kind + ':' + x.key.split(':')[1]), ['warn:soon', 'ok:new']);
  assert.match(alerts[0].text, /^soon: a free reset credit expires in 2 days/);
  assert.match(alerts[1].text, /^new got a new free reset credit on .*: 2 resets left\.$/);

  const left = resetCreditAlerts(accounts, [alerts[0].key], now);
  assert.deepEqual(left.map(x => x.key), [alerts[1].key]);

  // A later event on the same account is a new key, so a dismissal does not hide it.
  const regranted = [card({ available: 3, grantedAt: now }, 'new')];
  assert.equal(resetCreditAlerts(regranted, [alerts[1].key], now).length, 1);
});

test('credit events take the log tones the Logs page draws', () => {
  assert.equal(logEventTone({ type: 'credit_expiring' }), 'warn');
  assert.equal(logEventTone({ type: 'credit_granted' }), 'ok');
});
