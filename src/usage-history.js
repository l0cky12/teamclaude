// Usage history by day: what the dashboard's Insights page draws.
//
// Every other usage figure the proxy keeps answers a different question. An
// account's `usage.total*` counters say how much it has ever spent, and the
// client trackers' 15-minute slots (client-usage.js) say how much went out in
// the last 5 or 24 hours. Neither can say how much was spent last Tuesday, or
// whether this month is busier than the last, because nothing recorded WHEN a
// token was spent beyond a day ago. This does, at a bounded cost.
//
// Each response that reports usage is booked twice: into the day it arrived on
// (local time on the proxy's machine, which is where a day starts for the
// person running it) and into its hour. Days are kept for a year and hours for
// two days, so the cost is set by those two lengths rather than by uptime. The
// hours exist for the 24-hour view and its comparison with the 24 hours before.
//
// A bucket is a set of rows, one per provider, account and model. "Provider" is
// the account's group as the dashboard draws it: `anthropic`, `codex`, or
// `backend:<host>` for an API key on a third-party backend (DeepSeek, z.ai),
// which by provider alone would be counted as Claude. Accounts are
// operator-configured, so they are bounded by the config, but model ids come
// from requests, so a bucket admits at most HISTORY_ROW_CAP rows. Past that, a
// new model is folded into the account's OVERFLOW_MODEL row rather than
// dropped, so the day's total stays right and only the model split loses
// detail. client-usage.js makes the same choice for the same reason.
//
// Nothing routes on any of this. It is read by GET /teamclaude/insights and
// persisted in the state file next to the quota. What the tokens would cost on
// an API key is worked out when they are read (api-pricing.js), not stored, so
// a corrected price applies to the whole history.

import { costAt, priceLookup } from './api-pricing.js';

/** @typedef {{ requests: number, input: number, output: number, cacheRead: number, cacheWrite: number }} Tally */
/** @typedef {{ provider: string, account: string, model: string, tally: Tally }} Row */
/** @typedef {Map<string, Row>} Bucket */
/**
 * One row as saved: `[provider, account, model, requests, input, output, cacheRead, cacheWrite]`.
 * @typedef {[string, string, string, number, number, number, number, number]} SavedRow
 */
/**
 * The saved form. Each bucket is its rows as one compact JSON string: the state
 * file is written indented, and indented, every number of every row would take
 * a line of its own, which over a year of days is most of the file.
 * @typedef {{ v: number, since: number|null, days: Record<string, string>, hours: Record<string, string> }} SavedHistory
 */
/**
 * @typedef {{
 *   range: string,
 *   unit: 'hour'|'day',
 *   buckets: (string|number)[],
 *   since: number|null,
 *   totals: Tally,
 *   previous: Tally|null,
 *   requests: number[],
 *   kinds: { cacheRead: number[], cacheWrite: number[], input: number[], output: number[] },
 *   cost: InsightsCost,
 *   providers: { provider: string, tokens: number, cost: number, values: number[] }[],
 *   accounts: { provider: string, account: string, tokens: number, requests: number, cost: number, values: number[] }[],
 *   models: ({ provider: string, model: string, tokens: number, requests: number, cost: number|null } & Tally)[],
 * }} Insights
 */
/**
 * The range's tokens at API list prices (api-pricing.js), in USD: in all,
 * per bucket, and for the period before (null exactly when `previous` is).
 * `unpricedTokens` are the range's tokens on models with no known price,
 * which none of the figures include.
 * @typedef {{ total: number, values: number[], previous: number|null, unpricedTokens: number }} InsightsCost
 */

/** Days of history kept: a year, so the same week last year is still there. */
export const HISTORY_DAYS = 366;
/** Hours kept: the last 24 and the 24 before them, which the 24-hour view compares against. */
export const HISTORY_HOURS = 48;
/** Rows one bucket may hold before new models fold into OVERFLOW_MODEL. */
export const HISTORY_ROW_CAP = 200;
/** Where a model lands once its bucket is full. */
export const OVERFLOW_MODEL = '(other)';
/** What a response that named no model is booked under. */
export const UNKNOWN_MODEL = '(unknown)';
/** The ranges GET /teamclaude/insights answers for, shortest first. */
export const INSIGHTS_RANGES = ['24h', '7d', '30d', '90d', 'all'];
/** The range a request that names none (or an unknown one) gets. */
export const DEFAULT_INSIGHTS_RANGE = '30d';

const HOUR_MS = 60 * 60 * 1000;
const MODEL_MAX_LENGTH = 100;
const SAVED_VERSION = 1;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The local calendar day `ts` falls on, as YYYY-MM-DD. The string form sorts
 * in date order, which is what pruning compares on.
 * @param {number} ts
 */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day `n` days after `key` (before, for a negative `n`). Built from the
 * calendar fields rather than by adding 24 hours, so a daylight-saving change
 * cannot land two keys on one day or skip one.
 * @param {string} key
 * @param {number} n
 */
export function addDays(key, n) {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return key;
  return dayKey(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n).getTime());
}

/**
 * Local midnight at the start of `key`, in epoch milliseconds.
 * @param {string} key
 */
export function dayStart(key) {
  const m = DAY_KEY_RE.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
}

/** @returns {Tally} */
function emptyTally() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** @param {unknown} v */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Everything a tally adds up to, cache included. The input side of a Claude
 * Code turn is nearly all cache reads, so a total without them would understate
 * what the account spent by orders of magnitude (dashboard.js accountTokens
 * says the same about the lifetime counters).
 * @param {Tally} t
 */
export function tallyTokens(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/**
 * @param {Tally} into
 * @param {Tally} t
 */
function addTally(into, t) {
  into.requests += t.requests;
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
}

/**
 * One upstream usage report as a tally of one request. The field names are
 * Anthropic's; the Codex path rewrites its own into them before they get here
 * (responses-usage.js).
 * @param {Record<string, unknown>} usage
 * @returns {Tally}
 */
function tallyOf(usage) {
  return {
    requests: 1,
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
  };
}

/** @param {unknown} model */
function modelName(model) {
  const s = typeof model === 'string' ? model.trim().slice(0, MODEL_MAX_LENGTH) : '';
  return s || UNKNOWN_MODEL;
}

/**
 * Rows keyed by provider, account and model. NUL cannot appear in any of the
 * three, so the key cannot be produced by two different rows.
 * @param {string} provider
 * @param {string} account
 * @param {string} model
 */
function rowKey(provider, account, model) {
  return `${provider}\u0000${account}\u0000${model}`;
}

export class UsageHistory {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = Date.now } = {}) {
    /** @type {Map<string, Bucket>} day key → rows */
    this.days = new Map();
    /** @type {Map<number, Bucket>} hour number (epoch hours) → rows */
    this.hours = new Map();
    /**
     * When recording began: the first response this history (or the one it
     * was restored from) booked. A comparison with a period before this would
     * be against nothing, so insights() reports none.
     * @type {number|null}
     */
    this.since = null;
    this._now = now;
  }

  /**
   * Book one usage report. `usage` is the response's own usage object; one
   * that is not an object books nothing, since there is no request to count.
   * @param {{ provider: string, account: string, model?: string|null, usage: unknown }} entry
   */
  record({ provider, account, model, usage }) {
    if (!usage || typeof usage !== 'object' || !account) return;
    const tally = tallyOf(/** @type {Record<string, unknown>} */ (usage));
    const now = this._now();
    if (this.since == null) this.since = now;
    const day = dayKey(now);
    const hour = Math.floor(now / HOUR_MS);
    // Pruning runs when a write opens a new bucket: that is the only time the
    // retention edge can have moved past something since the last prune.
    const opening = !this.days.has(day) || !this.hours.has(hour);
    const name = modelName(model);
    this._add(this._bucket(this.days, day), provider || 'unknown', account, name, tally);
    this._add(this._bucket(this.hours, hour), provider || 'unknown', account, name, tally);
    if (opening) this._prune(now);
  }

  /**
   * @template K
   * @param {Map<K, Bucket>} map
   * @param {K} key
   * @returns {Bucket}
   */
  _bucket(map, key) {
    let b = map.get(key);
    if (!b) map.set(key, b = new Map());
    return b;
  }

  /**
   * @param {Bucket} bucket
   * @param {string} provider
   * @param {string} account
   * @param {string} model
   * @param {Tally} tally
   */
  _add(bucket, provider, account, model, tally) {
    let key = rowKey(provider, account, model);
    let row = bucket.get(key);
    if (!row && bucket.size >= HISTORY_ROW_CAP) {
      // The overflow row is per account, so a full bucket still says whose
      // tokens they were. It can take the bucket past the cap by one row per
      // account, which the config bounds.
      model = OVERFLOW_MODEL;
      key = rowKey(provider, account, model);
      row = bucket.get(key);
    }
    if (!row) bucket.set(key, row = { provider, account, model, tally: emptyTally() });
    addTally(row.tally, tally);
  }

  /**
   * Drop what has fallen out of retention.
   * @param {number} now
   */
  _prune(now) {
    const firstDay = addDays(dayKey(now), -(HISTORY_DAYS - 1));
    for (const key of this.days.keys()) if (key < firstDay) this.days.delete(key);
    const firstHour = Math.floor(now / HOUR_MS) - (HISTORY_HOURS - 1);
    for (const h of this.hours.keys()) if (h < firstHour) this.hours.delete(h);
  }

  /**
   * The state-file form. Pruned first, so a history saved after a quiet month
   * does not carry days that have already left retention.
   * @returns {SavedHistory}
   */
  exportState() {
    this._prune(this._now());
    /** @param {Bucket} b */
    const rows = b => JSON.stringify([...b.values()].map(r => /** @type {SavedRow} */ ([r.provider, r.account, r.model,
      r.tally.requests, r.tally.input, r.tally.output, r.tally.cacheRead, r.tally.cacheWrite])));
    /** @type {Record<string, string>} */
    const days = {};
    for (const [k, b] of this.days) days[k] = rows(b);
    /** @type {Record<string, string>} */
    const hours = {};
    for (const [h, b] of this.hours) hours[String(h)] = rows(b);
    return { v: SAVED_VERSION, since: this.since, days, hours };
  }

  /**
   * Add a saved history onto this one. A row that is not the saved shape is
   * skipped rather than failing the whole restore: a state file is written by
   * this code, but a hand edit or a truncated write should cost a row, not the
   * year. Anything already outside retention is dropped here, so a proxy that
   * was down for a long time does not report dead days until its next write.
   * @param {unknown} saved
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const s = /** @type {Partial<SavedHistory>} */ (saved);
    if (s.v !== SAVED_VERSION) return;
    const now = this._now();
    const firstDay = addDays(dayKey(now), -(HISTORY_DAYS - 1));
    const today = dayKey(now);
    const hourNow = Math.floor(now / HOUR_MS);
    if (s.days && typeof s.days === 'object') {
      for (const [key, rows] of Object.entries(s.days)) {
        // A day ahead of the clock is refused too: it would be reported as
        // today's spend for as long as the clock stays behind it.
        if (!DAY_KEY_RE.test(key) || key < firstDay || key > today) continue;
        this._restoreRows(this._bucket(this.days, key), rows);
      }
    }
    if (s.hours && typeof s.hours === 'object') {
      for (const [key, rows] of Object.entries(s.hours)) {
        const h = Number(key);
        if (!Number.isInteger(h) || h <= hourNow - HISTORY_HOURS || h > hourNow) continue;
        this._restoreRows(this._bucket(this.hours, h), rows);
      }
    }
    for (const [key, b] of this.days) if (!b.size) this.days.delete(key);
    for (const [key, b] of this.hours) if (!b.size) this.hours.delete(key);
    // A saved history without `since` began on its earliest surviving day.
    let since = typeof s.since === 'number' && Number.isFinite(s.since) ? s.since : null;
    if (since == null && this.days.size) since = dayStart([...this.days.keys()].sort()[0]);
    if (since != null && (this.since == null || since < this.since)) this.since = since;
  }

  /**
   * @param {Bucket} bucket
   * @param {unknown} rows
   */
  _restoreRows(bucket, rows) {
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows); } catch { return; }
    }
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 8) continue;
      const [provider, account, model] = r;
      if (typeof provider !== 'string' || typeof account !== 'string' || typeof model !== 'string' || !account) continue;
      this._add(bucket, provider, account, modelName(model), {
        requests: count(r[3]), input: count(r[4]), output: count(r[5]), cacheRead: count(r[6]), cacheWrite: count(r[7]),
      });
    }
  }

  /**
   * What the Insights page draws for one range: a series per provider, per
   * account and per token kind, requests per bucket, the range's totals, the
   * same totals for the period just before it (null when history does not
   * reach back that far, or for `all`), and the range ranked by account and
   * by model.
   *
   * `24h` is hourly, over the current hour and the 23 before it. Every other
   * range is daily, today included, and `all` starts on the day recording did.
   * @param {string} [range]
   * @returns {Insights}
   */
  insights(range = DEFAULT_INSIGHTS_RANGE) {
    if (!INSIGHTS_RANGES.includes(range)) range = DEFAULT_INSIGHTS_RANGE;
    const now = this._now();
    this._prune(now);
    /** @type {Bucket[]} */
    let current;
    /** @type {Bucket[]|null} */
    let before = null;
    /** @type {(string|number)[]} */
    let buckets;
    /** @type {'hour'|'day'} */
    let unit;
    if (range === '24h') {
      unit = 'hour';
      const hour = Math.floor(now / HOUR_MS);
      const hours = Array.from({ length: 24 }, (_, i) => hour - 23 + i);
      buckets = hours.map(h => h * HOUR_MS);
      current = hours.map(h => this.hours.get(h) ?? new Map());
      // Compared by hour (and below by day) rather than to the millisecond:
      // recording that began part-way through the first hour of the earlier
      // period still covers it well enough to compare against.
      const firstBefore = hour - 47;
      if (this.since != null && Math.floor(this.since / HOUR_MS) <= firstBefore) {
        before = hours.map(h => this.hours.get(h - 24) ?? new Map());
      }
    } else {
      unit = 'day';
      const today = dayKey(now);
      let n;
      if (range === 'all') {
        const first = this.since == null ? today : dayKey(this.since);
        n = 1;
        while (n < HISTORY_DAYS && addDays(today, -n) >= first) n++;
      } else {
        n = Number.parseInt(range, 10);
      }
      const keys = Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
      buckets = keys;
      current = keys.map(k => this.days.get(k) ?? new Map());
      if (range !== 'all') {
        const firstBefore = addDays(today, -(2 * n - 1));
        if (this.since != null && dayKey(this.since) <= firstBefore) {
          before = keys.map(k => this.days.get(addDays(k, -n)) ?? new Map());
        }
      }
    }
    return summarize(range, unit, buckets, current, before, this.since);
  }
}

/**
 * @param {string} range
 * @param {'hour'|'day'} unit
 * @param {(string|number)[]} buckets
 * @param {Bucket[]} current
 * @param {Bucket[]|null} before
 * @param {number|null} since
 * @returns {Insights}
 */
function summarize(range, unit, buckets, current, before, since) {
  const n = buckets.length;
  const zeros = () => /** @type {number[]} */ (new Array(n).fill(0));
  const totals = emptyTally();
  const requests = zeros();
  const kinds = { cacheRead: zeros(), cacheWrite: zeros(), input: zeros(), output: zeros() };
  const price = priceLookup();
  /** @param {Row} row */
  const rowCost = row => { const p = price(row.provider, row.model); return p ? costAt(p, row.tally) : null; };
  const cost = { total: 0, values: zeros(), previous: /** @type {number|null} */ (null), unpricedTokens: 0 };
  /** @type {Map<string, { provider: string, tokens: number, cost: number, values: number[] }>} */
  const providers = new Map();
  /** @type {Map<string, { provider: string, account: string, tokens: number, requests: number, cost: number, values: number[] }>} */
  const accounts = new Map();
  /** @type {Map<string, { provider: string, model: string, tokens: number, cost: number|null } & Tally>} */
  const models = new Map();
  current.forEach((bucket, i) => {
    for (const row of bucket.values()) {
      const t = row.tally;
      const tokens = tallyTokens(t);
      const usd = rowCost(row);
      addTally(totals, t);
      if (usd == null) cost.unpricedTokens += tokens;
      else { cost.total += usd; cost.values[i] += usd; }
      requests[i] += t.requests;
      kinds.cacheRead[i] += t.cacheRead;
      kinds.cacheWrite[i] += t.cacheWrite;
      kinds.input[i] += t.input;
      kinds.output[i] += t.output;
      let p = providers.get(row.provider);
      if (!p) providers.set(row.provider, p = { provider: row.provider, tokens: 0, cost: 0, values: zeros() });
      p.tokens += tokens;
      p.cost += usd ?? 0;
      p.values[i] += tokens;
      const ak = rowKey(row.provider, row.account, '');
      let a = accounts.get(ak);
      if (!a) accounts.set(ak, a = { provider: row.provider, account: row.account, tokens: 0, requests: 0, cost: 0, values: zeros() });
      a.tokens += tokens;
      a.requests += t.requests;
      a.cost += usd ?? 0;
      a.values[i] += tokens;
      const mk = rowKey(row.provider, '', row.model);
      let m = models.get(mk);
      // A model is priced or not as a whole, so its cost is null exactly when
      // its every row's is.
      if (!m) models.set(mk, m = { provider: row.provider, model: row.model, tokens: 0, cost: usd == null ? null : 0, ...emptyTally() });
      m.tokens += tokens;
      addTally(m, t);
      if (usd != null) m.cost = (m.cost ?? 0) + usd;
    }
  });
  /** @type {Tally|null} */
  let previous = null;
  if (before) {
    const prev = emptyTally();
    let prevCost = 0;
    for (const bucket of before) {
      for (const row of bucket.values()) {
        addTally(prev, row.tally);
        prevCost += rowCost(row) ?? 0;
      }
    }
    previous = prev;
    cost.previous = prevCost;
  }
  /** @param {{ tokens: number }} x @param {{ tokens: number }} y */
  const byTokens = (x, y) => y.tokens - x.tokens;
  return {
    range,
    unit,
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
  };
}

/**
 * The range a GET /teamclaude/insights URL asks for: its `range` query
 * parameter when that is one of INSIGHTS_RANGES, else the default. Lenient on
 * purpose, like logsAfter: the reply names the range it answered for.
 * @param {string|undefined} url
 */
export function insightsRange(url) {
  const q = String(url || '').split('?')[1] || '';
  const range = new URLSearchParams(q).get('range');
  return range && INSIGHTS_RANGES.includes(range) ? range : DEFAULT_INSIGHTS_RANGE;
}
