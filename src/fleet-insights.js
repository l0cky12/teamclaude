// Insights for every machine at once: this proxy's usage history added to
// that of each linked instance (peers.js), for the dashboard's "All machines"
// view.
//
// Each proxy keeps only its own history (usage-history.js), so the sum is
// made when it is read: GET /teamclaude/insights?scope=all asks every peer for
// its own insights over the same range, in parallel, and adds the replies to
// this machine's. The peers are asked for their LOCAL view, never theirs with
// scope=all, so a ring of linked instances cannot ask itself in circles, and
// no machine's tokens are counted twice.
//
// The buckets are lined up by key. Hours are epoch hours and line up exactly.
// Days are each machine's local calendar day, so two machines in different
// time zones put a late-evening request on different days; the sum is right
// for the range, and per day it is as right as the zones are close. A bucket
// a peer has and this machine's axis does not (its clock is ahead across a
// day boundary) is left out of the series but still counted in the totals.
//
// A peer that cannot be read is listed with why, and the rest are summed
// without it: one laptop asleep should not blank the page.

import { peerRequest } from './peers.js';

/** @typedef {import('./usage-history.js').Insights} Insights */
/** @typedef {import('./usage-history.js').Tally} Tally */
/** @typedef {import('./peers.js').Peer} Peer */
/**
 * One machine in the sum. `state` is `ok` when its insights were read, else
 * why not: `unreachable`, `refused` (its key in `peers` is wrong), `outdated`
 * (a proxy that keeps no history) or `error`.
 * @typedef {{
 *   name: string, self: boolean, state: 'ok'|'unreachable'|'refused'|'outdated'|'error', error?: string,
 *   since: number|null, tokens: number, requests: number, cost: number, unpricedTokens: number, values: number[],
 * }} FleetInstance
 * @typedef {Insights & { scope: 'all', instances: FleetInstance[] }} FleetInsights
 */

/** How long one peer gets to answer before the sum goes on without it. */
export const FLEET_PEER_TIMEOUT_MS = 8_000;

/**
 * The scope a GET /teamclaude/insights URL asks for: `all` for every linked
 * machine, else this one. Lenient, like insightsRange.
 * @param {string|undefined} url
 */
export function insightsScope(url) {
  const q = String(url || '').split('?')[1] || '';
  return new URLSearchParams(q).get('scope') === 'all' ? 'all' : 'local';
}

/** @param {unknown} v */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** @param {any} t */
function tokensOf(t) {
  return num(t?.input) + num(t?.output) + num(t?.cacheRead) + num(t?.cacheWrite);
}

/**
 * Ask one peer for its own insights over `range`.
 * @param {Peer} peer
 * @param {string} range
 * @param {typeof peerRequest} request
 * @param {number} timeoutMs
 * @returns {Promise<{ data: Insights|null, state: FleetInstance['state'], error?: string }>}
 */
async function readPeer(peer, range, request, timeoutMs) {
  let out;
  try {
    out = await request(peer, 'insights?range=' + encodeURIComponent(range), { timeoutMs });
  } catch (err) {
    return { data: null, state: 'unreachable', error: /** @type {Error} */ (err).message };
  }
  if (out.status === 401 || out.status === 403) return { data: null, state: 'refused', error: `refused (${out.status}); check its key in peers` };
  if (out.status === 404) return { data: null, state: 'outdated', error: 'runs a proxy that keeps no usage history' };
  if (out.status !== 200) return { data: null, state: 'error', error: `answered ${out.status}` };
  let data;
  try { data = JSON.parse(out.body.toString('utf8')); } catch { return { data: null, state: 'error', error: 'answered something that is not JSON' }; }
  // A peer answers for the range it was asked, or names the one it did. A
  // different one cannot be added bucket for bucket.
  if (!data || typeof data !== 'object' || data.range !== range || !Array.isArray(data.buckets)) {
    return { data: null, state: 'error', error: 'answered for a different range' };
  }
  return { data, state: 'ok' };
}

/**
 * This machine's insights plus every peer's, read now.
 * @param {{ local: Insights, selfName: string, peers: Peer[], request?: typeof peerRequest, timeoutMs?: number }} opts
 * @returns {Promise<FleetInsights>}
 */
export async function fleetInsights({ local, selfName, peers, request = peerRequest, timeoutMs = FLEET_PEER_TIMEOUT_MS }) {
  const read = await Promise.all(peers.map(p => readPeer(p, local.range, request, timeoutMs)));
  return mergeInsights([
    { name: selfName, self: true, state: 'ok', data: local },
    ...peers.map((p, i) => ({ name: p.name, self: false, ...read[i] })),
  ]);
}

/**
 * Add several machines' insights for one range into one. The first part is
 * this machine, and its buckets are the axis, except for `all`, whose axis
 * is every day any machine has, since each starts on its own first day.
 * @param {{ name: string, self: boolean, state: FleetInstance['state'], error?: string, data: Insights|null }[]} parts
 * @returns {FleetInsights}
 */
export function mergeInsights(parts) {
  const local = /** @type {Insights} */ (parts[0].data);
  const ok = parts.filter(p => p.state === 'ok' && p.data);
  /** @type {(string|number)[]} */
  let buckets = local.buckets.slice();
  if (local.range === 'all') {
    const all = new Set(buckets);
    for (const p of ok) for (const b of /** @type {Insights} */ (p.data).buckets) all.add(b);
    buckets = [...all].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }
  const n = buckets.length;
  const at = new Map(buckets.map((b, i) => [b, i]));
  const zeros = () => /** @type {number[]} */ (new Array(n).fill(0));

  const totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const requests = zeros();
  const kinds = { cacheRead: zeros(), cacheWrite: zeros(), input: zeros(), output: zeros() };
  const cost = { total: 0, values: zeros(), previous: /** @type {number|null} */ (0), unpricedTokens: 0 };
  /** @type {Tally|null} */
  let previous = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** @type {number|null} */
  let since = null;
  /** @type {Map<string, { provider: string, tokens: number, cost: number, values: number[] }>} */
  const providers = new Map();
  /** @type {Map<string, { provider: string, account: string, tokens: number, requests: number, cost: number, values: number[] }>} */
  const accounts = new Map();
  /** @type {Map<string, any>} */
  const models = new Map();
  /** @type {FleetInstance[]} */
  const instances = [];

  for (const part of parts) {
    /** @type {FleetInstance} */
    const inst = { name: part.name, self: part.self, state: part.state, since: null, tokens: 0, requests: 0, cost: 0, unpricedTokens: 0, values: zeros() };
    if (part.error) inst.error = part.error;
    instances.push(inst);
    const d = /** @type {any} */ (part.data);
    if (part.state !== 'ok' || !d) continue;
    // Where each of this machine's buckets lands on the axis, or -1.
    const map = (Array.isArray(d.buckets) ? d.buckets : []).map((/** @type {string|number} */ b) => at.get(b) ?? -1);
    /** @param {unknown} vals @param {number[]} into */
    const addSeries = (vals, into) => {
      if (!Array.isArray(vals)) return;
      vals.forEach((v, j) => { const i = map[j]; if (i >= 0) into[i] += num(v); });
    };
    const t = d.totals || {};
    for (const k of /** @type {const} */ (['requests', 'input', 'output', 'cacheRead', 'cacheWrite'])) totals[k] += num(t[k]);
    inst.tokens = tokensOf(t);
    inst.requests = num(t.requests);
    inst.since = typeof d.since === 'number' ? d.since : null;
    if (inst.since != null && (since == null || inst.since < since)) since = inst.since;
    addSeries(d.requests, requests);
    for (const k of /** @type {const} */ (['cacheRead', 'cacheWrite', 'input', 'output'])) {
      addSeries(d.kinds?.[k], kinds[k]);
      addSeries(d.kinds?.[k], inst.values);
    }
    // A machine that records nothing yet spent nothing in either period, so
    // it cannot hold back the comparison. One that recorded part of the
    // earlier period can: what it spent there is unknown, and the sum
    // without it would read as growth.
    if (inst.since != null) {
      if (d.previous && previous) {
        for (const k of /** @type {const} */ (['requests', 'input', 'output', 'cacheRead', 'cacheWrite'])) previous[k] += num(d.previous[k]);
      } else previous = null;
    }
    // A peer older than the cost estimate sends none: its tokens are counted
    // as unpriced rather than as free.
    if (d.cost && typeof d.cost === 'object') {
      inst.cost = num(d.cost.total);
      inst.unpricedTokens = num(d.cost.unpricedTokens);
      addSeries(d.cost.values, cost.values);
      if (cost.previous != null && inst.since != null) cost.previous += num(d.cost.previous);
    } else {
      inst.unpricedTokens = inst.tokens;
    }
    cost.total += inst.cost;
    cost.unpricedTokens += inst.unpricedTokens;

    for (const p of Array.isArray(d.providers) ? d.providers : []) {
      let e = providers.get(p.provider);
      if (!e) providers.set(p.provider, e = { provider: p.provider, tokens: 0, cost: 0, values: zeros() });
      e.tokens += num(p.tokens);
      e.cost += num(p.cost);
      addSeries(p.values, e.values);
    }
    // Accounts by provider and name: an account synced to several machines
    // (credential-sync.js) is one account, spending on each of them.
    for (const a of Array.isArray(d.accounts) ? d.accounts : []) {
      const key = a.provider + '\u0000' + a.account;
      let e = accounts.get(key);
      if (!e) accounts.set(key, e = { provider: a.provider, account: a.account, tokens: 0, requests: 0, cost: 0, values: zeros() });
      e.tokens += num(a.tokens);
      e.requests += num(a.requests);
      e.cost += num(a.cost);
      addSeries(a.values, e.values);
    }
    for (const m of Array.isArray(d.models) ? d.models : []) {
      const key = m.provider + '\u0000' + m.model;
      let e = models.get(key);
      if (!e) models.set(key, e = { provider: m.provider, model: m.model, tokens: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null });
      e.tokens += num(m.tokens);
      e.requests += num(m.requests);
      e.input += num(m.input);
      e.output += num(m.output);
      e.cacheRead += num(m.cacheRead);
      e.cacheWrite += num(m.cacheWrite);
      if (typeof m.cost === 'number') e.cost = (e.cost ?? 0) + num(m.cost);
    }
  }
  // `all` has nothing before it, on any machine, and a fleet that has
  // recorded nothing has no earlier period either.
  if (local.range === 'all' || since == null) previous = null;
  if (previous == null) cost.previous = null;

  /** @param {{ tokens: number }} x @param {{ tokens: number }} y */
  const byTokens = (x, y) => y.tokens - x.tokens;
  return {
    range: local.range,
    unit: local.unit,
    buckets,
    since,
    totals,
    previous,
    requests,
    kinds,
    cost,
    providers: [...providers.values()].sort(byTokens),
    accounts: [...accounts.values()].sort(byTokens),
    models: [...models.values()].sort(byTokens),
    scope: 'all',
    instances,
  };
}
