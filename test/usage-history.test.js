import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UsageHistory, dayKey, addDays, dayStart, insightsRange, tallyTokens,
  HISTORY_DAYS, HISTORY_HOURS, HISTORY_ROW_CAP, OVERFLOW_MODEL, UNKNOWN_MODEL, DEFAULT_INSIGHTS_RANGE,
} from '../src/usage-history.js';

const HOUR = 60 * 60 * 1000;

// Local noon today, so a test that steps a few hours either way stays on the
// same local day and one that steps whole days lands at noon again.
function noonToday() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function clock(start = noonToday()) {
  let t = start;
  return { now: () => t, set: v => { t = v; }, add: ms => { t += ms; } };
}

const usage = (o = {}) => ({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, ...o });

test('day keys follow the local calendar and step by calendar days', () => {
  const t = new Date(2026, 2, 7, 23, 30).getTime();
  assert.equal(dayKey(t), '2026-03-07');
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayStart('2026-03-08'), new Date(2026, 2, 8).getTime());
  assert.ok(Number.isNaN(dayStart('not-a-day')));
});

test('a report is booked into its day and its hour, cache tokens included', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-opus-5-5', usage: usage() });
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-opus-5-5', usage: usage({ output_tokens: 5 }) });
  const day = h.days.get(dayKey(c.now()));
  assert.equal(day.size, 1, 'one row per provider, account and model');
  const row = [...day.values()][0];
  assert.deepEqual(row.tally, { requests: 2, input: 20, output: 25, cacheRead: 600, cacheWrite: 80 });
  assert.equal(tallyTokens(row.tally), 725);
  assert.equal(h.hours.get(Math.floor(c.now() / HOUR)).size, 1);
  assert.equal(h.since, c.now(), 'recording began with the first report');
});

test('a report with no usage object books nothing; one naming no model is booked as unknown', () => {
  const h = new UsageHistory({ now: clock().now });
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: null });
  h.record({ provider: 'anthropic', account: '', model: 'm', usage: usage() });
  assert.equal(h.days.size, 0);
  assert.equal(h.since, null);
  h.record({ provider: 'codex', account: 'b', model: '', usage: { input_tokens: -5, output_tokens: Number.NaN } });
  const row = [...[...h.days.values()][0].values()][0];
  assert.equal(row.model, UNKNOWN_MODEL);
  assert.deepEqual(row.tally, { requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'bad figures count as zero, the request still counts');
});

test('a full bucket folds new models into the account\'s overflow row instead of dropping them', () => {
  const h = new UsageHistory({ now: clock().now });
  for (let i = 0; i < HISTORY_ROW_CAP; i++) h.record({ provider: 'anthropic', account: 'a', model: `m-${i}`, usage: usage() });
  h.record({ provider: 'anthropic', account: 'a', model: 'one-too-many', usage: usage() });
  h.record({ provider: 'anthropic', account: 'b', model: 'another', usage: usage() });
  const day = [...h.days.values()][0];
  const models = [...day.values()].map(r => `${r.account}/${r.model}`);
  assert.ok(!models.includes('a/one-too-many'));
  assert.ok(models.includes(`a/${OVERFLOW_MODEL}`));
  assert.ok(models.includes(`b/${OVERFLOW_MODEL}`), 'the overflow row is per account');
  // An existing model keeps its own row at the cap.
  h.record({ provider: 'anthropic', account: 'a', model: 'm-0', usage: usage() });
  assert.equal([...day.values()].find(r => r.model === 'm-0').tally.requests, 2);
  const total = [...day.values()].reduce((n, r) => n + r.tally.requests, 0);
  assert.equal(total, HISTORY_ROW_CAP + 3, 'every request is still counted');
});

test('days older than a year and hours older than two days are pruned when a new bucket opens', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  const firstDay = dayKey(c.now());
  c.add(HISTORY_HOURS * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  assert.equal(h.hours.size, 1, 'the first hour has left retention');
  assert.ok(h.days.has(firstDay), 'its day has not');
  c.set(dayStart(addDays(firstDay, HISTORY_DAYS)) + 12 * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  assert.ok(!h.days.has(firstDay), 'a day a year back is dropped');
  assert.equal(h.days.size, 2);
});

test('the saved form is compact and restores to the same insights', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-opus-5-5', usage: usage() });
  c.add(-2 * 24 * HOUR);
  h.record({ provider: 'codex', account: 'b', model: 'gpt-6', usage: usage({ cache_read_input_tokens: 0 }) });
  c.add(2 * 24 * HOUR);
  const saved = h.exportState();
  for (const v of Object.values(saved.days)) assert.equal(typeof v, 'string', 'each day is one string, one line in the state file');
  const json = JSON.parse(JSON.stringify(saved));

  const back = new UsageHistory({ now: c.now });
  back.restore(json);
  assert.deepEqual(back.insights('7d'), h.insights('7d'));
  assert.deepEqual(back.insights('24h'), h.insights('24h'));
  assert.equal(back.since, h.since);
});

test('restore skips what it cannot use and what is out of retention, and keeps the rest', () => {
  const c = clock();
  const today = dayKey(c.now());
  const row = (account, n) => ['anthropic', account, 'm', n, 1, 1, 1, 1];
  const h = new UsageHistory({ now: c.now });
  h.restore({
    v: 1,
    since: null,
    days: {
      [today]: JSON.stringify([row('a', 2), ['bad'], row('', 1), 'nope']),
      [addDays(today, -1)]: [row('b', 3)],
      [addDays(today, -HISTORY_DAYS)]: JSON.stringify([row('old', 1)]),
      [addDays(today, 1)]: JSON.stringify([row('future', 1)]),
      'not-a-day': JSON.stringify([row('x', 1)]),
      [addDays(today, -2)]: '{not json',
    },
    hours: { [String(Math.floor(c.now() / HOUR) - HISTORY_HOURS)]: JSON.stringify([row('stale', 1)]) },
  });
  assert.deepEqual([...h.days.keys()].sort(), [addDays(today, -1), today]);
  assert.equal(h.hours.size, 0);
  assert.equal(h.since, dayStart(addDays(today, -1)), 'no saved start: the earliest surviving day');
  h.restore({ v: 99, days: { [today]: JSON.stringify([row('z', 1)]) } });
  h.restore(null);
  h.restore('junk');
  assert.equal([...h.days.get(today).values()].length, 1, 'other versions and junk change nothing');
});

test('insights for a day range: buckets, series, ranking and totals', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-opus-5-5', usage: usage() });
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-sonnet-5', usage: usage({ cache_read_input_tokens: 0 }) });
  h.record({ provider: 'codex', account: 'b', model: 'gpt-6', usage: usage({ cache_read_input_tokens: 1000 }) });
  c.add(-3 * 24 * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'claude-opus-5-5', usage: usage() });
  c.add(3 * 24 * HOUR);

  const r = h.insights('7d');
  assert.equal(r.range, '7d');
  assert.equal(r.unit, 'day');
  assert.equal(r.buckets.length, 7);
  assert.equal(r.buckets[6], dayKey(c.now()), 'today is the last bucket');
  assert.equal(r.buckets[3], addDays(dayKey(c.now()), -3));
  assert.deepEqual(r.requests, [0, 0, 0, 1, 0, 0, 3]);
  assert.deepEqual(r.totals, { requests: 4, input: 40, output: 80, cacheRead: 1600, cacheWrite: 160 });
  assert.equal(r.kinds.cacheRead[6], 1300);
  assert.deepEqual(r.providers.map(p => p.provider), ['codex', 'anthropic'], 'most tokens first');
  const a = r.accounts.find(x => x.account === 'a');
  assert.equal(a.requests, 3);
  assert.equal(a.tokens, a.values.reduce((x, y) => x + y, 0));
  assert.deepEqual(r.models.map(m => m.model), ['gpt-6', 'claude-opus-5-5', 'claude-sonnet-5']);
  assert.equal(r.models.find(m => m.model === 'claude-opus-5-5').requests, 2);
  const sum = r.providers.reduce((n, p) => n + p.tokens, 0);
  assert.equal(sum, tallyTokens(r.totals), 'the providers add up to the total');
});

test('the previous period is reported only when history reaches back to its first day', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  assert.equal(h.insights('7d').previous, null, 'recording began today');

  // Recording that began 14 days ago covers the 7 days before this week.
  const older = new UsageHistory({ now: c.now });
  c.add(-13 * 24 * HOUR);
  older.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  c.add(13 * 24 * HOUR);
  older.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  const r = older.insights('7d');
  assert.deepEqual(r.previous, { requests: 1, input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
  assert.equal(r.totals.requests, 1);
  assert.equal(older.insights('30d').previous, null, 'but not the 30 days before this month');
  assert.equal(older.insights('all').previous, null, 'all has nothing before it');
});

test('insights for 24h are hourly, and compare with the 24 hours before', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  c.add(-30 * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  c.add(30 * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  const r = h.insights('24h');
  assert.equal(r.unit, 'hour');
  assert.equal(r.buckets.length, 24);
  assert.equal(r.buckets[23], Math.floor(c.now() / HOUR) * HOUR, 'the current hour is the last bucket');
  assert.equal(r.requests[23], 1);
  assert.equal(r.totals.requests, 1);
  assert.equal(r.previous, null, 'recording began 30 hours ago, less than 48');

  const longer = new UsageHistory({ now: c.now });
  c.add(-47 * HOUR);
  longer.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  c.add(47 * HOUR);
  assert.equal(longer.insights('24h').previous.requests, 1);
});

test('all runs from the day recording began, and an unknown range is the default', () => {
  const c = clock();
  const h = new UsageHistory({ now: c.now });
  assert.equal(h.insights('all').buckets.length, 1, 'no history: just today');
  c.add(-9 * 24 * HOUR);
  h.record({ provider: 'anthropic', account: 'a', model: 'm', usage: usage() });
  c.add(9 * 24 * HOUR);
  const r = h.insights('all');
  assert.equal(r.buckets.length, 10);
  assert.equal(r.requests[0], 1);
  assert.equal(h.insights('bogus').range, DEFAULT_INSIGHTS_RANGE);
});

test('insightsRange reads ?range= and falls back to the default', () => {
  assert.equal(insightsRange('/teamclaude/insights?range=90d'), '90d');
  assert.equal(insightsRange('/teamclaude/insights?range=all&x=1'), 'all');
  assert.equal(insightsRange('/teamclaude/insights'), DEFAULT_INSIGHTS_RANGE);
  assert.equal(insightsRange('/teamclaude/insights?range=1y'), DEFAULT_INSIGHTS_RANGE);
  assert.equal(insightsRange(undefined), DEFAULT_INSIGHTS_RANGE);
});
