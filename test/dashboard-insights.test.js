// The Insights page's arithmetic (dashboard.js): number formats, axis tops,
// the series each "split by" stacks, the legend's statistics, the cache hit
// rate, the provider and Grok panels, model grouping and the headline tiles. The page script only draws what these return; its fetching
// is covered with the rest of the page in dashboard.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDashboardHtml, fmtTokens, niceCeil, niceStep, insightsRangeText, insightsDelta, insightsBucketLabel,
  insightsSeries, stackSeries, topModels, insightsKpis, fmtUsd, fleetMissingText,
  seriesStats, cacheHitRate, cacheHitSeries, peakBucket, providerRows, grokSummary,
  recordedFrom, insightsDayKey, bucketAt, labelStep, pricedRequests,
} from '../src/dashboard.js';

test('the page ships every Insights helper it is tested against', () => {
  const html = renderDashboardHtml();
  for (const fn of [fmtTokens, niceCeil, niceStep, insightsRangeText, insightsDelta, insightsBucketLabel, insightsSeries, stackSeries, topModels, insightsKpis, fmtUsd, fleetMissingText,
    seriesStats, cacheHitRate, cacheHitSeries, peakBucket, providerRows, grokSummary,
    recordedFrom, insightsDayKey, bucketAt, labelStep, pricedRequests]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  assert.ok(html.includes('id="page-insights"'), 'the page section');
  assert.ok(html.includes("{ key: 'insights', label: 'Insights', section: 'Overview' }"), 'the sidebar entry');
});

test('token counts read at a glance', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(12345), '12.3k');
  assert.equal(fmtTokens(123456), '123k');
  assert.equal(fmtTokens(4_480_000), '4.48M');
  assert.equal(fmtTokens(48_900_000), '48.9M');
  assert.equal(fmtTokens(368_000_000), '368M');
  assert.equal(fmtTokens(4_480_000_000), '4.48B');
  assert.equal(fmtTokens(2.5e12), '2.50T');
  assert.equal(fmtTokens(undefined), '0');
});

test('axis tops land on round numbers, and count axes on whole steps', () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(0.7), 1);
  assert.equal(niceCeil(17), 20);
  assert.equal(niceCeil(230), 250);
  assert.equal(niceCeil(4100), 5000);
  assert.equal(niceCeil(9100), 10000);
  for (const max of [0, 3, 22, 25, 200, 250, 4615]) {
    const top = 4 * niceStep(max / 4);
    assert.ok(top >= max, `${top} covers ${max}`);
    assert.ok(Number.isInteger(top / 4), `${top} splits into whole steps`);
  }
  assert.equal(4 * niceStep(22 / 4), 24);
  assert.equal(4 * niceStep(200 / 4), 200);
});

test('the range reads as a phrase, and a change against the period before as an arrow', () => {
  assert.equal(insightsRangeText('24h'), 'last 24 hours');
  assert.equal(insightsRangeText('30d'), 'last 30 days');
  assert.equal(insightsRangeText('all'), 'all time');
  assert.equal(insightsDelta(115, 100, '30d'), '▲ 15% vs the previous 30 days');
  assert.equal(insightsDelta(91, 100, '24h'), '▼ 9% vs the previous 24 hours');
  assert.equal(insightsDelta(100, 100, '7d'), '0% vs the previous 7 days');
  assert.equal(insightsDelta(100, null, '7d'), null, 'nothing on record to compare with');
  assert.equal(insightsDelta(100, 0, '7d'), null, 'a percentage of nothing is not a number');
});

test('buckets read as days or hours', () => {
  assert.match(insightsBucketLabel('2026-03-07', 'day', false), /7/);
  assert.match(insightsBucketLabel('2026-03-07', 'day', true), /7/);
  const ms = new Date(2026, 2, 7, 9).getTime();
  assert.equal(insightsBucketLabel(ms, 'hour', false), '09:00');
  assert.match(insightsBucketLabel(ms, 'hour', true), /09:00$/);
  assert.equal(insightsBucketLabel('junk', 'day', false), 'junk');
});

test('an hour bucket says the minute it starts at, in a zone with a fractional offset', () => {
  const saved = process.env.TZ;
  try {
    // UTC+5:30 the year round: an epoch hour starts at :30 local time.
    process.env.TZ = 'Asia/Kolkata';
    const bucket = Math.floor(Date.UTC(2026, 2, 7, 1, 10) / 3600000) * 3600000;
    assert.equal(insightsBucketLabel(bucket, 'hour', false), '06:30');
    assert.match(insightsBucketLabel(bucket, 'hour', true), /06:30$/);
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

const data = {
  range: '7d', unit: 'day', buckets: ['a', 'b'], since: 1,
  totals: { requests: 3, input: 10, output: 20, cacheRead: 900, cacheWrite: 70 },
  previous: { requests: 2, input: 5, output: 5, cacheRead: 400, cacheWrite: 90 },
  requests: [1, 2],
  kinds: { cacheRead: [400, 500], cacheWrite: [30, 40], input: [5, 5], output: [10, 10] },
  providers: [
    { provider: 'anthropic', tokens: 700, values: [300, 400] },
    { provider: 'backend:api.deepseek.com', tokens: 100, values: [50, 50] },
    { provider: 'codex', tokens: 150, values: [100, 50] },
    { provider: 'backend:api.z.ai', tokens: 50, values: [0, 50] },
  ],
  accounts: [
    { provider: 'anthropic', account: 'b', tokens: 400, requests: 1, values: [100, 300] },
    { provider: 'anthropic', account: 'a', tokens: 300, requests: 1, values: [200, 100] },
    { provider: 'codex', account: 'gone', tokens: 150, requests: 1, values: [100, 50] },
  ],
  models: [
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens: 30, requests: 1 },
    { provider: 'anthropic', model: 'claude-opus-5-5', tokens: 500, requests: 2 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', tokens: 40, requests: 1 },
    { provider: 'codex', model: '(unknown)', tokens: 5, requests: 1 },
  ],
};

test('split by provider: Claude, Codex and the backends as one series, in that order', () => {
  const s = insightsSeries(data, 'provider', []);
  assert.deepEqual(s.map(x => x.label), ['Claude', 'Codex', 'Backends']);
  assert.deepEqual(s.map(x => x.color), ['var(--ip-claude)', 'var(--ip-codex)', 'var(--ip-backend)']);
  assert.deepEqual(s[2].values, [50, 100], 'both backends summed');
  assert.equal(s[2].total, 150);
  const one = insightsSeries({ ...data, providers: data.providers.slice(0, 2) }, 'provider', []);
  assert.deepEqual(one.map(x => x.label), ['Claude', 'DeepSeek'], 'a lone backend keeps its own name');
});

test('split by account: colour follows the account\'s place in the config, never its rank', () => {
  const accounts = [{ name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic' }];
  const s = insightsSeries(data, 'account', accounts);
  assert.deepEqual(s.map(x => [x.label, x.color]), [['a', 'var(--is1)'], ['b', 'var(--is2)'], ['Other', 'var(--dim)']]);
  assert.deepEqual(s[2].values, [100, 50], 'an account no longer configured is summed into Other');
  // Another range ranks b first; the colours stay put.
  const flipped = insightsSeries({ ...data, accounts: [data.accounts[1], data.accounts[0]] }, 'account', accounts);
  assert.deepEqual(flipped.map(x => x.color), ['var(--is1)', 'var(--is2)']);
  // Past the palette's eight, accounts fold into Other too.
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, provider: 'anthropic' }));
  const big = insightsSeries({ ...data, accounts: many.map((a, i) => ({ provider: 'anthropic', account: a.name, tokens: 1, requests: 1, values: [i, 0] })) }, 'account', many);
  assert.equal(big.length, 9);
  assert.equal(big[8].label, 'Other');
  assert.deepEqual(big[8].values, [8 + 9, 0]);
});

test('split by token type: four fixed series', () => {
  const s = insightsSeries(data, 'kind', []);
  assert.deepEqual(s.map(x => x.label), ['Cache read', 'Cache write', 'Input', 'Output']);
  assert.equal(s[0].total, 900);
  assert.deepEqual(insightsSeries(null, 'kind', []), []);
});

test('stacking puts each series on top of the ones before it', () => {
  const cols = stackSeries([{ values: [1, 2] }, { values: [3, 0] }], 2);
  assert.deepEqual(cols, [[[0, 1], [1, 4]], [[0, 2], [2, 2]]]);
});

test('models are ranked by the name a person reads, dated snapshots together', () => {
  const top = topModels(data.models, 6);
  assert.deepEqual(top.map(m => [m.label, m.tokens, m.requests]), [['Opus 5.5', 500, 2], ['Haiku 4.5', 70, 2], ['(unknown)', 5, 1]]);
  assert.equal(topModels(data.models, 1).length, 1);
  assert.deepEqual(topModels(null), []);
});

test('the headline tiles: six, the same on one machine or many', () => {
  /** @param {any[]} tiles */
  const byKey = tiles => Object.fromEntries(tiles.map(t => [t.key, t]));
  const tiles = insightsKpis(data);
  assert.deepEqual(tiles.map(t => t.key), ['tokens', 'cost', 'requests', 'cache', 'perRequest', 'peak']);
  const { tokens, requests, cache, peak } = byKey(tiles);
  assert.equal(tokens.label, 'Tokens');
  assert.equal(tokens.value, '1.0k');
  assert.equal(tokens.sub, '▲ 100% vs the previous 7 days');
  assert.equal(requests.value, '3');
  assert.equal(requests.sub, '▲ 50% vs the previous 7 days');
  // 900 cache reads of 980 prompt tokens; the 20 output tokens are not prompt.
  assert.equal(cache.value, '91.8%');
  // The period before: 400 of 495, 80.8%.
  assert.equal(cache.sub, '▲ 11.0 pts vs the previous period');
  // b: 555 tokens against an average of 500.
  assert.equal(peak.label, 'Busiest day');
  assert.equal(peak.value, '555');
  assert.match(peak.sub, / · 1\.1× the average$/);

  const fresh = byKey(insightsKpis({ ...data, previous: null }));
  assert.equal(fresh.tokens.sub, 'no earlier period on record');
  assert.equal(fresh.cache.sub, 'of prompt tokens were cache reads');
  const empty = byKey(insightsKpis({ ...data, since: null, previous: null, requests: [0, 0], kinds: { cacheRead: [0, 0], cacheWrite: [0, 0], input: [0, 0], output: [0, 0] }, totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  assert.equal(empty.tokens.sub, 'nothing recorded yet');
  assert.equal(empty.cache.value, '—');
  assert.equal(empty.perRequest.value, '—');
  assert.equal(empty.peak.value, '—');
});

test('the per-request tile: estimated cost, tokens and output per request', () => {
  // Five requests, all to priced models.
  const priced = data.models.map(m => ({ ...m, cost: 0.1 }));
  const t = insightsKpis({ ...data, models: priced, cost: { total: 3, values: [1, 2], previous: null, unpricedTokens: 0 } }).find(x => x.key === 'perRequest');
  assert.equal(t?.value, '$0.60');
  assert.equal(t?.sub, '333 tokens · 7 output');
});

test('legend statistics: total, average bucket, peak and the bucket still filling', () => {
  assert.deepEqual(seriesStats([2, 6, 1]), { total: 9, avg: 3, max: 6, last: 1 });
  assert.deepEqual(seriesStats([]), { total: 0, avg: 0, max: 0, last: 0 });
  assert.deepEqual(seriesStats(null), { total: 0, avg: 0, max: 0, last: 0 });
});

test('the cache hit rate counts prompt tokens only, and an idle bucket has none', () => {
  assert.equal(cacheHitRate({ input: 10, cacheRead: 80, cacheWrite: 10 }), 0.8);
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRate(null), null);
  assert.deepEqual(cacheHitSeries({ input: [10, 0], cacheRead: [30, 0], cacheWrite: [0, 0], output: [5, 0] }), [0.75, null]);
});

test('the busiest bucket, and how many average buckets it is', () => {
  assert.deepEqual(peakBucket([1, 4, 4, 3]), { index: 1, value: 4, ratio: 4 / 3 });
  assert.equal(peakBucket([0, 0]), null);
  assert.equal(peakBucket([]), null);
});

test('dollars read at a glance', () => {
  assert.equal(fmtUsd(0), '$0');
  assert.equal(fmtUsd(0.004), '<$0.01');
  assert.equal(fmtUsd(0.42), '$0.42');
  assert.equal(fmtUsd(12.345), '$12.35');
  assert.equal(fmtUsd(999.994), '$999.99');
  assert.equal(fmtUsd(12345.6), '$12,346');
  assert.equal(fmtUsd(null), '$0');
});

test('the cost tile: the estimate, against the period before, and what it left out', () => {
  const tile = (/** @type {any} */ d) => insightsKpis(d).find(t => t.key === 'cost');
  const priced = { ...data, cost: { total: 30, values: [10, 20], previous: 20, unpricedTokens: 0 } };
  assert.equal(tile(priced).label, 'Est. API cost');
  assert.equal(tile(priced).value, '$30.00');
  assert.equal(tile(priced).sub, '▲ 50% vs the previous 7 days');
  const partly = { ...data, cost: { total: 30, values: [10, 20], previous: null, unpricedTokens: 150 } };
  assert.equal(tile(partly).sub, 'at API list prices · 150 tokens unpriced');
  // A linked instance on a proxy older than the estimate sends no cost at all.
  assert.equal(tile(data).value, '—');
  assert.equal(tile(data).sub, 'this proxy is too old to estimate it');
});

const fleet = {
  ...data,
  scope: 'all',
  accounts: [...data.accounts, { provider: 'anthropic', account: 'z', tokens: 9, requests: 1, values: [9, 0] }, { provider: 'anthropic', account: 'm', tokens: 8, requests: 1, values: [0, 8] }],
  instances: [
    { name: 'desk', self: true, state: 'ok', tokens: 700, requests: 2, cost: 5, values: [300, 400] },
    { name: 'laptop', self: false, state: 'unreachable', error: 'timed out', tokens: 0, requests: 0, cost: 0, values: [0, 0] },
    { name: 'server', self: false, state: 'ok', tokens: 300, requests: 1, cost: 2, values: [200, 100] },
  ],
};

test('every machine at once: the machines not counted are named', () => {
  assert.equal(fleetMissingText(fleet), 'Not counted: laptop (unreachable).');
  const all = { ...fleet, instances: [fleet.instances[0], fleet.instances[2]] };
  assert.equal(fleetMissingText(all), null);
  assert.equal(fleetMissingText(data), null);
});

test('split by machine: one series per machine counted, coloured by its place in the list', () => {
  const s = insightsSeries(fleet, 'instance', []);
  assert.deepEqual(s.map(x => [x.label, x.color, x.total]), [['desk', 'var(--is1)', 700], ['server', 'var(--is3)', 300]]);
  assert.deepEqual(s[1].values, [200, 100]);
  assert.deepEqual(insightsSeries(data, 'instance', []), [], 'one machine has no machines to split');
});

test('split by account on every machine: a linked machine\'s accounts follow this one\'s, by name', () => {
  const s = insightsSeries(fleet, 'account', [{ name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic' }]);
  // a and b from this config, then codex/gone, anthropic/m, anthropic/z sorted.
  assert.deepEqual(s.map(x => [x.label, x.color]), [['a', 'var(--is1)'], ['b', 'var(--is2)'], ['m', 'var(--is3)'], ['z', 'var(--is4)'], ['gone', 'var(--is5)']]);
});

test('models carry their cost, null only while no snapshot of them is priced', () => {
  const top = topModels([
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens: 30, requests: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', tokens: 40, requests: 1, input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
    { provider: 'codex', model: '(unknown)', tokens: 5, requests: 1, cost: null },
  ], 6);
  assert.deepEqual(top.map(m => [m.label, m.cost, m.input]), [['Haiku 4.5', 0.75, 50], ['(unknown)', null, 0]]);
});

// Requests and cost per bucket, by provider and by account, as the server
// sends them since the redesign (usage-history.js Series).
const detailed = {
  ...data,
  providers: [
    { provider: 'anthropic', tokens: 700, requests: 2, cost: 3, input: 5, output: 15, cacheRead: 650, cacheWrite: 30, values: [300, 400], requestValues: [1, 1], costValues: [1, 2] },
    { provider: 'grok', tokens: 300, requests: 1, cost: 0.5, input: 5, output: 5, cacheRead: 250, cacheWrite: 40, values: [100, 200], requestValues: [0, 1], costValues: [0, 0.5] },
  ],
  accounts: [
    { provider: 'anthropic', account: 'a', tokens: 700, requests: 2, cost: 3, values: [300, 400], requestValues: [1, 1], costValues: [1, 2] },
    { provider: 'grok', account: 'g', tokens: 300, requests: 1, cost: 0.5, values: [100, 200], requestValues: [0, 1], costValues: [0, 0.5] },
  ],
  models: [
    { provider: 'grok', model: 'grok-4.7', tokens: 250, requests: 1, input: 5, output: 5, cacheRead: 200, cacheWrite: 40, cost: 0.4 },
    { provider: 'anthropic', model: 'claude-opus-5-5', tokens: 700, requests: 2, cost: 3 },
  ],
};

test('requests and cost stack by provider or account, and fall back to one total when they cannot', () => {
  const req = insightsSeries(detailed, 'provider', [], 'requests');
  assert.deepEqual(req.map(x => [x.label, x.values, x.total]), [['Claude', [1, 1], 2], ['Grok', [0, 1], 1]]);
  const cost = insightsSeries(detailed, 'account', [{ name: 'a', provider: 'anthropic' }, { name: 'g', provider: 'grok' }], 'cost');
  assert.deepEqual(cost.map(x => [x.label, x.values, x.total]), [['a', [1, 2], 3], ['g', [0, 0.5], 0.5]]);
  assert.deepEqual(insightsSeries(detailed, 'kind', [], 'requests'), [], 'token types have no requests of their own');
  assert.deepEqual(insightsSeries(data, 'provider', [], 'requests'), [], 'a proxy too old to send them');
  assert.deepEqual(insightsSeries({ ...detailed, splitDetail: false }, 'provider', [], 'cost'), [], 'a fleet sum missing a machine\'s');
});

test('the providers table: share, cost per request and cache hit rate', () => {
  const rows = providerRows(detailed);
  assert.deepEqual(rows.map(r => [r.label, r.accounts, r.requests, r.share]), [['Claude', 1, 2, 0.7], ['Grok', 1, 1, 0.3]]);
  assert.equal(rows[0].perRequest, 1.5);
  assert.equal(rows[1].hit, 250 / 295);
  assert.deepEqual(providerRows(null), []);
});

test('the Grok panel: its share of the history, its models, and each plan as last read', () => {
  const accounts = [
    { name: 'g', provider: 'grok', plan: 'SuperGrok', quota: { unified7d: 0.25, unified7dReset: 2_000_000, planPeriod: 'monthly' } },
    { name: 'h', provider: 'grok', quota: {} },
    { name: 'a', provider: 'anthropic', quota: {} },
  ];
  const g = /** @type {any} */ (grokSummary(detailed, accounts, 1_000_000));
  assert.equal(g.history.tokens, 300);
  assert.deepEqual(g.values, [100, 200]);
  assert.deepEqual(g.models.map((/** @type {any} */ m) => m.label), ['Grok 4.7']);
  assert.deepEqual(g.accounts.map((/** @type {any} */ a) => a.name), ['g', 'h']);
  assert.equal(g.accounts[0].plan, 'SuperGrok');
  assert.deepEqual(g.accounts[0].meters.map((/** @type {any} */ m) => [m.label, m.used]), [['Monthly limit', 0.25]]);
  // No reading yet: the panel says so instead of drawing an empty bar.
  assert.deepEqual(g.accounts[1].meters, []);
  assert.match(g.accounts[1].text, /Refresh quota/);
  assert.equal(grokSummary(data, [{ name: 'a', provider: 'anthropic' }]), null, 'no Grok anywhere: no panel');
  assert.equal(/** @type {any} */ (grokSummary(data, accounts)).history, null, 'a Grok account with no history still shows its plan');
});

test('averages and peaks count from the first bucket recorded', () => {
  // A 7-day range on a history that began on the 6th day.
  const since = new Date(2026, 9, 6, 15, 0).getTime();
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  assert.equal(recordedFrom({ unit: 'day', buckets: days, since }), 5);
  assert.equal(recordedFrom({ unit: 'day', buckets: days, since: null }), 7);
  assert.equal(insightsDayKey(since), '2026-10-06');
  assert.deepEqual(seriesStats([0, 0, 0, 0, 0, 4, 6], 5), { total: 10, avg: 5, max: 6, last: 6 });
  assert.equal(peakBucket([0, 0, 0, 0, 0, 4, 6], 5)?.ratio, 1.2);
  // Hours: the bucket holding `since` is the first.
  const h0 = Math.floor(since / 3600000) * 3600000;
  assert.equal(recordedFrom({ unit: 'hour', buckets: [h0 - 3600000, h0, h0 + 3600000], since }), 1);
});

test('one x is one bucket on every panel, and labels never touch', () => {
  // 24 hourly buckets across 480px: 20px each.
  assert.equal(bucketAt(0, 20, 24), 0);
  assert.equal(bucketAt(39.9, 20, 24), 1);
  assert.equal(bucketAt(479, 20, 24), 23);
  assert.equal(bucketAt(-5, 20, 24), 0, 'left of the plot is the first bucket');
  assert.equal(bucketAt(9999, 20, 24), 23, 'right of it, the last');
  assert.equal(bucketAt(100, 900, 1), 0, 'one bucket');
  // A year on a phone: 366 buckets across 240px.
  assert.equal(bucketAt(239, 240 / 366, 366), 364);
  // "Nov 13" (6 characters) needs 57px: every bucket at 60px, every 3rd at 20px.
  assert.equal(labelStep(6, 60), 1);
  assert.equal(labelStep(6, 20), 3);
  assert.equal(labelStep(6, 240 / 366), 87);
});

test('cost per request divides by requests to priced models only', () => {
  const models = [
    { provider: 'grok', model: 'grok-4.7', requests: 2, cost: 1 },
    { provider: 'grok', model: 'grok-mystery', requests: 8, cost: null },
    { provider: 'anthropic', model: 'claude-opus-5-5', requests: 1, cost: 2 },
  ];
  assert.deepEqual(pricedRequests(models), { all: 3, grok: 2, claude: 1 });
  const rows = providerRows({ ...detailed, models });
  assert.equal(rows.find(r => r.key === 'grok')?.perRequest, 0.5 / 2);
  const tile = insightsKpis({ ...data, models, cost: { total: 3, values: [1, 2], previous: null, unpricedTokens: 10 } }).find(t => t.key === 'perRequest');
  assert.equal(tile?.value, '$1.00');
  // Nothing priced: no figure rather than $0.
  assert.equal(providerRows({ ...detailed, models: [{ provider: 'grok', model: 'x', requests: 3, cost: null }] }).find(r => r.key === 'grok')?.perRequest, null);
});
