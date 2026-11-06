// Grok plan usage: the billing reply normalised into the quota fields that
// rotation and the renderers read, and the probe that fetches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGrokBilling, fetchGrokUsage, GROK_BILLING_URL } from '../src/grok-usage.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober, probeApplicable } from '../src/prober.js';
import { renderStatus } from '../src/status-renderer.js';

test('the billing reply becomes a fraction of the plan with its reset and tier', () => {
  const end = '2030-02-01T00:00:00Z';
  assert.deepEqual(normalizeGrokBilling({
    config: { creditUsagePercent: 42.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2030-01-25T00:00:00Z', end } },
    subscriptionTier: 'SuperGrok Heavy',
  }), { fiveHour: null, sevenDay: { utilization: 0.425, resetAt: Date.parse(end) }, period: 'weekly', planType: 'SuperGrok Heavy' });
});

test('a zero usage left out by proto3 JSON reads as 0%, not unknown', () => {
  const usage = /** @type {any} */ (normalizeGrokBilling({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' }, prepaidBalance: {} } }));
  assert.equal(usage.sevenDay.utilization, 0);
  assert.equal(usage.sevenDay.resetAt, null);
  assert.equal(usage.planType, null);
});

test('a monthly period is named as one', () => {
  const usage = /** @type {any} */ (normalizeGrokBilling({ config: { creditUsagePercent: 10, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: '2030-03-01T00:00:00Z' } } }));
  assert.equal(usage.period, 'monthly');
});

test('a reply with no plan is an error, not an empty allowance', () => {
  assert.ok('error' in normalizeGrokBilling({}));
  assert.ok('error' in normalizeGrokBilling({ config: { creditUsagePercent: 'lots' } }));
});

test('the billing read carries the account\'s token and user, and a 401 is reported for a retry', async () => {
  /** @type {any[]} */
  const calls = [];
  const fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, headers: init.headers });
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const out = await fetchGrokUsage({ credential: 'tok', userId: 'u-1' }, { fetchImpl });
  assert.deepEqual(out, { error: 'HTTP 401', status: 401 });
  assert.equal(calls[0].url, GROK_BILLING_URL);
  assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].headers['X-XAI-Token-Auth'], 'xai-grok-cli');
  assert.equal(calls[0].headers['x-userid'], 'u-1');
});

const grokAccount = (/** @type {string} */ name, /** @type {Record<string, any>} */ over = {}) => ({
  name, type: 'oauth', provider: 'grok', accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: Date.now() + 3600_000, userId: `u-${name}`, ...over,
});

test('a probed Grok account at the switch threshold rotates to the next one', async () => {
  const am = new AccountManager([grokAccount('a'), grokAccount('b')], 0.9);
  assert.equal(probeApplicable(am.accounts[0]), true);
  const end = Date.now() + 3 * 24 * 3600_000;
  const prober = new Prober(am, {
    log: () => {},
    grokProbeFn: async (/** @type {any} */ account) => normalizeGrokBilling({
      config: { creditUsagePercent: account.name === 'a' ? 95 : 20, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: new Date(end).toISOString() } },
      subscriptionTier: 'SuperGrok',
    }),
    codexProbeFn: async () => { throw new Error('a Grok account must not be read as Codex'); },
  });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified7d, 0.95);
  assert.equal(am.accounts[0].quota.unified7dReset, end);
  assert.equal(am.getActiveAccount(null, null, null, null, 'grok')?.name, 'b');

  const status = am.getStatus();
  assert.equal(status.accounts[0].plan, 'SuperGrok');
  const out = renderStatus(status, { color: false, now: Date.now() });
  assert.match(out, /Weekly\s+\S+\s+95%/);
  assert.doesNotMatch(out, /^\s+Session\b/m);
});

test('a monthly plan is drawn as Monthly', async () => {
  const am = new AccountManager([grokAccount('m')], 0.98);
  am.applyPlanUsageData(0, normalizeGrokBilling({ config: { creditUsagePercent: 30, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: new Date(Date.now() + 9 * 24 * 3600_000).toISOString() } } }));
  const out = renderStatus(am.getStatus(), { color: false, now: Date.now() });
  assert.match(out, /Monthly\s+\S+\s+30%/);
});
