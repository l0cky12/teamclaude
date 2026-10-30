// The Insights page's arithmetic (dashboard.js): number formats, axis tops,
// the series each "split by" stacks, donut geometry, model grouping and the
// headline tiles. The page script only draws what these return; its fetching
// is covered with the rest of the page in dashboard.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDashboardHtml, fmtTokens, niceCeil, niceStep, insightsRangeText, insightsDelta, insightsBucketLabel,
  insightsSeries, stackSeries, donutArcs, topModels, insightsKpis,
} from '../src/dashboard.js';

test('the page ships every Insights helper it is tested against', () => {
  const html = renderDashboardHtml();
  for (const fn of [fmtTokens, niceCeil, niceStep, insightsRangeText, insightsDelta, insightsBucketLabel, insightsSeries, stackSeries, donutArcs, topModels, insightsKpis]) {
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

test('donut slices: none for a zero, and a whole circle still draws', () => {
  const arcs = donutArcs([3, 0, 1], 75, 74, 48);
  assert.equal(arcs.length, 3);
  assert.equal(arcs[1], null);
  assert.match(arcs[0], /^M75\.00,1\.00A74,74 0 1 1 /, 'starts at twelve o\'clock, the large arc for 3/4');
  assert.match(arcs[2], /A74,74 0 0 1 /);
  assert.deepEqual(donutArcs([0, 0], 75, 74, 48), [null, null]);
});

// A slice that is the whole is drawn as two concentric circles of opposite
// winding. Under the nonzero fill rule a point is filled when the circles
// around it wind to a nonzero sum: the band between them winds once, the
// centre zero times. (A path a hair short of a full turn used to round its
// inner ends onto one point, lose the inner arc, and fill the centre.)
/** @param {string} d @param {number} x @param {number} y */
function winding(d, x, y) {
  let sum = 0;
  for (const m of d.matchAll(/M([\d.]+),([\d.]+)A([\d.]+),[\d.]+ 0 1 ([01]) /g)) {
    const [cx, top, rad, sweep] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
    const cy = top + rad;
    if (Math.hypot(x - cx, y - cy) < rad) sum += sweep === '1' ? 1 : -1;
  }
  return sum;
}

test('a slice that is the whole is a ring, with its centre left empty', () => {
  for (const values of [[5], [999999, 1], [0, 7]]) {
    const whole = donutArcs(values, 75, 74, 48).find(d => d && (d.match(/M/g) || []).length === 2);
    assert.ok(whole, `${values}: drawn as two circles`);
    assert.ok(!whole.includes('NaN'));
    assert.equal(winding(whole, 75, 75), 0, 'the centre is not filled');
    assert.equal(winding(whole, 75, 75 - 61), 1, 'the band between the circles is');
    assert.equal(winding(whole, 75, 0.5), 0, 'outside the ring is not');
  }
});

test('models are ranked by the name a person reads, dated snapshots together', () => {
  const top = topModels(data.models, 6);
  assert.deepEqual(top.map(m => [m.label, m.tokens, m.requests]), [['Opus 5.5', 500, 2], ['Haiku 4.5', 70, 2], ['(unknown)', 5, 1]]);
  assert.equal(topModels(data.models, 1).length, 1);
  assert.deepEqual(topModels(null), []);
});

test('the headline tiles', () => {
  const accounts = [
    { name: 'a', provider: 'anthropic' }, { name: 'b', provider: 'anthropic', disabled: true },
    { name: 'c', provider: 'codex' }, { name: 'd', provider: 'anthropic', backend: 'api.deepseek.com' },
  ];
  const [tokens, requests, accts, cache] = insightsKpis(data, accounts);
  assert.equal(tokens.label, 'Tokens · last 7 days');
  assert.equal(tokens.value, '1.0k');
  assert.equal(tokens.sub, '▲ 100% vs the previous 7 days');
  assert.equal(requests.value, '3');
  assert.equal(requests.sub, '▲ 50% vs the previous 7 days');
  assert.equal(accts.value, '4');
  assert.equal(accts.sub, '3 enabled · 2 Claude · 1 Codex · 1 backend');
  assert.equal(cache.value, '90.0%');

  const fresh = insightsKpis({ ...data, previous: null }, []);
  assert.equal(fresh[0].sub, 'no earlier period on record');
  assert.equal(fresh[2].sub, 'none configured');
  const empty = insightsKpis({ ...data, since: null, previous: null, totals: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, []);
  assert.equal(empty[0].sub, 'nothing recorded yet');
  assert.equal(empty[3].value, '—');
});
