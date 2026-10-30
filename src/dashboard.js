// The status dashboard: a single self-contained HTML page served at
// GET /teamclaude/dashboard, rendering /teamclaude/status for humans.
//
// The page itself contains NO data — it is a static asset whose script fetches
// /teamclaude/status (same origin) with the proxy key and re-renders every few
// seconds. That split is what lets the asset be served without the key (a
// browser address bar cannot send x-api-key) while every byte of actual status
// stays behind the existing gate. The key is asked for only when the server
// refuses the page without one (401/403; loopback browsers are exempt), and is
// kept in localStorage; a later refusal (wrong or rotated key) asks again.
//
// Self-contained on purpose: no external scripts, styles, or fonts, so the
// page works on air-gapped deployments and adds no third-party surface. All
// rendering uses textContent — status fields (account names, client names) are
// operator/OAuth-derived, but they still never reach innerHTML.

import { createHash } from 'node:crypto';
import { UNAVAILABLE_TEXT, RESET_CREDIT_MAX_AGE_MS, outsideSpendText, forecastText, showSessionRow } from './status-renderer.js';
import { USAGE_WINDOWS } from './client-usage.js';
import { EVENT_LOG_CAPACITY } from './event-log.js';
import { logoDataUrl, logoMarkup } from './logo.js';

export function renderDashboardHtml() {
  return PAGE;
}

/**
 * The body of every `<script>` in the page, in order. Attribute-free tags only,
 * which is all this page has and all the hash policy can admit anyway.
 *
 * @param {string} html
 */
export function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * Content-Security-Policy for the dashboard, sent by the server with the page.
 *
 * The page holds the proxy key in localStorage, so the policy is the backstop
 * for a script that should never run there: nothing loads from anywhere
 * (`default-src 'none'`), each inline script (the theme bootstrap in `<head>`
 * and the main script) is admitted by its hash rather than by
 * `'unsafe-inline'` — the page is static, so the hashes are stable — and the
 * only network the script may touch is this origin, for status and switch.
 * Styles need `'unsafe-inline'` because the layout uses `style=` attributes,
 * which hashes do not cover; CSSOM writes (`el.style.width = …`) are not
 * governed by CSP at all. `img-src data:` admits embedded images for the tab icon,
 * which is the logo inlined as a `data:` URL in `<head>`: a `data:` image can
 * carry no script and reach no network, and nothing from `'self'` or any
 * other origin is allowed. `frame-ancestors 'none'` keeps the page out of
 * another site's iframe, where a click on "switch" could be overlaid.
 */
export function dashboardCsp(html = PAGE) {
  // Every inline script, not just the first: the theme is applied by a short
  // script in <head> so the page does not paint dark and then flip to light,
  // and a hash that covered only the main script would leave that one blocked.
  const hashes = inlineScripts(html)
    .map(script => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`)
    .join(' ');
  return [
    "default-src 'none'",
    `script-src ${hashes}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The page's pure logic lives here, not in the script string: these functions
// close over nothing and touch no DOM, so they are serialized into the page
// with toString() below AND exported for the test suite. One implementation,
// tested and served — a test against the string would only be a source grep.

// Model-scoped weekly buckets, one row per family upstream actually metered.
// `scopedWeekly` is learned from the usage payload's `limits` array, so it is
// the complete list when present; the two dedicated fields are the fallback for
// a payload that reported `seven_day_sonnet` without a `limits` array.
export function scopedWeeklyRows(quota) {
  var q = quota || {};
  var scoped = q.scopedWeekly || {};
  var rows = [];
  Object.keys(scoped).forEach(function (family) {
    var b = scoped[family] || {};
    rows.push({ family: family, label: family.charAt(0).toUpperCase() + family.slice(1), utilization: b.utilization, resetAt: b.resetAt });
  });
  [{ family: 'fable', label: 'Fable', u: q.unified7dFable, r: q.unified7dFableReset },
    { family: 'sonnet', label: 'Sonnet', u: q.unified7dSonnet, r: q.unified7dSonnetReset }].forEach(function (f) {
    if (Object.prototype.hasOwnProperty.call(scoped, f.family) || f.u == null) return;
    rows.push({ family: f.family, label: f.label, utilization: f.u, resetAt: f.r });
  });
  rows.sort(function (a, b) { return a.family < b.family ? -1 : a.family > b.family ? 1 : 0; });
  return rows;
}

// Whether a card gets a refresh button: the probe has a quota to read for the
// account and would probe it (the server applies the same rule and says why
// when it refuses). `probeEntry` is the account's row in status.probe.accounts.
/** @param {any} account @param {any} probeEntry */
export function canRefreshQuota(account, probeEntry) {
  if (!account || account.disabled) return false;
  return !!probeEntry && probeEntry.status !== 'not-applicable';
}

// The POST a card's refresh button sends: the fleet probe, narrowed to one
// account. Provider and org ride along because a name alone can belong to two
// cards (one email with a Claude and a Codex login, or seats in two orgs).
/** @param {any} account  one entry of status.accounts @param {string|null} key */
export function refreshQuotaRequest(account, key) {
  /** @type {{ account: any, provider?: any, org?: any }} */
  var body = { account: account.name };
  if (account.provider) body.provider = account.provider;
  if (account.orgName) body.org = account.orgName;
  return {
    url: '/teamclaude/probe',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/** @param {any} res */
export function refreshQuotaOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'quota refresh failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: 'quota refreshed' };
}

// How many free rate-limit resets a Codex account has left, as the page shows
// it: null when there is nothing to go on (not a Codex account, no usage
// reading yet, or one past RESET_CREDIT_MAX_AGE_MS, the badge's own cut-off),
// else the count. Zero is a reading too, and the page says so.
/** @param {any} account @param {number|null} [now] */
export function codexResetsLeft(account, now) {
  var a = account || {};
  if (a.provider !== 'codex') return null;
  var reading = (a.quota || {}).resetCredits;
  if (!reading || !Number.isFinite(reading.available)) return null;
  var at = now == null ? Date.now() : now;
  if (Number.isFinite(reading.seenAt) && at - reading.seenAt > RESET_CREDIT_MAX_AGE_MS) return null;
  if (Number.isFinite(reading.expiresAt) && reading.expiresAt <= at) return 0;
  return Math.max(0, reading.available);
}

// The resets a set of Codex accounts holds between them, for the quota page's
// Codex card: null when none of them has a reading.
/** @param {any[]} accounts @param {number|null} [now] */
export function codexResetsSummary(accounts, now) {
  var left = 0;
  var read = 0;
  (accounts || []).forEach(function (a) {
    var n = codexResetsLeft(a, now);
    if (n == null) return;
    read++;
    left += n;
  });
  return read ? { left: left, accounts: read } : null;
}

// Whether a row gets a "Reset usage" button: a Codex account rotation can use,
// holding a credit, and a key the server would let spend it.
/** @param {any} account @param {any} caller @param {number|null} [now] */
export function canRedeemReset(account, caller, now) {
  if (!account || account.disabled) return false;
  return (codexResetsLeft(account, now) || 0) > 0 && callerCan(caller, '/teamclaude/reset-credits/redeem');
}

// The POST the button sends. Same body as refreshQuotaRequest, for the same
// reason: a name alone can belong to two cards.
/** @param {any} account @param {string|null} key */
export function redeemResetRequest(account, key) {
  var r = refreshQuotaRequest(account, key);
  r.url = '/teamclaude/reset-credits/redeem';
  return r;
}

// What a click on "Reset usage" does, decided when the click lands rather than
// when the button was drawn: a button armed and then left (the poll that would
// redraw it can be late, or failing) must not spend a reset on a click long
// after the window it offered has closed. Out of that window the click arms it
// again; a second click too soon after the first is a double-click.
/** @param {number|null|undefined} armedAt @param {number} now @param {number} confirmMs @param {number} doubleClickMs */
export function resetClickStep(armedAt, now, confirmMs, doubleClickMs) {
  if (armedAt == null || now - armedAt >= confirmMs) return 'arm';
  if (now - armedAt < doubleClickMs) return 'wait';
  return 'redeem';
}

// What the row says after a reset. A declined reset spent nothing and says
// why; one with no verdict to read — the server said it never heard back, or
// the answer itself was lost on the way to the page — may have spent a credit,
// and says that rather than reporting a failure that invites a second one.
/** @param {any} res  the server's answer, or null when none could be read */
export function redeemResetOutcome(res) {
  if (!res) return { kind: 'error', text: REDEEM_UNCERTAIN_TEXT };
  var r = res;
  if (r.ok) {
    var n = r.windowsReset || 0;
    return { kind: 'ok', text: 'usage reset' + (n ? ': ' + n + ' limit window' + (n === 1 ? '' : 's') + ' cleared' : '') };
  }
  // `unreachable` is the linked-instance relay (peers.js) losing the peer
  // mid-request: it cannot say whether the peer acted before the connection
  // went, so it is no more a "no" than an unread verdict here.
  if (r.uncertain || r.unreachable) return { kind: 'error', text: REDEEM_UNCERTAIN_TEXT };
  if (r.code === 'nothing_to_reset') return { kind: 'warn', text: 'nothing to reset yet: no limit on this account is spent, so no reset was used' };
  if (r.code === 'no_credit') return { kind: 'warn', text: 'no resets left on this account' };
  return { kind: 'error', text: 'reset failed' + (r.error ? ': ' + r.error : '') };
}

// The rows a third-party backend's own reading draws on its card (#530). The
// probe stores it as `quota.backend` (backend-quota.js): per-window fractions
// when the provider reports distinct windows, else one fraction, else text
// alone. A window past its reset is left out — the reading predates the reset,
// so its fraction no longer describes anything. `text` is what is left to say
// when no bar can be drawn: a balance has no fraction to fill a bar with.
/** @param {any} backend @param {number} [now] */
export function backendQuotaRows(backend, now) {
  var b = backend || {};
  var at = now == null ? Date.now() : now;
  var w = b.windows || {};
  var rows = [];
  [{ key: 'fiveHour', label: 'Session' }, { key: 'weekly', label: 'Weekly' }, { key: 'monthly', label: 'Monthly' }].forEach(function (d) {
    var win = w[d.key];
    if (!win || win.utilization == null) return;
    if (win.resetAt != null && win.resetAt <= at) return;
    rows.push({ label: d.label, utilization: win.utilization, resetAt: win.resetAt == null ? null : win.resetAt });
  });
  // The aggregate was measured with these windows: once they expire it must
  // not turn back into a timeless reading that keeps the account hidden.
  if (!Object.keys(w).length && b.utilization != null) rows.push({ label: b.label || 'Quota', utilization: b.utilization, resetAt: null });
  return { rows: rows, text: !rows.length && b.text ? (b.label || 'Quota') + ': ' + b.text : null };
}

// What an account has spent, cache included. `totalInputTokens` counts uncached
// input only, which on Claude Code traffic is ~0.05% of the input side — a
// total without the cache fields understates the account by orders of magnitude.
export function accountTokens(usage) {
  var u = usage || {};
  return (u.totalInputTokens || 0) + (u.totalOutputTokens || 0)
    + (u.totalCacheReadTokens || 0) + (u.totalCacheCreationTokens || 0);
}

// A model id as a person would say it: claude-opus-5-5 -> "Opus 5.5",
// claude-haiku-4-5-20251001 -> "Haiku 4.5", gpt-6.1-sol -> "GPT 6.1 Sol".
// A context suffix ("[1m]") is dropped; any other shape is shown as sent.
export function modelLabel(/** @type {string} */ id) {
  var s = String(id);
  var br = s.indexOf('[');
  if (br > 0) s = s.slice(0, br);
  var parts = s.split('-');
  var isNum = function (/** @type {string} */ p) { return p !== '' && !isNaN(Number(p)); };
  var cap = function (/** @type {string} */ w) { return w.charAt(0).toUpperCase() + w.slice(1); };
  if (parts[0] === 'claude' && parts.length >= 3) {
    // Date stamps (8 digits) are a snapshot id, not part of the version.
    var nums = parts.slice(2).filter(function (p) { return isNum(p) && p.length < 8; });
    if (nums.length) return cap(parts[1]) + ' ' + nums.slice(0, 2).join('.');
  }
  if (parts[0] === 'gpt' && parts.length >= 2) {
    return 'GPT ' + parts[1] + (parts.length > 2 ? ' ' + parts.slice(2).map(cap).join(' ') : '');
  }
  return s;
}

// The models an account served in the last 15 minutes, newest first, at most
// three. Haiku is what Claude Code uses for side requests (titles, summaries),
// so it is listed only when nothing else ran — otherwise it would crowd out
// the model the sessions on that account are actually working with.
export function recentModelLabels(/** @type {any} */ usage, /** @type {number} */ now) {
  /** @type {Record<string, number>} */
  var seen = (usage && usage.recentModels) || {};
  var at = now == null ? Date.now() : now;
  var ids = Object.keys(seen).filter(function (k) { return at - seen[k] < 15 * 60 * 1000; })
    .sort(function (x, y) { return seen[y] - seen[x]; });
  var main = ids.filter(function (k) { return k.toLowerCase().indexOf('haiku') < 0; });
  return (main.length ? main : ids).slice(0, 3).map(modelLabel);
}

export function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'anthropic') return 'Claude';
  return provider || 'Unknown';
}

// Every bucket switchThreshold can be keyed by, plus the short names the
// threshold badge shows them under. Mirrors THRESHOLD_BUCKET_KEYS in model.js
// and THRESHOLD_BUCKET_LABELS in status-renderer.js — duplicated rather than
// imported, because the browser never runs an import. It does not see this
// module's scope either: a helper reaches the page as its own source text, so
// these two are written into the page by SHARED_CONSTS below. Without that the
// first table-form override throws a ReferenceError inside render() and takes
// the accounts pane with it.
export var THRESHOLD_BUCKET_KEYS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'tokens', 'requests'];
/** @type {Object<string, string>} */
export var THRESHOLD_BUCKET_LABELS = {
  unified5h: '5h', unified7d: '7d', unified7dSonnet: 'sonnet', unified7dFable: 'fable',
  tokens: 'tokens', requests: 'requests',
};

/**
 * "switch at 100%" / "switch 7d 90%, fable 80%" — an account's OWN
 * switchThreshold (issue #409), or '' when it has none or every override it
 * carries merely repeats what the fleet already resolves to. `fleetThreshold`
 * and `fleetThresholds` are the status payload's own top-level fields
 * (`status.switchThreshold` / `status.switchThresholds`), so the comparison
 * uses the exact fleet value the live server is gating on.
 * @param {number|Object<string, number>|null|undefined} accountThreshold
 * @param {number|null|undefined} fleetThreshold
 * @param {Object<string, number>|null|undefined} fleetThresholds
 * @returns {string}
 */
export function thresholdBadgeText(accountThreshold, fleetThreshold, fleetThresholds) {
  /** @param {string} bucket */
  function fleetFor(bucket) {
    if (fleetThresholds && typeof fleetThresholds === 'object') {
      var v = fleetThresholds[bucket];
      if (v == null) v = fleetThresholds.default;
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return typeof fleetThreshold === 'number' && isFinite(fleetThreshold) ? fleetThreshold : 0.98;
  }
  /** @param {number} v */
  function pct(v) { return (Math.round(v * 1000) / 10) + '%'; }
  /** @param {unknown} v */
  function valid(v) { return typeof v === 'number' && isFinite(v); }
  /** @type {string[]} */
  var parts = [];
  /** @type {Object<string, any>} */
  var table = {};
  /** @type {any} */
  var ownDefault = null;
  if (typeof accountThreshold === 'number') {
    if (!valid(accountThreshold)) return '';
    ownDefault = accountThreshold;
    if (accountThreshold !== fleetFor('default')) parts.push('at ' + pct(accountThreshold));
  } else if (accountThreshold && typeof accountThreshold === 'object' && !Array.isArray(accountThreshold)) {
    table = accountThreshold;
    ownDefault = table.default;
    Object.keys(table).forEach(function (key) {
      var v = table[key];
      if (!valid(v)) return;
      if (key !== 'default' && THRESHOLD_BUCKET_KEYS.indexOf(key) === -1) return;
      if (v !== fleetFor(key)) parts.push((key === 'default' ? 'at' : (THRESHOLD_BUCKET_LABELS[key] || key)) + ' ' + pct(v));
    });
  }
  // As switchThresholdDiffs in model.js: the account's own default outranks a
  // bucket entry in the FLEET table, so a default equal to the fleet's can
  // still move a bucket the fleet names (fleet 7d at 85%, account 0.98 puts
  // that account's 7d at 98%). When the defaults differ, "at N%" already
  // covers every bucket the account does not list.
  if (valid(ownDefault) && ownDefault === fleetFor('default')) {
    THRESHOLD_BUCKET_KEYS.forEach(function (key) {
      if (valid(table[key])) return;
      if (ownDefault !== fleetFor(key)) parts.push(THRESHOLD_BUCKET_LABELS[key] + ' ' + pct(ownDefault));
    });
  }
  return parts.length ? 'switch ' + parts.join(', ') : '';
}

/**
 * `now` keeps the fourth slot master's reset-credit callers already use; the
 * fleet threshold pair (#409) follows it.
 * @param {Record<string, any>|null|undefined} account
 * @param {string|null} [current]
 * @param {Record<string, string>|null} [currentAccounts]
 * @param {number|null} [now]  ms epoch a reset-credit reading's age is measured from
 * @param {number|null|undefined} [fleetThreshold]
 * @param {Object<string, number>|null|undefined} [fleetThresholds]
 */
export function accountBadges(account, current, currentAccounts, now, fleetThreshold, fleetThresholds) {
  var a = account || {};
  var isCurrent = currentAccounts
    ? currentAccounts[a.provider] === a.name
    : a.name === current;
  var status = a.disabled ? 'disabled' : (a.status || 'unknown');
  var recent = Number.isFinite(a.sessions) ? a.sessions : 0;
  var known = Number.isFinite(a.knownSessions) ? a.knownSessions : 0;
  var badges = [
    { cls: 'provider ' + (a.provider || 'unknown'), text: providerLabel(a.provider) },
    { cls: 'meta', text: a.type || 'unknown' },
    { cls: 'meta priority', text: 'prio ' + (a.priority || 0) },
  ];
  if (isCurrent) badges.push({ cls: 'current', text: 'current' });
  badges.push({ cls: status, text: status });
  if (recent) badges.push({ cls: 'sessions', text: recent + ' recent' });
  if (known > recent) badges.push({ cls: 'sessions known', text: known + ' known' });
  // Free Codex rate-limit reset credits this account holds — what it could
  // spend to undo an exhausted window rather than wait one out. The count is
  // the account's holdings, not what upstream would apply this instant.
  // A reading past RESET_CREDIT_MAX_AGE_MS is dropped, as it is on the status
  // screen and the TUI row: only the usage probe refreshes the count, so an old
  // one may describe a credit that has since been redeemed or has expired.
  var reading = (a.quota || {}).resetCredits || {};
  var credits = reading.available;
  var at = now == null ? Date.now() : now;
  var stale = Number.isFinite(reading.seenAt) && at - reading.seenAt > RESET_CREDIT_MAX_AGE_MS;
  // A Claude banked reset states when it lapses: drop it past then, and say
  // the date while it stands (the claude.ai Resets page names it the same way).
  var expired = Number.isFinite(reading.expiresAt) && reading.expiresAt <= at;
  if (Number.isFinite(credits) && credits > 0 && !stale && !expired) {
    var expires = Number.isFinite(reading.expiresAt)
      ? ' \u00b7 expires ' + new Date(reading.expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    badges.push({ cls: 'meta resets', text: credits + ' reset credit' + (credits === 1 ? '' : 's') + expires });
  }
  // Arguments 5/6 are optional (the pre-#409 unit test above omits them): with
  // no account switchThreshold at all — the common case — thresholdBadgeText
  // returns '' regardless of what the fleet args are, so an old caller sees no
  // new badge. A caller that DOES set switchThreshold on the account is
  // expected to pass the fleet's own value too, the way `render()` does below,
  // or the comparison falls back to thresholdBadgeText's own 0.98 default.
  var thresholdText = thresholdBadgeText(a.switchThreshold, fleetThreshold, fleetThresholds);
  if (thresholdText) badges.push({ cls: 'meta threshold', text: thresholdText });
  // Extra-usage fallback: one badge, the louder state winning. Strict `true`
  // so a missing field on an older server's payload shows nothing.
  if (a.onExtraUsage === true) badges.push({ cls: 'extra-usage billing', text: 'on extra usage \u2014 billing' });
  else if (a.allowExtraUsage === true) badges.push({ cls: 'extra-usage', text: 'extra usage allowed' });
  // The account's own egress proxy, as the status payload carries it: already
  // password-masked (describeRouting), and absent for an account on the fleet
  // path, which is the default and earns no badge.
  if (typeof a.routing === 'string' && a.routing) badges.push({ cls: 'meta routing', text: 'via ' + a.routing });
  return badges;
}

// One row per CONVERSATION, from `sessions.items` (proxy.sessionDetail). A
// Claude Code session that fans out to nine subagents is nine rows, because a
// conversation is what holds a pin and a prompt cache.
//
// `id` is the pin key those rows are keyed by — a session id narrowed to one
// conversation — which is an identity for routing, not one to read: a composite
// nobody recognises, and identical between siblings but for its tail. So the
// visible identity is split in two, the session an operator knows and the
// conversation that tells its siblings apart. A record labelled by no request
// (touch() alone) has no session name, and falls back to the key it is under.
//
// The token columns are #192's numbers — what each response actually reported,
// cache included — summed across the weekly buckets the conversation touched.
// `pins` is a bucket→account map rather than one index, because a conversation
// spending two model families is served by two accounts at the same time.
export function sessionRows(sessions) {
  var items = (sessions && sessions.items) || [];
  return items.map(function (s) {
    var buckets = s.tokens || {};
    var row = {
      id: s.id,
      session: s.session || s.id || '',
      // Enough of the digest to separate one session's live conversations; the
      // whole of it is a column read to the end by nobody.
      conversation: String(s.conversation || '').slice(0, 8),
      client: s.client || '',
      project: (s.dimensions || {}).project || '',
      active: !!s.active,
      requests: s.requests || 0,
      starved: s.starved || 0,
      cacheRead: 0, cacheCreation: 0, input: 0, output: 0, context: 0,
      accounts: Object.keys(s.pins || {}).map(function (b) { return s.pins[b]; }).join(', '),
      lastSeen: s.lastSeen || 0,
    };
    Object.keys(buckets).forEach(function (b) {
      var t = buckets[b] || {};
      row.cacheRead += t.cacheRead || 0;
      row.cacheCreation += t.cacheCreation || 0;
      row.input += t.input || 0;
      row.output += t.output || 0;
      row.context += t.context || 0;
    });
    row.total = row.cacheRead + row.cacheCreation + row.input + row.output;
    return row;
  });
}

export function filterSessionRows(rows, filters) {
  var f = filters || {};
  return (rows || []).filter(function (r) {
    if (f.project && r.project !== f.project) return false;
    if (f.client && r.client !== f.client) return false;
    return true;
  });
}

// Text sorts alphabetically, numbers numerically. A missing value sorts as
// empty/zero rather than dropping the row.
export function sortRows(rows, key, dir) {
  var sign = dir === 'asc' ? 1 : -1;
  return (rows || []).slice().sort(function (a, b) {
    var x = a[key], y = b[key];
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
    }
    return sign * ((x || 0) - (y || 0));
  });
}

export function uniqSorted(values) {
  var seen = Object.create(null);
  (values || []).forEach(function (v) { if (v) seen[v] = true; });
  return Object.keys(seen).sort();
}

// The request the switch button sends: POST /teamclaude/switch with the same
// key the status poll uses. Pure, so the test suite can send exactly this
// through a real proxy and prove the same-origin CSRF gate lets the page in.
export function switchRequest(name, key) {
  return {
    url: '/teamclaude/switch',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ account: name }),
    },
  };
}

// The request the threshold control sends. The number goes as typed: what
// counts as a percentage is the server's rule (1–100, kept to tenths), and a
// second opinion here would only disagree with it on the edges.
/**
 * @param {number|string} percent
 * @param {string|null|undefined} key
 */
export function thresholdRequest(percent, key) {
  return {
    url: '/teamclaude/threshold',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ percent: percent }),
    },
  };
}

// The stored 0–1 ratio as the number the control shows. Tenths, and no trailing
// zero: the setting is quantised to tenths of a percent, so 0.98 must read back
// as "98" rather than "98.0" for a re-save to be a no-op the operator can see.
/** @param {unknown} value */
export function thresholdPercentText(value) {
  /** @type {any} */ var ratio = value;
  // A per-bucket table: the control sets one number for every bucket, so what it
  // shows is the default the table falls back to.
  if (ratio && typeof ratio === 'object' && !Array.isArray(ratio)) ratio = ratio.default;
  if (typeof ratio !== 'number' || !isFinite(ratio)) return '';
  return String(Math.round(ratio * 1000) / 10);
}

// What to tell the operator after a threshold change. `dropped` is the part a
// bare "saved" would hide: one number replaces a per-bucket table rather than
// hiding one behind it, and the operator who set those buckets should hear it.
/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function thresholdOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'threshold change failed' + (res && res.error ? ': ' + res.error : '') };
  var pct = thresholdPercentText(res.switchThreshold);
  var dropped = res.dropped || [];
  if (dropped.length) return { kind: 'warn', text: 'switch threshold set to ' + pct + '% — dropped the per-bucket thresholds (' + dropped.join(', ') + ')' };
  return { kind: 'ok', text: 'switch threshold set to ' + pct + '%' };
}

// The Quota refresh picker's choices: off, or 5 to 120 seconds. An interval set
// elsewhere (CLI, TUI, a hand edit) that is not on the list is added as its own
// choice, so the picker always shows what the proxy is really doing instead of
// snapping to a neighbour and inviting a save that changes the setting.
/** @param {unknown} current  status.probe.intervalSeconds */
export function probeIntervalOptions(current) {
  var choices = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  var cur = typeof current === 'number' && isFinite(current) && current >= 0 ? Math.round(current) : 0;
  if (choices.indexOf(cur) < 0) choices.push(cur);
  choices.sort(function (a, b) { return a - b; });
  return choices.map(function (v) { return { value: v, label: v ? 'every ' + v + 's' : 'off' }; });
}

/**
 * @param {number} seconds  0 turns the probe off
 * @param {string|null|undefined} key
 */
export function probeIntervalRequest(seconds, key) {
  return {
    url: '/teamclaude/probe-interval',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ seconds: seconds }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function probeIntervalOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'quota refresh change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.quotaProbeSeconds > 0 ? 'quota refreshes every ' + res.quotaProbeSeconds + 's' : 'quota refresh turned off' };
}

/**
 * @param {string} name  '' goes back to the host name
 * @param {string|null|undefined} key
 */
export function instanceNameRequest(name, key) {
  return {
    url: '/teamclaude/instance-name',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    },
  };
}

/**
 * @param {any} res
 * @returns {{ kind: string, text: string }}
 */
export function instanceNameOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'instance name change failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: res.custom ? 'this instance is now called ' + res.name : 'instance name cleared; it goes by its host name, ' + res.name };
}

// What the Instance picker calls the machine the page was opened on: its
// name, or "This machine" from a proxy too old to say.
/** @param {any} self  { name } from /teamclaude/peers, or status.instance */
export function selfInstanceLabel(self) {
  return self && typeof self.name === 'string' && self.name ? self.name : 'This machine';
}

// What to tell the operator afterwards. The endpoint answers `ok` for the choice
// being recorded and `eligible` for whether traffic will actually follow it —
// two different things, and a bare "done" would be a lie for a spent target.
/**
 * POST for an account control. `spec` is {place}/{priority} for a priority
 * move, or {disabled} to take an account out of rotation or put it back.
 *
 * @param {any} name
 * @param {{ place?: string, priority?: number, disabled?: boolean }} spec
 * @param {string|null} key
 */
export function accountControlRequest(name, spec, key) {
  var isPriority = spec.disabled === undefined;
  /** @type {{ account: any, place?: any, priority?: any, disabled?: any }} */
  var body = { account: name };
  if (isPriority) {
    if (spec.place) body.place = spec.place;
    else body.priority = spec.priority;
  } else {
    body.disabled = spec.disabled;
  }
  return {
    url: isPriority ? '/teamclaude/priority' : '/teamclaude/disable',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * What to tell the operator afterwards. A priority move reports the number it
 * landed on, which is the part the caller did not choose when it asked for
 * 'first' or 'last'.
 *
 * @param {any} res
 * @param {{ place?: string, priority?: number, disabled?: boolean }} spec
 */
export function accountControlOutcome(res, spec) {
  if (!res || !res.ok) return { kind: 'error', text: 'change failed' + (res && res.error ? ': ' + res.error : '') };
  if (spec.disabled !== undefined) {
    return { kind: 'ok', text: (res.disabled ? 'disabled ' : 'enabled ') + res.name };
  }
  return { kind: 'ok', text: res.name + ' priority ' + res.priority };
}

/**
 * The colour family a provider group is drawn in, so a Claude login and a
 * ChatGPT (Codex) login never look alike: the class on its badge, its tab and
 * its section.
 *
 * @param {string} group  accountGroup()
 */
export function providerTone(group) {
  if (group === 'anthropic') return 'claude';
  if (group === 'codex') return 'codex';
  return 'backend';
}

/**
 * The provider a "Sign in again" button would sign in, or null when there is
 * nothing to sign in: only an OAuth login the upstream has signed out
 * (status `error`) needs one. A key is replaced, not signed in.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {'claude'|'codex'|null}
 */
export function needsSignIn(account) {
  var a = account || {};
  if (a.type !== 'oauth' || a.status !== 'error' || a.backend) return null;
  // Its tokens come from a file (importFrom) on every reload, so a sign-in
  // here would be stored and never used: fileSignInHint says where to go.
  if (a.credentialsFromFile) return null;
  return a.provider === 'codex' ? 'codex' : 'claude';
}

/**
 * What to do instead, for a signed-out account whose tokens are read from a
 * credentials file (importFrom): sign in with the tool that owns the file,
 * then reload. Null for every other account.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {string|null}
 */
export function fileSignInHint(account) {
  var a = account || {};
  if (a.type !== 'oauth' || a.status !== 'error' || !a.credentialsFromFile) return null;
  var tool = a.provider === 'codex' ? 'the Codex CLI (codex login)' : 'Claude Code (claude /login)';
  return 'Its sign-in is read from a credentials file. Sign in again in ' + tool + ', then Reload config on the Settings page.';
}

/**
 * Whether the page itself was opened on the proxy's machine. Only then can the
 * browser reach a loopback listener there and finish a sign-in by itself.
 *
 * @param {string} hostname  location.hostname
 */
export function isLoopbackHost(hostname) {
  var h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/**
 * POST for one step of a dashboard sign-in: 'start' {provider}, 'code'
 * {id, code}, 'status' {id} or 'cancel' {id}.
 *
 * @param {string} step
 * @param {Record<string, any>} body
 * @param {string|null} key
 */
export function signInRequest(step, body, key) {
  return {
    url: '/teamclaude/login/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * What the sign-in panel offers for a started sign-in: the link to open, and
 * what to do once the provider is done with the browser.
 *
 * Claude hands back two links. The loopback one finishes by itself, but only
 * for a browser on the proxy's machine; the code-page one works from anywhere
 * and ends on a page showing a code to paste. Codex has one link whose
 * redirect names localhost:1455: it finishes by itself on the proxy's machine,
 * and anywhere else lands on an address that does not load, which is the
 * thing to paste.
 *
 * @param {any} start  the reply to 'start'
 * @param {string} hostname  location.hostname
 * @returns {{ href: string, auto: boolean, ask: string, note: string|null }}
 */
export function signInPlan(start, hostname) {
  var s = start || {};
  var local = isLoopbackHost(hostname);
  if (s.provider === 'codex') {
    var auto = local && !!s.listening;
    return {
      href: s.url,
      auto: auto,
      ask: auto
        ? 'Approve the sign-in in the new tab and this finishes by itself. If the tab ends on a page that does not load, copy its whole address and paste it here.'
        : 'Approve the sign-in in the new tab. It then goes to a localhost:1455 address that does not load: copy that whole address from the address bar and paste it here.',
      note: s.note || null,
    };
  }
  var loop = local && !!s.browserUrl;
  return {
    href: loop ? s.browserUrl : s.url,
    auto: loop,
    ask: loop
      ? 'Approve the sign-in in the new tab and this finishes by itself.'
      : 'Approve the sign-in in the new tab. The page then shows a code: copy it and paste it here.',
    note: s.note || null,
  };
}

/**
 * Where a polled sign-in stands, as the panel says it. `done` closes the
 * panel's wait: success, failure, a cancel, or a sign-in the server no longer
 * knows (it was replaced, or the server restarted).
 *
 * @param {any} res  the reply to 'status'
 * @param {string} label  the provider as the page names it
 * @returns {{ done: boolean, kind: string, text: string }}
 */
export function signInStatusOutcome(res, label) {
  var r = res || {};
  if (r.ok !== true) return { done: true, kind: 'error', text: label + ' sign-in failed' + (r.error ? ': ' + r.error : '') };
  if (r.state === 'succeeded' && r.fileBacked) {
    return {
      done: true, kind: 'warn',
      text: 'Signed in' + (r.account ? ' as ' + r.account : '') + ', but that account reads its sign-in from a credentials file, which TeamClaude keeps using. Sign in again in '
        + (label === 'Codex' ? 'the Codex CLI' : 'Claude Code') + ', then Reload config.',
    };
  }
  if (r.state === 'succeeded') {
    var who = r.account ? ' as ' + r.account : '';
    return { done: true, kind: 'ok', text: (r.action === 'updated' ? 'Signed in to ' + label + ' again' : 'Added the ' + label + ' account') + who };
  }
  if (r.state === 'failed') return { done: true, kind: 'error', text: label + ' sign-in failed' + (r.error ? ': ' + r.error : '') };
  if (r.state === 'cancelled') return { done: true, kind: 'warn', text: label + ' sign-in cancelled' };
  if (r.state === 'unknown') return { done: true, kind: 'warn', text: label + ' sign-in is no longer running; start it again' };
  if (r.state === 'finishing') return { done: false, kind: '', text: 'Code accepted, finishing the sign-in…' };
  return { done: false, kind: '', text: 'Waiting for you to sign in…' };
}

/**
 * POST to remove one account. The provider and org go with the name, so the
 * button removes the account it sits on and not a namesake.
 *
 * @param {any} account  one entry of status.accounts
 * @param {string|null} key
 */
export function removeRequest(account, key) {
  /** @type {{ account: any, provider?: any, org?: any }} */
  var body = { account: account.name };
  if (account.provider) body.provider = account.provider;
  if (account.orgName) body.org = account.orgName;
  return {
    url: '/teamclaude/remove',
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/** @param {any} res */
export function removeOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'remove failed' + (res && res.error ? ': ' + res.error : '') };
  return { kind: 'ok', text: 'Removed ' + res.name + '. TeamClaude no longer holds its sign-in; you stay signed in everywhere else.' };
}

// The start of a failed client-key step's message. A page constant too: see SHARED_CONSTS.
const CLIENT_KEY_FAILED = { create: 'could not create the key', revoke: 'could not revoke the key', show: 'could not read the key' };

/**
 * POST to create, revoke or show a client key (proxy.clientKeys) by name.
 *
 * @param {'create'|'revoke'|'show'} step
 * @param {string} name
 * @param {string|null} key  the proxy key the page holds, not the client key
 */
export function clientKeyRequest(step, name, key) {
  return {
    url: '/teamclaude/client-keys/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify({ name: name }),
    },
  };
}

/**
 * What to tell the operator after a create or revoke. A first key closes a gate
 * that admitted everybody until now, which is worth saying at the moment it
 * happens rather than when a client elsewhere starts getting 401s.
 *
 * @param {any} res
 * @param {'create'|'revoke'|'show'} step
 */
export function clientKeyOutcome(res, step) {
  if (!res || !res.ok) {
    return { kind: 'error', text: CLIENT_KEY_FAILED[step] + (res && res.error ? ': ' + res.error : '') };
  }
  // The panel that opens is the answer to a show; a line above it would repeat it.
  if (step === 'show') return { kind: 'ok', text: '' };
  if (step === 'revoke') return { kind: 'ok', text: 'Revoked ' + res.name + '. Its usage so far stays in the table.' };
  if (res.firstKey) return { kind: 'warn', text: 'Created ' + res.name + '. It is the proxy\'s first key, so callers on other machines now need a key too.' };
  return { kind: 'ok', text: 'Created ' + res.name + '.' };
}

/**
 * What to paste into a client to use a new key: Claude Code's environment and
 * the Codex CLI's provider block. `origin` is the address this page was opened
 * at, which is the proxy as this browser reaches it.
 *
 * @param {string} origin
 * @param {string} key
 */
export function clientKeySetup(origin, key) {
  // Show details hands back keys written into the file by hand, which may hold
  // `$`, quotes or spaces: single-quote those for the shell, and let JSON's
  // escapes (a subset of TOML's basic-string escapes) quote them for Codex.
  var sh = function (/** @type {string} */ v) { return /^[A-Za-z0-9._\/:@%+=,-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'"; };
  return {
    claude: 'export ANTHROPIC_BASE_URL=' + sh(origin) + '\nexport ANTHROPIC_API_KEY=' + sh(key),
    codex: 'model_provider = "teamclaude"\n\n[model_providers.teamclaude]\nname = "teamclaude"\nbase_url = ' + JSON.stringify(origin + '/backend-api/codex') + '\n'
      + 'wire_api = "responses"\nhttp_headers = { "x-api-key" = ' + JSON.stringify(key) + ' }',
  };
}

/**
 * Whether a status read made with the new key came back as that client. A
 * loopback browser is admitted without a key, so a 200 alone proves nothing:
 * the caller the server reports has to be the key's name.
 *
 * @param {number} httpStatus
 * @param {any} body  the parsed /teamclaude/status reply, or null
 * @param {string} name
 */
export function clientKeyCheckOutcome(httpStatus, body, name) {
  if (httpStatus === 401) return { kind: 'error', text: 'The proxy refused the key.' };
  var caller = body && body.caller;
  if (httpStatus === 200 && caller && caller.kind === 'client' && caller.client === name) {
    return { kind: 'ok', text: 'The key works: the proxy counts its requests under ' + name + '.' };
  }
  return { kind: 'error', text: 'The proxy did not recognise the key as ' + name + (httpStatus === 200 ? '.' : ' (status ' + httpStatus + ').') };
}

// The start of a failed linked-instance step's message. A page constant too: see SHARED_CONSTS.
const PEER_LINK_FAILED = { test: 'could not test the link', add: 'could not link the instance', remove: 'could not remove the link', key: 'could not read the key' };

/**
 * POST one step of the Linked instances card: `test` {url, apiKey}, `add`
 * {name, url, apiKey, linkBack?}, `remove` {name} or `key` {}.
 *
 * @param {'test'|'add'|'remove'|'key'} step
 * @param {Record<string, any>} body
 * @param {string|null} key  the proxy key the page holds
 */
export function peerLinkRequest(step, body, key) {
  return {
    url: '/teamclaude/peer-links/' + step,
    init: {
      method: 'POST',
      headers: { 'x-api-key': key || '', 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    },
  };
}

/**
 * What to tell the operator after an add or a remove. An add that linked one
 * way only says so: the other machine's dashboard will not show this one yet.
 * One that linked both ways also names the instances each side already
 * listed that were linked across too (`mesh`), and the ones that were not.
 *
 * @param {any} res
 * @param {'add'|'remove'} step
 */
export function peerLinkOutcome(res, step) {
  if (!res || !res.ok) return { kind: 'error', text: PEER_LINK_FAILED[step] + (res && res.error ? ': ' + res.error : '') };
  if (step === 'remove') return { kind: 'ok', text: 'Removed ' + res.name + '. If it lists this machine too, remove that link from its own dashboard.' };
  var back = res.linkBack;
  if (back && back.ok) {
    var text = 'Linked ' + res.name + ' both ways: each dashboard now shows the other in the Instance picker.';
    var mesh = res.mesh;
    if (!mesh) return { kind: 'ok', text: text };
    // A pair is linked one direction at a time; both directions read as one.
    /** @type {string[]} */
    var also = [];
    (Array.isArray(mesh.linked) ? mesh.linked : []).forEach(function (/** @type {any} */ l) {
      var i = also.indexOf(l.to + ' → ' + l.from);
      if (i >= 0) also[i] = l.to + ' ↔ ' + l.from;
      else also.push(l.from + ' → ' + l.to);
    });
    var missed = (Array.isArray(mesh.skipped) ? mesh.skipped : []).map(function (/** @type {any} */ l) { return l.error; });
    if (also.length) text += ' Also linked the instances they already listed: ' + also.join(', ') + '.';
    if (missed.length) text += ' Not linked: ' + missed.join('; ') + '.';
    return { kind: missed.length ? 'warn' : 'ok', text: text };
  }
  if (back) return { kind: 'warn', text: 'Linked ' + res.name + ', but it did not link back: ' + back.error + '.' };
  return { kind: 'ok', text: 'Linked ' + res.name + '. Pick it in the Instance picker to see it.' };
}

/**
 * What a test of an address and key found (peers.js testPeerLink).
 *
 * @param {any} res
 */
export function peerTestOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: PEER_LINK_FAILED.test + (res && res.error ? ': ' + res.error : '') };
  if (res.state === 'refused' && res.clientKey) return { kind: 'error', text: 'That is one of its client keys, which cannot manage it. Linking needs its proxy key: on its dashboard, Settings, Linked instances, Show key.' };
  if (res.state === 'refused') return { kind: 'error', text: 'It refused that key. Copy the key again from its dashboard: Settings, Linked instances, Show key.' };
  if (res.state !== 'online') return { kind: 'error', text: 'Nothing answered at ' + res.url + '. Check the address, and that it listens beyond its own machine (proxy.host).' };
  if (!res.linkable) return { kind: 'warn', text: 'It answers to that key, but it runs a version that cannot link back from here. Update it, or link this machine from its own dashboard.' };
  return { kind: 'ok', text: 'It answers to that key' + (res.name ? ' and calls itself ' + res.name : '') + '.' };
}

// The scheme of an instance link. The old spelling is read too (issue #72).
const INSTANCE_LINK_SCHEMES = ['teamrouter:', 'teamclaude:'];

/**
 * One line to copy from a machine's dashboard to another's, carrying the
 * address the other machine reaches it at and its proxy key, so the form there
 * fills in both from one paste. It carries no name: the machine it is pasted
 * into is where the link is named. The key is in it, so the link is as secret
 * as the key.
 *
 * @param {string} address  e.g. http://100.64.0.2:3456
 * @param {string} key  the proxy key
 * @returns {string}  '' when either is missing
 */
export function instanceLink(address, key) {
  if (!address || !key) return '';
  return 'teamrouter://link?address=' + encodeURIComponent(address) + '&key=' + encodeURIComponent(key);
}

/**
 * Read a link made by instanceLink. Anything else, including a link whose
 * address is not an http(s) URL, is null.
 *
 * @param {string} text
 * @returns {{ url: string, apiKey: string } | null}
 */
export function parseInstanceLink(text) {
  var u;
  try { u = new URL(String(text || '').trim()); } catch { return null; }
  if (INSTANCE_LINK_SCHEMES.indexOf(u.protocol) < 0 || u.hostname !== 'link') return null;
  var address = (u.searchParams.get('address') || '').trim();
  var key = (u.searchParams.get('key') || '').trim();
  if (!address || !key) return null;
  try {
    var a = new URL(address);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return null;
  } catch { return null; }
  return { url: address, apiKey: key };
}

/**
 * What stops the Link button, or null when nothing does. A missing name has a
 * message of its own: it is the field a pasted link leaves empty, and the
 * address and key the form already holds stay where they are.
 *
 * @param {{ name: string, url: string, apiKey: string }} body
 * @returns {string | null}
 */
export function linkAddMissing(body) {
  if (!body.url || !body.apiKey) return 'Fill in its address and its proxy key, or paste its link.';
  if (!body.name) return 'You need to name this machine: enter a name under Name it, then click Link again.';
  return null;
}

/**
 * The addresses to offer for "this machine, as the other one reaches it",
 * best first: the address this page was opened at, when that is not this
 * machine's loopback and the page shows this machine, then what the server
 * found on its own interfaces.
 *
 * @param {any} self  the `self` of GET /teamclaude/peer-links
 * @param {string} origin  location.origin, or '' when the page shows a linked instance
 */
export function linkSelfOptions(self, origin) {
  /** @type {string[]} */
  var out = [];
  var host = '';
  try { host = origin ? new URL(origin).hostname : ''; } catch { host = ''; }
  if (host && !isLoopbackHost(host)) out.push(origin);
  (self && Array.isArray(self.addresses) ? self.addresses : []).forEach(function (/** @type {string} */ a) { if (out.indexOf(a) < 0) out.push(a); });
  return out;
}

/**
 * What stands in the way of linking the instance shown back from the other
 * machine, or null when nothing does. Without a proxy key nothing can get in,
 * so that one blocks. Listening on loopback only is a warning: a reverse
 * proxy or Tailscale Serve in front of it is still an address the other
 * machine can use, and the page may well have been opened through one.
 *
 * @param {any} self  the `self` of GET /teamclaude/peer-links
 * @returns {{ block: boolean, text: string } | null}
 */
export function linkBackNotice(self) {
  if (!self) return null;
  if (!self.hasKey) return { block: true, text: 'It has no proxy key (proxy.apiKey) for the other machine to use, so it cannot be linked back.' };
  if (!self.offBox) return { block: false, text: 'It listens on its own machine only. Link back works only through something that forwards to it, such as a reverse proxy or Tailscale Serve: enter that address. Otherwise set proxy.host (or TEAMCLAUDE_HOST) to 0.0.0.0 or its Tailscale address.' };
  return null;
}

/**
 * Whether the caller may use the control behind `path`. A status without the
 * `caller` field keeps every control: the server still refuses what it must.
 *
 * @param {any} caller  status.caller
 * @param {string} path
 */
export function callerCan(caller, path) {
  var refused = caller && caller.refused;
  return !Array.isArray(refused) || refused.indexOf(path) < 0;
}

/**
 * The one line that explains the hidden controls, or null when nothing is
 * hidden. Said once at the top instead of on every card.
 *
 * @param {any} caller  status.caller
 */
export function callerNotice(caller) {
  if (!caller || !Array.isArray(caller.refused) || !caller.refused.length) return null;
  return 'Signed in with the client key "' + caller.client + '". Changes to accounts and settings need the proxy key (proxy.apiKey), or the page opened without a key on the proxy\'s own machine, so those controls are hidden.';
}

/**
 * Which card a note belongs to. One email can hold accounts in several orgs,
 * and providers may reuse a name, so the name alone can match two cards.
 *
 * @param {any} account  one entry of status.accounts
 */
export function cardNoteKey(account) {
  return [account.name, account.orgName || '', account.provider || ''].join('\n');
}

/**
 * The email line under an account's name, or null for none. An account named
 * after its email already shows it; a renamed one ("work", "account-1") would
 * otherwise hide whose login it is.
 *
 * @param {any} account  one entry of status.accounts
 * @returns {string|null}
 */
export function accountEmailLine(account) {
  var email = account && account.email;
  if (typeof email !== 'string' || !email) return null;
  return email === account.name ? null : email;
}

/**
 * The result of the last action on one account card, while it is recent
 * enough to show. Kept outside the card, which the poll rebuilds every few
 * seconds.
 *
 * @param {any} notes  { [cardNoteKey]: { kind, text, at } }
 * @param {string} key  cardNoteKey of the card
 * @param {number} now
 */
export function cardNoteFor(notes, key, now) {
  var n = notes && Object.prototype.hasOwnProperty.call(notes, key) ? notes[key] : null;
  if (!n || now - n.at > CARD_NOTE_MAX_AGE_MS) return null;
  return n;
}

export function switchOutcome(res) {
  if (!res || !res.ok) return { kind: 'error', text: 'switch failed' + (res && res.error ? ': ' + res.error : '') };
  if (res.eligible === false) return { kind: 'warn', text: 'switched to ' + res.account + ', but rotation will not use it' + (res.reason ? ': ' + res.reason : '') };
  return { kind: 'ok', text: 'switched to ' + res.account };
}

// One row per route the server reports — each model family the fleet meters
// separately, autocreated or configured — plus a trailing row for everything
// else, which goes to the current account. `target` is the server's own answer
// to "where does a request for this family land right now", so the page does
// not re-derive routing from quota bars; the eligible split says why a family
// is where it is.
export function routeRows(status) {
  var s = status || {};
  var blockedModels = s.blockedModels || [];
  var rows = (s.routes || []).map(function (r) {
    var accounts = r.accounts || [];
    var name = r.name || '';
    var match = r.match || [];
    var target = r.target || null;
    var pinned = r.pinned || null;
    return {
      kind: 'route',
      name: name,
      provider: r.provider || 'anthropic',
      label: name.charAt(0).toUpperCase() + name.slice(1),
      match: match.join(', '),
      target: target,
      pinned: pinned,
      // A pin the server is not honouring (its account cannot serve the
      // family right now): routing went elsewhere, and the row must say so
      // rather than let "pinned" read as "this is the pin".
      pinMismatch: !!pinned && pinned !== target,
      // The blocklist answers 400 before selection, so a route whose every
      // glob is blocked has a target no request will reach. A literal glob
      // comparison covers the common case; the server's overlap logic is not
      // shipped to the page.
      blocked: match.length > 0 && match.every(function (g) { return blockedModels.indexOf(g) !== -1; }),
      autocreated: !!r.autocreated,
      eligible: accounts.filter(function (a) { return a.eligible; }).map(function (a) { return a.name; }),
      ineligible: accounts.filter(function (a) { return !a.eligible; }).map(function (a) { return a.name; }),
    };
  });
  if (rows.length) {
    // The server reports one default per provider. A mixed Claude/Codex fleet
    // has two independent cursors, so collapsing these into one global row is
    // the exact ambiguity this table exists to remove. Older servers retain
    // the original single-row fallback.
    var defaults = s.defaultTargets || null;
    var providers = defaults ? Object.keys(defaults).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    if (!providers.length) providers = [rows[0].provider || 'anthropic'];
    providers.forEach(function (provider) {
      var current = (s.currentAccounts && s.currentAccounts[provider]) || s.currentAccount || null;
      var cur = (s.accounts || []).filter(function (a) { return a.name === current; })[0];
      rows.push({
        kind: 'default', name: '',
        label: defaults ? providerLabel(provider) + ' default' : 'Everything else',
        provider: provider, match: '',
        target: defaults ? defaults[provider] : (s.defaultTarget || current), current: current,
        currentUnavailable: (cur && cur.unavailable) || null,
        pinned: null, pinMismatch: false, blocked: false, autocreated: false, eligible: [], ineligible: [],
      });
    });
  }
  return rows;
}

// Consecutive client requests that ended with nothing usable. Claude Code has
// its own retry loop, so two or three in a row are ordinary during a seconds-long
// upstream wobble; five with no success in between is past any blip and past the
// client's own budget. No age floor is needed — unlike a token-based guess, a
// streak of five is true of no healthy session at any age, so a floor would only
// delay a true positive.
export var STARVED_MIN = 5;
// The failure that makes this fire is usually fleet-wide, so every active
// conversation starves at once — and one fan-out is a dozen of them under one
// session's name. Naming all of them would bury the dashboard at the moment it
// matters most; the count carries the scale, three names carry enough to go and
// ask someone.
export var STARVED_LIST_MAX = 3;

/**
 * What is wrong right now, worst first, or an empty list. Only states that are
 * actionable and not ordinary operation: a spent weekly bucket, a rate-limit
 * back-off and an upstream refusal are rotation and back-off working, and
 * saying so every day would teach the reader to ignore the banner on the day it
 * matters.
 */
export function problems(status) {
  var s = status || {};
  var out = [];

  // Named when proxy.sessionDetail is on; otherwise the aggregate still says
  // that something is starving, which is the half that must not be opt-in.
  // When nothing can serve, every session starves and "it is failing" sends the
  // operator hunting for a broken token. Say which, if the fleet agrees on why.
  var accounts = s.accounts || [];
  var stalled = accounts.filter(function (a) { return a.unavailable === 'quota' || a.unavailable === 'throttled'; });
  var reasons = {};
  stalled.forEach(function (a) { reasons[a.unavailable] = true; });
  var why = accounts.length && stalled.length === accounts.length
    ? ' — every account is ' + (reasons.quota && reasons.throttled ? 'over its quota threshold or in a rate-limit hold'
      : reasons.quota ? 'over its quota threshold' : 'in a rate-limit hold') + '.'
    : ' — it is failing, not idle.';

  var sessions = s.sessions || {};
  var named = (sessions.items ? sessionRows(sessions) : []).filter(function (r) {
    return r.active && r.starved >= STARVED_MIN;
  }).sort(function (a, b) { return b.starved - a.starved; });
  named.slice(0, STARVED_LIST_MAX).forEach(function (r) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // The session first, since that is the name an operator can go and find,
      // and the conversation after it, because a streak belongs to one agent of
      // a fan-out: without it three lines of one session read as the same line
      // three times. Omitted when the record carries no conversation.
      text: (r.client ? r.client + "'s session " : 'Session ') + r.session.slice(0, 8)
        + (r.conversation ? ', conversation ' + r.conversation + ',' : '')
        + ' has had ' + r.starved + ' requests in a row come back with nothing'
        + (r.project ? ' (' + r.project + ')' : '') + why,
    });
  });
  if (named.length > STARVED_LIST_MAX) {
    out.push({
      severity: 'bad', kind: 'starved-more',
      text: 'and ' + (named.length - STARVED_LIST_MAX) + ' more conversations are getting nothing back.',
    });
  }
  if (!named.length && (sessions.starvedMax || 0) >= STARVED_MIN) {
    out.push({
      severity: 'bad', kind: 'starved-session',
      // A conversation, not a session: the streak is counted per conversation,
      // and a session whose other agents are answering fine is not starving.
      text: 'A conversation has had ' + sessions.starvedMax + ' requests in a row come back with nothing.'
        + ' Turn on proxy.sessionDetail to see which.',
    });
  }

  // Only the two states that do not clear themselves. `entitlement` is a
  // five-minute cooldown and `upstream-rejected` is upstream's way of saying a
  // shared bucket is spent — both expire on their own, like `quota` and
  // `throttled`, and none of them wants a person.
  var ATTENTION = { error: 'needs a re-login', disabled: 'is disabled' };
  (s.accounts || []).forEach(function (a) {
    var why = ATTENTION[a.unavailable];
    if (why) out.push({ severity: 'warn', kind: 'account', text: 'Account ' + a.name + ' ' + why + '.' });
  });

  // Deliberately no spend line. `usedMinor` is month-to-date overage, so on a
  // fleet that has overage switched on it is non-zero for most of the month —
  // an always-lit banner, which is the thing this is trying not to be. The
  // account card and `teamclaude status` both carry it, with the amount.

  return out;
}

// How a quota window reads, as the colour its bar is drawn in. The cut-offs
// are the ones the card bars always used (70% and 90% used); the rows now show
// the remaining side, so under 30% left is amber and under 10% left is red.
/** @param {number|null|undefined} used */
export function meterTone(used) {
  if (used == null || !isFinite(Number(used))) return 'unknown';
  var u = Number(used);
  if (u >= 0.9) return 'bad';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

// One quota column: its label, the fraction used and left (null when the
// window has not reported), when it resets, and its tone.
/** @param {string} label @param {any} utilization @param {any} resetAt */
export function quotaMeter(label, utilization, resetAt) {
  var known = utilization != null && isFinite(Number(utilization));
  var used = known ? Math.max(0, Math.min(1, Number(utilization))) : null;
  return { label: label, used: used, left: used == null ? null : 1 - used, resetAt: resetAt == null ? null : resetAt, tone: meterTone(used) };
}

// An old, spent reading stops hiding an account once its window resets.
/** @param {any} meter @param {number} now */
export function exhaustedMeter(meter, now) {
  return !!meter && meter.left === 0 && (meter.resetAt == null || meter.resetAt > now);
}

// The Fable model the fleet served most recently, as a person names it
// ("Fable 5.1"), for the Fable column's label. Upstream meters the family, not
// the version, so this only names the column: the newest Fable id any account
// lists in usage.recentModels, or plain "Fable" before one has been seen.
/** @param {any[]} accounts */
export function fableLabel(accounts) {
  /** @type {string|null} */
  var best = null;
  var bestAt = -Infinity;
  (accounts || []).forEach(function (a) {
    var seen = (a && a.usage && a.usage.recentModels) || {};
    Object.keys(seen).forEach(function (id) {
      if (id.toLowerCase().indexOf('fable') < 0 || !(seen[id] > bestAt)) return;
      bestAt = seen[id];
      best = id;
    });
  });
  var label = best ? modelLabel(best) : '';
  return /^Fable\b/.test(label) ? label : 'Fable';
}

// The three quota columns of an account row, in the order the operator reads
// them: the Fable weekly bucket, the five-hour window, then the shared weekly.
// A slot is null where the account has no such window — a Codex account has no
// Fable bucket, a plan that states no session window no five-hour row — so the
// columns line up from one row to the next. Any other model-scoped weekly
// bucket (Sonnet) goes to `extra`, behind the row's Show control. An account
// metered some other way fills from the left: a token budget, or a third-party
// backend's own reading (#530), whose text is all there is to say when no bar
// can be drawn.
/** @param {any} account @param {string} [fable] @param {number} [now] */
export function accountMeters(account, fable, now) {
  var a = account || {};
  var q = a.quota || {};
  var at = now == null ? Date.now() : now;
  /** @type {Array<any>} */
  var slots = [null, null, null];
  /** @type {Array<any>} */
  var extra = [];
  /** @type {string|null} */
  var text = null;
  if (q.unified5h != null || q.unified7d != null) {
    if (a.provider !== 'codex') {
      scopedWeeklyRows(q).forEach(function (r) {
        if (r.family === 'fable') slots[0] = quotaMeter('7-day ' + (fable || 'Fable'), r.utilization, r.resetAt);
        else extra.push(quotaMeter('7-day ' + r.label, r.utilization, r.resetAt));
      });
    }
    if (a.provider === 'codex' ? q.unified5h != null : showSessionRow(q)) slots[1] = quotaMeter('5-hour limit', q.unified5h, q.unified5hReset);
    slots[2] = quotaMeter('7-day limit', q.unified7d, q.unified7dReset);
    // Show usable session capacity: a fresh session cannot bypass an empty
    // weekly bucket. Keep upstream's reading intact for routing and persistence.
    var weekly = [slots[0], slots[2]].filter(function (m) { return exhaustedMeter(m, at); });
    if (slots[1] && weekly.length) {
      slots[1] = quotaMeter(slots[1].label, 1, null);
      slots[1].note = 'Weekly limit empty';
    }
  } else if (q.tokensLimit != null && q.tokensRemaining != null) {
    slots[0] = quotaMeter('Tokens', 1 - q.tokensRemaining / q.tokensLimit, q.resetsAt);
  } else if (q.backend && (q.backend.text || q.backend.utilization != null)) {
    var bq = backendQuotaRows(q.backend, now);
    bq.rows.slice(0, 3).forEach(function (r, i) { slots[i] = quotaMeter(r.label, r.utilization, r.resetAt); });
    text = bq.text;
  } else {
    text = 'quota unknown (no traffic observed yet)';
  }
  return { slots: slots, extra: extra, text: text };
}

// Hide only rows with a known empty main window, keeping unknown quota and
// model-specific buckets behind Show from making an account disappear.
/** @param {any} account @param {number} [now] */
export function accountQuotaExhausted(account, now) {
  var at = now == null ? Date.now() : now;
  var meters = accountMeters(account, undefined, at);
  return meters.slots.some(function (m) { return exhaustedMeter(m, at); });
}

// One provider's quota pooled, for its summary card: how much of one column is
// left across the accounts that report it (five accounts at 80% left read
// "400% of 500%"), a segment per account, and the soonest reset among them.
// `slot` is an accountMeters column. A disabled account is left out, since
// nothing will spend it; one with no reading for the column is counted as
// unknown, not guessed at.
/** @param {any[]} accounts @param {number} slot @param {string} [fable] @param {number} [now] */
export function poolSummary(accounts, slot, fable, now) {
  var at = now == null ? Date.now() : now;
  /** @type {{ label: string|null, count: number, left: number, segments: Array<any>, soonest: any, unknown: number }} */
  var out = { label: null, count: 0, left: 0, segments: [], soonest: null, unknown: 0 };
  (accounts || []).forEach(function (a) {
    if (!a || a.disabled) return;
    var m = accountMeters(a, fable, at).slots[slot];
    if (!m) return;
    out.label = out.label || m.label;
    if (m.left == null) { out.unknown++; return; }
    out.count++;
    out.left += m.left;
    out.segments.push({ name: a.name, left: m.left, tone: m.tone });
    var r = typeof m.resetAt === 'number' ? m.resetAt : NaN;
    if (isFinite(r) && r > at && (!out.soonest || r < out.soonest.resetAt)) out.soonest = { name: a.name, resetAt: r };
  });
  return out;
}

// Which tab an account is listed under: Claude, Codex, or one tab per
// third-party backend host (status.accounts[].backend), so a DeepSeek key does
// not sit among the Claude logins it shares a provider with.
/** @param {any} account */
export function accountGroup(account) {
  var a = account || {};
  if (a.backend) return 'backend:' + a.backend;
  return a.provider === 'codex' ? 'codex' : 'anthropic';
}

/** @param {string} group */
export function groupLabel(group) {
  if (group === 'anthropic') return 'Claude';
  if (group === 'codex') return 'Codex';
  var host = String(group || '').replace(/^backend:/, '');
  /** @type {Record<string, string>} */
  var known = {
    'api.deepseek.com': 'DeepSeek', 'api.z.ai': 'z.ai', 'open.bigmodel.cn': 'GLM',
    'api.nano-gpt.com': 'NanoGPT', 'api.kimi.com': 'Kimi', 'api.kimi.ai': 'Kimi',
  };
  return Object.prototype.hasOwnProperty.call(known, host) ? known[host] : (host || 'Backend');
}

// The tab bar over the quota page: All, then Claude, Codex and each backend
// in that order, each with how many accounts it holds.
/** @param {any[]} accounts */
export function providerTabs(accounts) {
  var list = accounts || [];
  /** @type {Record<string, number>} */
  var counts = {};
  list.forEach(function (a) { var g = accountGroup(a); counts[g] = (counts[g] || 0) + 1; });
  /** @param {string} g */
  var rank = function (g) { return g === 'anthropic' ? 0 : g === 'codex' ? 1 : 2; };
  var groups = Object.keys(counts).sort(function (x, y) {
    return rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0);
  });
  return [{ key: 'all', label: 'All', count: list.length }].concat(groups.map(function (g) {
    return { key: g, label: groupLabel(g), count: counts[g] };
  }));
}

// The Logs page's filter chips: one per event kind the proxy records
// (event-log.js EVENT_KINDS), under the names the page shows them by.
export var LOG_KINDS = [
  { key: 'all', label: 'All' }, { key: 'usage', label: 'Usage' }, { key: 'signin', label: 'Sign-in' },
  { key: 'auth', label: 'Auth' }, { key: 'rotation', label: 'Rotation' }, { key: 'control', label: 'Changes' },
];

// Fold one GET /teamclaude/logs reply into what the page holds: the log's
// generation and its entries, oldest first, at most `cap`. A reply from another
// generation means the server restarted with a fresh log. What is held
// describes a process that is gone, and the reply only carries what is newer
// than an id from that process, so the new log's first entries are missing:
// the state empties and `refetch` says to ask again from the start. A server
// that names no generation is read the old way, a lastId behind the newest
// entry held being the same restart.
/** @param {{ generation: string|null, events: any[] }|null} held @param {any} page @param {number} cap */
export function mergeLogEvents(held, page, cap) {
  var h = held || { generation: null, events: [] };
  var have = h.events || [];
  var p = page || {};
  /** @type {any[]} */
  var incoming = Array.isArray(p.events) ? p.events : [];
  var gen = typeof p.generation === 'string' && p.generation ? p.generation : null;
  var newest = have.length ? have[have.length - 1].id : 0;
  if (gen ? (h.generation != null && gen !== h.generation) : (typeof p.lastId === 'number' && p.lastId < newest)) {
    return { generation: gen, events: [], refetch: true };
  }
  var merged = have.concat(incoming.filter(function (e) { return e && typeof e.id === 'number' && e.id > newest; }));
  var max = cap > 0 ? cap : merged.length;
  return { generation: gen || h.generation, events: merged.length > max ? merged.slice(merged.length - max) : merged, refetch: false };
}

/** @param {any[]} events @param {{ kind?: string, provider?: string, account?: string }} filters */
export function filterLogEvents(events, filters) {
  var f = filters || {};
  return (events || []).filter(function (e) {
    if (f.kind && f.kind !== 'all' && e.kind !== f.kind) return false;
    if (f.provider && e.provider !== f.provider) return false;
    if (f.account && e.account !== f.account) return false;
    return true;
  });
}

// The Details column of a log row: what a request carried — model, status,
// tokens, latency — or, for any other event, its reason code.
/** @param {any} event */
export function logEventDetail(event) {
  var e = event || {};
  /** @param {number} n */
  var tok = function (n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); };
  var parts = [];
  if (e.model) parts.push(modelLabel(e.model));
  if (e.status != null) parts.push(String(e.status));
  if (e.inputTokens != null || e.outputTokens != null) parts.push(tok(e.inputTokens || 0) + ' in / ' + tok(e.outputTokens || 0) + ' out');
  if (e.ms != null) parts.push(e.ms >= 1000 ? (e.ms / 1000).toFixed(1) + 's' : e.ms + 'ms');
  if (!parts.length && e.reason) parts.push(e.reason);
  return parts.join(' · ');
}

// The Client column of a log row: the client key that sent a request and the
// program it named itself as (`claude-cli/2.1.3`). Empty for any other event.
/** @param {any} event */
export function logEventClient(event) {
  var e = event || {};
  return [e.client, e.agent].filter(Boolean).join(' · ');
}

// How loudly a log row is drawn: red for what lost an account or a request,
// amber for what will clear on its own, green for a sign-in that worked.
/** @param {any} event */
export function logEventTone(event) {
  var e = event || {};
  if (['signin_failed', 'signed_out', 'credential_rejected', 'exhausted'].indexOf(e.type) >= 0) return 'bad';
  if (['rate_limited', 'signin_timeout', 'hold'].indexOf(e.type) >= 0) return 'warn';
  if (e.type === 'signin_succeeded') return 'ok';
  if (typeof e.status === 'number') return e.status >= 500 ? 'bad' : e.status >= 400 ? 'warn' : '';
  return '';
}

// The usage views the page offers, derived from the windows the tracker
// actually keeps rather than listed again here: a window added or renamed in
// client-usage.js must not leave a button behind that reads zero for everyone.
// `total` is first because it is the lifetime counter the status payload has
// always carried, and the view the page opens on.
export const USAGE_VIEWS = [{ key: 'total', label: 'Total' }].concat(
  Object.keys(USAGE_WINDOWS).map(key => ({ key, label: 'Last ' + key })));

// Which counters one usage row shows. Every usage table reads the selected
// window through this, rather than each renderer reaching into `windows`
// itself — the Clients table and the per-dimension tables carry the same shape
// and must not drift into answering the same question differently.
/** @param {any} entry @param {string} [view] */
export function usageFor(entry, view) {
  var e = entry || {};
  var src = !view || view === 'total' ? e : ((e.windows || {})[view] || {});
  return {
    requests: src.requests || 0,
    connections: src.connections || 0,
    inputTokens: src.inputTokens || 0,
    outputTokens: src.outputTokens || 0,
  };
}

/** How long an action's result stays above its account card. */
export const CARD_NOTE_MAX_AGE_MS = 60 * 1000;

/** What a reset with no readable verdict says. A page constant too: see SHARED_CONSTS. */
export const REDEEM_UNCERTAIN_TEXT = 'no answer to the reset; it may still have gone through. Refresh quota to check before trying again.';

const SHARED_HELPERS = [
  scopedWeeklyRows, accountTokens, modelLabel, recentModelLabels, providerLabel, thresholdBadgeText, accountBadges, sessionRows, filterSessionRows, sortRows, uniqSorted,
  switchRequest, switchOutcome, accountControlRequest, accountControlOutcome, thresholdRequest, thresholdPercentText, thresholdOutcome, routeRows, problems, usageFor,
  probeIntervalOptions, probeIntervalRequest, probeIntervalOutcome, instanceNameRequest, instanceNameOutcome, selfInstanceLabel,
  outsideSpendText, forecastText, showSessionRow, callerCan, callerNotice, cardNoteKey, accountEmailLine, cardNoteFor, backendQuotaRows,
  canRefreshQuota, refreshQuotaRequest, refreshQuotaOutcome,
  codexResetsLeft, codexResetsSummary, canRedeemReset, redeemResetRequest, redeemResetOutcome, resetClickStep,
  meterTone, quotaMeter, exhaustedMeter, fableLabel, accountMeters, accountQuotaExhausted, poolSummary, accountGroup, groupLabel, providerTabs,
  mergeLogEvents, filterLogEvents, logEventDetail, logEventClient, logEventTone,
  providerTone, needsSignIn, fileSignInHint, isLoopbackHost, signInRequest, signInPlan, signInStatusOutcome, removeRequest, removeOutcome,
  clientKeyRequest, clientKeyOutcome, clientKeySetup, clientKeyCheckOutcome,
  peerLinkRequest, peerLinkOutcome, peerTestOutcome, linkSelfOptions, linkBackNotice, instanceLink, parseInstanceLink, linkAddMissing,
].map(fn => fn.toString()).join('\n\n');

// The constants ride along: `problems` closes over the thresholds and
// `accountBadges` over the reset-credit cut-off, so a page without them would
// ReferenceError on first render. The same goes for the two tables
// `thresholdBadgeText` reads. They follow the STARVED pair so the page's
// constants stay in one block ahead of the helpers that use them.
const SHARED_CONSTS = [
  `var STARVED_MIN = ${STARVED_MIN};`,
  `var STARVED_LIST_MAX = ${STARVED_LIST_MAX};`,
  `var RESET_CREDIT_MAX_AGE_MS = ${RESET_CREDIT_MAX_AGE_MS};`,
  `var THRESHOLD_BUCKET_KEYS = ${JSON.stringify(THRESHOLD_BUCKET_KEYS)};`,
  `var THRESHOLD_BUCKET_LABELS = ${JSON.stringify(THRESHOLD_BUCKET_LABELS)};`,
  `var USAGE_VIEWS = ${JSON.stringify(USAGE_VIEWS)};`,
  `var CARD_NOTE_MAX_AGE_MS = ${CARD_NOTE_MAX_AGE_MS};`,
  `var REDEEM_UNCERTAIN_TEXT = ${JSON.stringify(REDEEM_UNCERTAIN_TEXT)};`,
  `var LOG_KINDS = ${JSON.stringify(LOG_KINDS)};`,
  `var LOG_CAP = ${EVENT_LOG_CAPACITY};`,
  `var CLIENT_KEY_FAILED = ${JSON.stringify(CLIENT_KEY_FAILED)};`,
  `var PEER_LINK_FAILED = ${JSON.stringify(PEER_LINK_FAILED)};`,
  `var INSTANCE_LINK_SCHEMES = ${JSON.stringify(INSTANCE_LINK_SCHEMES)};`,
].join('\n');

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeamRouter</title>
<link rel="icon" type="image/svg+xml" href="${logoDataUrl()}">
<style>
  /* Dark is the default, and stays the default for a viewer whose system says
     nothing. The light palette is applied two ways: by the media query when no
     choice has been stored (data-theme absent), and by the attribute when one
     has. The media rule excludes an explicit dark choice, so choosing dark on a
     light desktop is honoured rather than overridden by the system. */
  :root {
    color-scheme: dark;
    --bg: #0d1117; --side: #0a0e13; --panel: #151b23; --panel2: #1c2430; --line: #262f3b; --track: #252e3a;
    --text: #d7dde4; --dim: #8a949f; --accent: #53b1fd; --accent-bg: rgba(83,177,253,.12);
    --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    --claude: #e0896a; --codex: #2bb88f; --backend: #a58bf0;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      color-scheme: light;
      --bg: #f6f8fa; --side: #ffffff; --panel: #ffffff; --panel2: #f3f5f8; --line: #d8dee4; --track: #e4e8ee;
      --text: #1f2328; --dim: #59636e; --accent: #0969da; --accent-bg: rgba(9,105,218,.10);
      --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e;
      --claude: #b8572f; --codex: #0b7d5f; --backend: #7a52cc;
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #f6f8fa; --side: #ffffff; --panel: #ffffff; --panel2: #f3f5f8; --line: #d8dee4; --track: #e4e8ee;
    --text: #1f2328; --dim: #59636e; --accent: #0969da; --accent-bg: rgba(9,105,218,.10);
    --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e;
    --claude: #b8572f; --codex: #0b7d5f; --backend: #7a52cc;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  button { font: inherit; }
  .shell { display: grid; grid-template-columns: 228px minmax(0, 1fr); min-height: 100vh; }
  .side { background: var(--side); border-right: 1px solid var(--line); padding: 18px 12px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 9px; color: #ff1300; font: 700 15px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; padding: 0 10px 10px; }
  .brand svg { width: 20px; height: 20px; flex: none; }
  #nav { display: flex; flex-direction: column; gap: 2px; }
  .navsec { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); padding: 14px 10px 4px; }
  .navbtn { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; font-size: 13px; text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dim); cursor: pointer; }
  .navbtn:hover { color: var(--text); background: var(--panel); }
  .navbtn.sel { color: var(--text); background: var(--accent-bg); box-shadow: inset 2px 0 0 var(--accent); }
  .count { font-size: 11px; line-height: 18px; min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--panel2); color: var(--dim); text-align: center; font-variant-numeric: tabular-nums; }
  .count.bad { background: var(--bad); color: #fff; }
  #instances { display: flex; flex-direction: column; gap: 4px; padding: 0 10px 6px; }
  #instances label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); }
  #instances select { width: 100%; font-size: 13px; }
  #instanceNote { font-size: 12px; margin: 8px 0; color: var(--dim); }
  .sidefoot { margin-top: auto; padding: 14px 10px 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; font-size: 12px; color: var(--dim); }
  .sidefoot button { text-align: left; }
  .content { padding: 22px 28px 40px; min-width: 0; }
  .wrap { max-width: 1260px; margin: 0 auto; }
  .top { margin-bottom: 14px; }
  h1 { font-size: 20px; line-height: 1.3; }
  h2 { font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; margin: 22px 0 8px; }
  .sub { color: var(--dim); margin-top: 2px; }
  .sub b { color: var(--text); font-weight: 600; }
  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 16px; }
  .tab { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 5px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--dim); cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.sel { color: var(--text); border-color: var(--accent); background: var(--accent-bg); }
  .sechead h2 { display: flex; align-items: center; gap: 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 540px), 1fr)); gap: 12px; margin-bottom: 8px; }
  .summary-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .scard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .scard .k { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 8px; }
  .scard .k span + span { color: var(--dim); font-weight: 400; font-size: 12px; }
  .pool + .pool { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .pool .pl { font-size: 12px; color: var(--dim); }
  .pool .v { font-size: 24px; font-weight: 650; line-height: 1.25; margin: 2px 0 8px; font-variant-numeric: tabular-nums; }
  .pool .v small { font-size: 13px; color: var(--dim); font-weight: 400; }
  .pool.small .v { font-size: 16px; }
  .seg { display: flex; gap: 3px; height: 8px; }
  .seg span { flex: 1; background: var(--track); border-radius: 3px; overflow: hidden; }
  .seg i, .bar i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
  .seg i.warn, .bar i.warn { background: var(--warn); }
  .seg i.bad, .bar i.bad { background: var(--bad); }
  .scard .r { font-size: 12px; color: var(--dim); margin-top: 8px; }
  .scard .drain { font-size: 12px; color: var(--accent); margin-top: 8px; }
  .more { font-size: 12px; background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
  .sechead { display: flex; align-items: center; gap: 10px; margin: 22px 0 8px; }
  .sechead h2 { margin: 0; }
  .sechead .tag { margin-left: 2px; }
  .rows { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  .arow { display: grid; grid-template-columns: minmax(180px, 1.2fr) repeat(3, minmax(140px, 1fr)) 116px; gap: 8px 20px; align-items: start; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .arow:last-child { border-bottom: 0; }
  .who .name { font-weight: 600; overflow-wrap: anywhere; }
  .who .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .who .usage { margin-top: 6px; }
  .meter .mt { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 12px; color: var(--dim); }
  .meter .mt b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .meter .mt b.warn { color: var(--warn); } .meter .mt b.bad { color: var(--bad); } .meter .mt b.ok { color: var(--ok); }
  .bar { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin: 5px 0 4px; }
  .meter .rs { font-size: 11px; color: var(--dim); min-height: 16px; }
  .meter.none { color: var(--dim); font-size: 12px; opacity: .55; }
  .ctl { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .ctl .resets { font-size: 12px; color: var(--codex); text-align: center; align-self: center; }
  .ctl .resets.none { color: var(--dim); }
  .btn { font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel2); color: var(--text); cursor: pointer; white-space: nowrap; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { color: #fff; filter: brightness(1.08); }
  .btn:disabled { opacity: .5; cursor: default; }
  .rowx { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; }
  .rowx .more { align-self: flex-start; }
  .xmeters { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 220px)); gap: 8px 20px; margin-top: 4px; }
  .empty { color: var(--dim); padding: 18px 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
  .row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; color: var(--dim); }
  .badge { font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--line); white-space: nowrap; }
  .badge.active { color: var(--ok); border-color: var(--ok); }
  .badge.throttled { color: var(--warn); border-color: var(--warn); }
  .badge.error, .badge.exhausted, .badge.disabled { color: var(--bad); border-color: var(--bad); }
  .badge.current, .badge.drain { color: var(--accent); border-color: var(--accent); }
  .badge.plan { color: var(--text); background: var(--panel2); }
  .badge.provider { color: var(--text); }
  .badge.provider.anthropic { color: var(--claude); border-color: var(--claude); }
  .badge.provider.codex { color: var(--codex); border-color: var(--codex); }
  /* One colour per provider family (providerTone), on its dot, its section
     and its sign-in button, so a Claude login and a ChatGPT one never look alike. */
  .pdot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; background: var(--backend); }
  .pdot.claude { background: var(--claude); } .pdot.codex { background: var(--codex); }
  .rows.claude, .pcard.claude { border-left: 3px solid var(--claude); }
  .rows.codex, .pcard.codex { border-left: 3px solid var(--codex); }
  .rows.backend, .pcard.backend { border-left: 3px solid var(--backend); }
  .btn.claude { color: var(--claude); border-color: var(--claude); background: color-mix(in srgb, var(--claude) 12%, transparent); }
  .btn.codex { color: var(--codex); border-color: var(--codex); background: color-mix(in srgb, var(--codex) 12%, transparent); }
  .btn.claude:hover, .btn.codex:hover { filter: brightness(1.15); }
  .btn.claude:hover { color: var(--claude); border-color: var(--claude); } .btn.codex:hover { color: var(--codex); border-color: var(--codex); }
  .btn.rm { min-width: 112px; }
  .btn.danger { color: var(--bad); border-color: var(--bad); }
  .btn.danger:hover { color: #fff; background: var(--bad); border-color: var(--bad); }
  .addbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
  .addbar .lbl { color: var(--dim); font-size: 13px; margin-right: 2px; }
  .addbar .btn { font-size: 13px; padding: 6px 14px; display: inline-flex; align-items: center; gap: 8px; }
  /* The table is wider than a phone; it scrolls inside its card rather than
     running past the card's edge with the row's buttons out of reach. */
  .pcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 4px 6px; margin-bottom: 18px; overflow-x: auto; }
  .phead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 22px 0 8px; }
  .phead h2 { margin: 0; display: flex; align-items: center; gap: 8px; }
  .phead .tag { flex: 1 1 200px; }
  .signin { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 0 0 16px; }
  .signin.claude { border-color: var(--claude); } .signin.codex { border-color: var(--codex); }
  .signin .sh { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 10px; }
  .signin .sh .sp { flex: 1; }
  .signin ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 10px; }
  .signin .line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
  .signin input { flex: 1 1 260px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .signin a.btn { text-decoration: none; display: inline-block; }
  .signin .st { font-size: 12px; color: var(--dim); margin-top: 10px; }
  .signin .st.ok { color: var(--ok); } .signin .st.warn { color: var(--warn); } .signin .st.error { color: var(--bad); }
  .ckeys .ckh { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .ckeys .ckh .hint { margin-left: 0; }
  .ckeys form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0; }
  .ckeys input, .ckeys textarea { flex: 1 1 260px; min-width: 0; font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .ckeys textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  .ckeys .issued { border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px; margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .ckeys .issued .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .ckeys .issued .lbl { font-size: 12px; color: var(--dim); margin-top: 4px; }
  .ckeys .st { font-size: 12px; color: var(--dim); }
  .ckeys .st.ok { color: var(--ok); } .ckeys .st.warn { color: var(--warn); } .ckeys .st.error { color: var(--bad); }
  .ckeys table { margin-top: 8px; }
  /* Show details and Revoke stack on a phone; keep them apart there too. */
  .ckeys td .btn + .btn { margin-top: 4px; }
  /* The Linked instances card reuses the client-key look, with its form as labelled rows. */
  .links { margin-top: 16px; }
  .links form, #linkBackFields { display: flex; flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 6px; }
  .links form { margin-top: 12px; }
  .links .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .links .row > label { flex: 0 0 200px; font-size: 12px; color: var(--dim); }
  .links .row > .btn { flex: none; }
  /* An address has no spaces to break at; on a phone it would push Remove off the card. */
  .links td.addr { word-break: break-all; }
  .links td .btn + .btn { margin-top: 4px; }
  .links .check { display: flex; gap: 8px; align-items: center; font-size: 12px; margin-top: 4px; }
  .links .check input { flex: none; margin: 0; }
  .links .sub2 { font-size: 12px; font-weight: 600; margin-top: 4px; }
  .links .own { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
  .badge.meta { color: var(--dim); }
  .badge.sessions { color: var(--text); }
  .badge.sessions.known { color: var(--dim); }
  .badge.extra-usage { color: var(--warn); border-color: var(--warn); }
  .badge.extra-usage.billing { color: var(--bad); border-color: var(--bad); }
  .badge.model { color: var(--accent); border-color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; font-variant-numeric: tabular-nums; vertical-align: top; }
  th { color: var(--dim); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; }
  td .btn + .btn { margin-left: 6px; }
  .usage { color: var(--dim); font-size: 12px; }
  .blocked { color: var(--warn); font-size: 12px; }
  #note { font-size: 12px; margin: 8px 0; display: none; }
  #note.ok, .cardnote.ok { color: var(--ok); } #note.warn, .cardnote.warn { color: var(--warn); } #note.error, .cardnote.error { color: var(--bad); }
  .cardnote { font-size: 12px; }
  #caller { font-size: 12px; margin: 8px 0; color: var(--dim); }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .filters label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; font-size: 12px; padding: 4px 8px; }
  .hint { color: var(--dim); font-size: 12px; margin-left: auto; }
  p.hint { margin: 8px 0 0; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0 16px; }
  .actions button, .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--dim); cursor: pointer; }
  .actions button:hover, .chip:hover { color: var(--text); border-color: var(--text); }
  .actions button:disabled { opacity: .5; cursor: default; }
  .actions button.sel, .chip.sel { color: var(--text); border-color: var(--accent); background: var(--accent-bg); }
  .actions .lbl { color: var(--dim); font-size: 12px; }
  .thr { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .thr input { width: 80px; font: inherit; font-size: 13px; padding: 4px 8px; text-align: right; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  .thr input.name { width: 170px; text-align: left; }
  .setting { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .setting + .setting { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .setting .tag { display: block; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  td.dim { color: var(--dim); }
  .ok { color: var(--ok); }
  .no { color: var(--dim); text-decoration: line-through; }
  .pin { color: var(--accent); font-size: 12px; }
  .warnt { color: var(--warn); font-size: 12px; }
  .badt { color: var(--bad); }
  .logbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .logbar label { color: var(--dim); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  td.when { color: var(--dim); white-space: nowrap; font-size: 12px; }
  td.kind { white-space: nowrap; font-size: 12px; color: var(--dim); }
  tr.bad td.ev { color: var(--bad); } tr.warn td.ev { color: var(--warn); } tr.ok td.ev { color: var(--ok); }
  td.detail { color: var(--dim); font-size: 12px; }
  td.client { color: var(--dim); font-size: 12px; }
  td.ev .prompt { color: var(--dim); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
  .plist div { border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; font-size: 13px; }
  .plist .bad { background: rgba(248,81,73,.12); border: 1px solid var(--bad); color: var(--bad); }
  .plist .warn { background: rgba(210,153,34,.12); border: 1px solid var(--warn); color: var(--warn); }
  #err { color: var(--bad); margin: 12px 0; display: none; }
  #problems { display: none; margin: 0 0 16px; }
  #keybox { display: none; margin: 80px auto; max-width: 420px; text-align: center; padding: 0 16px; }
  #keybox input { width: 100%; padding: 10px 12px; margin: 12px 0; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; color: var(--text); font: inherit; }
  #keybox button { padding: 8px 20px; background: var(--accent); border: 0; border-radius: 6px; color: #fff; font-weight: 600; cursor: pointer; }
  @media (max-width: 1080px) {
    .arow { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .who, .ctl { grid-column: 1 / -1; }
    .ctl { flex-direction: row; flex-wrap: wrap; }
  }
  @media (max-width: 760px) {
    .summary-pair { grid-template-columns: 1fr; }
    .shell { grid-template-columns: 1fr; }
    .side { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 12px; }
    #nav { flex-direction: row; flex-wrap: wrap; }
    .navbtn { width: auto; }
    .navsec { display: none; }
    .sidefoot { flex-direction: row; flex-wrap: wrap; align-items: center; margin-top: 8px; padding-top: 8px; }
    .content { padding: 16px; }
    .arow { grid-template-columns: 1fr; }
  }
</style>
<script>
(function () {
  try {
    var t = localStorage.getItem('teamclaude-dashboard-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage disabled: the media query still decides */ }
})();
</script>
</head>
<body>
<div id="keybox">
  <h1>TeamRouter</h1>
  <p class="sub">Enter your proxy key to view status.</p>
  <input id="key" type="password" placeholder="tc-..." autocomplete="off">
  <br><button id="go">Connect</button>
</div>
<div id="app" class="shell" style="display:none">
  <aside class="side">
    <div class="brand">${logoMarkup()}TeamRouter</div>
    <div id="instances" style="display:none">
      <label for="instance">Instance</label>
      <select id="instance"></select>
    </div>
    <nav id="nav"></nav>
    <div class="sidefoot">
      <button id="theme" class="more" type="button" title="Switch between following the system, light and dark"></button>
      <span id="foot"></span>
    </div>
  </aside>
  <main class="content">
  <div class="wrap">
    <div class="top">
      <h1 id="pageTitle">Quota</h1>
      <p class="sub" id="summary"></p>
    </div>
    <div id="err"></div>
    <div id="problems" class="plist"></div>
    <div id="note"></div>
    <div id="instanceNote" style="display:none"><span id="instanceText"></span> <button id="instanceBack" class="more" type="button">Back to this machine</button></div>
    <div id="caller" style="display:none"><span id="callerText"></span> <button id="changeKey" class="more" type="button">Change key</button></div>

    <section id="page-quota">
      <div id="tabs" class="tabs"></div>
      <div id="summaryCards" class="cards"></div>
      <div id="quotaVisibility" class="filters"></div>
      <div id="accounts"></div>
    </section>

    <section id="page-sessions" style="display:none">
      <p class="sub" id="sessionsEmpty" style="display:none"></p>
      <div id="sessionsWrap" style="display:none">
        <div class="card" style="padding:0">
          <div class="filters">
            <label>Project <select id="fProject"></select></label>
            <label>Client <select id="fClient"></select></label>
            <span class="hint" id="sessionCount"></span>
          </div>
          <div style="padding:4px 6px"><table id="sessions"></table></div>
        </div>
      </div>
    </section>

    <section id="page-clients" style="display:none">
      <div id="clientKeys" class="card ckeys" style="display:none">
        <div class="ckh"><b>Client keys</b><span class="hint">One per machine or agent of yours. Requests made with a key are counted here under its name.</span></div>
        <form id="ckForm" autocomplete="off">
          <input id="ckName" maxlength="64" placeholder="Name, e.g. laptop or ci-agent" aria-label="Client key name">
          <button id="ckCreate" class="btn primary" type="submit">Generate key</button>
        </form>
        <div id="ckStatus" class="st" style="display:none"></div>
        <div id="ckIssued" class="issued" style="display:none"></div>
        <table id="ckList"></table>
      </div>
      <p class="sub" id="clientsEmpty" style="display:none">No client usage yet. Requests made with a client key are counted here under the key's name, and per configured usage dimension (proxy.usageDimensions).</p>
      <div id="usageViewWrap" class="actions" style="display:none"></div>
      <div id="clientsWrap" style="display:none">
        <h2 id="clientsHeading">Clients</h2>
        <div class="card" style="padding:4px 6px"><table id="clients"></table></div>
      </div>
      <div id="dimensionsWrap"></div>
    </section>

    <section id="page-accounts" style="display:none">
      <div id="addBar" class="addbar"></div>
      <div id="signIn" class="signin" style="display:none"></div>
      <div id="accountGroups"></div>
    </section>

    <section id="page-logs" style="display:none">
      <div class="logbar">
        <div id="logKinds" class="chips"></div>
        <label>Provider <select id="logProvider"></select></label>
        <label>Account <select id="logAccount"></select></label>
        <span class="hint" id="logCount"></span>
      </div>
      <div class="card" style="padding:4px 6px"><table id="logs"></table></div>
      <p class="hint">Requests, sign-ins, sign-outs, rotation and changes, newest first. Kept in the proxy's memory (the last ${EVENT_LOG_CAPACITY} events); a restart starts a fresh log.</p>
    </section>

    <section id="page-problems" style="display:none">
      <div id="problemList" class="plist"></div>
    </section>

    <section id="page-routing" style="display:none">
      <div class="card" id="modeCard"></div>
      <div id="routesWrap" style="display:none">
        <h2>Routes</h2>
        <div class="card" style="padding:4px 6px"><table id="routes"></table></div>
      </div>
    </section>

    <section id="page-settings" style="display:none">
      <div class="card">
        <div class="setting" id="nameRow" style="display:none">
          <div><b>Instance name</b><span class="tag">What the Instance picker calls this machine. Empty uses the host name. Saved to the config file.</span></div>
          <span class="thr">
            <label for="nameVal">Name</label>
            <input id="nameVal" class="name" maxlength="64" spellcheck="false" autocomplete="off">
            <button id="nameSet" class="btn" type="button">Save</button>
          </span>
        </div>
        <div class="setting">
          <div><b>Switch threshold</b><span class="tag">The share of a quota window at which rotation leaves an account. Saved to the config file.</span></div>
          <span class="thr">
            <label for="thrVal">Switch at</label>
            <input id="thrVal" type="number" min="1" max="100" step="0.1" inputmode="decimal">
            <span>%</span>
            <button id="thrSet" class="btn" type="button">Set</button>
          </span>
        </div>
        <div class="setting">
          <div><b>Config</b><span class="tag">Re-read the config file, as after a hand edit or a sign-in in another terminal.</span></div>
          <button id="reload" class="btn" type="button">Reload config</button>
        </div>
        <div class="setting">
          <div><b>Quota refresh</b><span class="tag">How often the proxy re-reads every account's quota in the background. Saved to the config file.</span></div>
          <span class="thr">
            <label for="probeEvery">Refresh</label>
            <select id="probeEvery"></select>
          </span>
        </div>
        <div class="setting">
          <div><b>Quota</b><span class="tag">Read every account's quota now. Zero-spend: it asks the usage endpoints, not the model.</span></div>
          <button id="probe" class="btn" type="button">Probe quotas</button>
        </div>
        <div class="setting">
          <div><b>Proxy key</b><span class="tag">Forget the key this browser stored and enter another.</span></div>
          <button id="forgetKey" class="btn" type="button">Change key</button>
        </div>
      </div>
      <div id="links" class="card ckeys links" style="display:none">
        <div class="ckh"><b>Linked instances</b><span class="hint">TeamClaude on your other machines. Each one linked here is in the Instance picker at the top of the sidebar, where every page shows that machine.</span></div>
        <table id="linkList"></table>
        <p class="hint" id="linkEmpty" style="display:none">No machine is linked yet.</p>
        <p class="st warn" id="linkUnsupported" style="display:none">This instance runs a version that cannot be linked from the dashboard. Update it to manage its links here.</p>
        <form id="linkForm" autocomplete="off">
          <div class="sub2">Link another machine</div>
          <div class="row"><label for="linkPaste">Its link</label><input id="linkPaste" type="password" placeholder="From its dashboard: Settings, Linked instances, Show key, Copy link" spellcheck="false"></div>
          <div class="row"><label for="linkUrl">Its address</label><input id="linkUrl" placeholder="http://100.64.0.2:3456" spellcheck="false"></div>
          <div class="row"><label for="linkKey">Its proxy key</label><input id="linkKey" type="password" placeholder="From its dashboard: Settings, Linked instances, Show key" spellcheck="false"><button id="linkTest" class="btn" type="button">Test</button></div>
          <div class="row"><label for="linkName">Name it</label><input id="linkName" maxlength="64" placeholder="e.g. desktop" spellcheck="false"></div>
          <label class="check"><input id="linkBack" type="checkbox" checked><span id="linkBackText">Link back too: list this machine on it, so its dashboard shows this one</span></label>
          <div id="linkBackFields">
            <div class="row"><label for="linkSelfUrl" id="linkSelfUrlLabel">This machine, as it reaches it</label><input id="linkSelfUrl" list="linkSelfUrls" placeholder="http://100.64.0.1:3456" spellcheck="false"><datalist id="linkSelfUrls"></datalist></div>
            <div class="row"><label for="linkSelfName" id="linkSelfNameLabel">Name for this machine there</label><input id="linkSelfName" maxlength="64" spellcheck="false"></div>
          </div>
          <div id="linkBackBlocked" class="st warn" style="display:none"></div>
          <div class="row"><button id="linkAdd" class="btn primary" type="submit">Link</button><span id="linkStatus" class="st"></span></div>
        </form>
        <div class="own" id="ownKey"><span id="ownKeyLabel">This machine's link, or its proxy key and address, for linking it from another machine's dashboard.</span><button id="ownKeyShow" class="btn" type="button">Show key</button></div>
        <div id="ownKeyBox" class="issued" style="display:none"></div>
      </div>
    </section>
  </div>
  </main>
</div>
<script>
(function () {
  'use strict';
  var KEY = 'teamclaude-dashboard-key';
  var THEME_KEY = 'teamclaude-dashboard-theme';
  var POLL_MS = 5000;
  var timer = null;
  var lastStatus = null;
  var sessionFilters = { project: '', client: '' };
  var sortState = { sessions: { key: 'lastSeen', dir: 'desc' } };
  // The usage window applies to every table the usage trackers feed (Clients
  // and each configured dimension), so it is page state rather than per-table:
  // two controls left on different windows would invite reading one table's
  // number against the other's. Like the sort, it survives the poll.
  var usageView = 'total';
  var usageButtons = [];
  var UNAVAILABLE_TEXT = ${JSON.stringify(UNAVAILABLE_TEXT)};

  // The sidebar, in the order an operator reaches for things. Every page is
  // rendered on each poll and only shown or hidden, so switching pages never
  // waits on the network and a page left open keeps up with the fleet.
  var PAGES = [
    { key: 'quota', label: 'Quota', section: 'Overview' },
    { key: 'sessions', label: 'Sessions', section: 'Overview' },
    { key: 'clients', label: 'Clients', section: 'Overview' },
    { key: 'accounts', label: 'Accounts', section: 'Accounts' },
    { key: 'logs', label: 'Logs', section: 'Observe' },
    { key: 'problems', label: 'Problems', section: 'Observe' },
    { key: 'routing', label: 'Routing', section: 'Control' },
    { key: 'settings', label: 'Settings', section: 'Control' },
  ];
  var currentPage = 'quota';
  // The linked instance this page shows (peers.js), or '' for the machine it
  // was opened on. Every request goes through at(), so each page, button and
  // sign-in acts on the instance shown. Switching reloads the page: nothing
  // one instance's page holds (its logs, its notes) carries over to another.
  var INSTANCE = 'teamclaude-dashboard-instance';
  var peer = localStorage.getItem(INSTANCE) || '';
  var peerUrl = '';
  // Whether this machine has let the page's key reach the linked instance yet.
  // Nothing is relayed before it has: the relay's 403 for a client key would
  // read as a bad key and throw a valid one away.
  var peerChecked = false;
  function at(url) {
    return peer ? '/teamclaude/peers/' + encodeURIComponent(peer) + url.slice('/teamclaude'.length) : url;
  }
  function pickInstance(name) {
    if (name) localStorage.setItem(INSTANCE, name); else localStorage.removeItem(INSTANCE);
    peer = name;
    if (typeof location !== 'undefined') location.reload();
  }
  var navButtons = {};
  var navCounts = {};
  // Which provider tab the quota page is showing; kept across polls.
  var currentTab = 'all';
  var showAllAccounts = false;
  // Open "Show" expanders, by card or row. No prototype: an account named
  // __proto__ would otherwise set it.
  var expanded = Object.create(null);
  // The Logs page's copy of the proxy's event log, fetched only while the page
  // is open, so a dashboard left on Quota costs the server one request a poll.
  var logState = { generation: null, events: [] };
  var logFilters = { kind: 'all', provider: '', account: '' };
  var logChips = [];
  var logError = null;
  var logsInFlight = false;

${SHARED_CONSTS}

${SHARED_HELPERS}

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(cls, text, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // Status timestamps arrive in both shapes: epoch milliseconds (account
  // quota resets, account usage.lastUsed) and ISO strings (client lastUsed).
  // Date.parse() only handles strings, so numbers must pass through as-is —
  // feeding it a number silently yields NaN and the field just never renders.
  function parseTs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    return Date.parse(v);
  }

  function fmtAgo(ts) {
    var t = parseTs(ts);
    if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function fmtIn(sec) {
    if (sec == null) return '';
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return (s / 3600).toFixed(1) + 'h';
    return (s / 86400).toFixed(1) + 'd';
  }

  // How long until a reset, the way the rows say it: "40m", "3h 20m", "1 day",
  // "2.5 days".
  function fmtUntil(sec) {
    var s = Math.max(0, Math.round(sec));
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
    var d = Math.round(s / 8640) / 10;
    return d + (d === 1 ? ' day' : ' days');
  }

  // Absolute wall-clock of a future timestamp: "17:30" today, "Wed 09:00"
  // beyond 24h — the countdown says how long, this says when.
  function fmtClock(ts) {
    var d = new Date(ts);
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ts - Date.now() >= 86400000) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    }
    return time;
  }

  function resetText(resetAt) {
    var t = parseTs(resetAt);
    if (isNaN(t) || t <= Date.now()) return '';
    return 'resets in ' + fmtUntil((t - Date.now()) / 1000) + ' · ' + fmtClock(t);
  }

  function pctText(fraction) {
    return Math.round(fraction * 100) + '%';
  }

  // One quota column: the label and what is left on top, the bar, the reset
  // under it. The bar fills with what is LEFT, so a full green bar is an
  // account with its window ahead of it.
  function meterEl(m) {
    var box = el('div', m ? 'meter' : 'meter none');
    if (!m) { box.appendChild(el('div', 'mt', '—')); return box; }
    var top = el('div', 'mt');
    top.appendChild(el('span', '', m.label));
    top.appendChild(el('b', m.tone === 'unknown' ? '' : m.tone, m.left == null ? '?' : pctText(m.left) + ' left'));
    box.appendChild(top);
    var bar = el('div', 'bar');
    var fill = el('i', m.tone === 'warn' || m.tone === 'bad' ? m.tone : '');
    fill.style.width = (m.left == null ? 0 : m.left * 100) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('div', 'rs', m.note || resetText(m.resetAt)));
    return box;
  }

  function modelBadges(usage, into) {
    recentModelLabels(usage).forEach(function (l) { into.appendChild(el('span', 'badge model', l)); });
  }

  function isCurrentAccount(a, s) {
    return s.currentAccounts ? s.currentAccounts[a.provider] === a.name : a.name === s.currentAccount;
  }

  // One account on the quota page: who it is, its three quota columns, and
  // the controls that act on it. Everything else the old card carried — why it
  // is blocked, outside spend, the forecast, other model buckets — sits on a
  // line under the columns, only when there is something to say.
  function renderAccountRow(a, s, fable, probeEntry) {
    var key = cardNoteKey(a);
    var row = el('div', 'arow');
    var who = el('div', 'who');
    who.appendChild(el('div', 'name', a.name));
    var badges = el('div', 'badges');
    if (a.plan) badges.appendChild(el('span', 'badge plan', a.plan));
    if (a.drainRank) badges.appendChild(el('span', 'badge drain', a.drainRank === 1 ? 'draining' : '#' + a.drainRank + ' in queue'));
    // The first three are provider, type and priority: the section heading
    // already names the provider, and the Accounts page carries the other two.
    // "active" is the state every healthy row would wear, so it is left off.
    // A Codex row says its resets under its controls instead, beside the
    // button that spends them.
    var resetsLeft = codexResetsLeft(a);
    accountBadges(a, s.currentAccount, s.currentAccounts || null, null, s.switchThreshold, s.switchThresholds).slice(3).forEach(function (b) {
      if (b.cls === 'active' || (resetsLeft != null && b.cls === 'meta resets')) return;
      badges.appendChild(el('span', 'badge ' + b.cls, b.text));
    });
    modelBadges(a.usage, badges);
    who.appendChild(badges);
    var u = a.usage || {};
    who.appendChild(el('div', 'usage', (u.totalRequests || 0) + ' req · ' + fmtNum(accountTokens(u)) + ' tok' + (u.lastUsed ? ' · last ' + fmtAgo(u.lastUsed) : '')));
    row.appendChild(who);

    var meters = accountMeters(a, fable);
    meters.slots.forEach(function (m) { row.appendChild(meterEl(m)); });

    var ctl = el('div', 'ctl');
    // Zero-spend, like the fleet-wide probe on the Settings page, so a client
    // key may use it too. Disabled while a probe of this account is in flight,
    // whether this button or a fleet cycle started it.
    if (canRefreshQuota(a, probeEntry)) {
      var refresh = button('btn', probeEntry.status === 'running' ? 'Refreshing…' : 'Refresh quota', function () { doRefreshQuota(a, key, refresh); });
      refresh.disabled = probeEntry.status === 'running';
      ctl.appendChild(refresh);
    }
    if (!isCurrentAccount(a, s) && !a.disabled) {
      var sw = button('btn', 'Switch to', function () { doSwitch(a.name, key, sw); });
      ctl.appendChild(sw);
    }
    if (canRedeemReset(a, s.caller)) ctl.appendChild(resetButton(a, key));
    if (resetsLeft != null) ctl.appendChild(el('div', 'resets' + (resetsLeft ? '' : ' none'), resetsLeftText(resetsLeft)));
    row.appendChild(ctl);

    var x = el('div', 'rowx');
    var said = 0;
    var cn = cardNoteFor(cardNotes, key, Date.now());
    if (cn) { x.appendChild(el('div', 'cardnote ' + cn.kind, cn.text)); said++; }
    if (a.unavailable) { x.appendChild(el('div', 'blocked', 'blocked: ' + (UNAVAILABLE_TEXT[a.unavailable] || a.unavailable))); said++; }
    if (meters.text) { x.appendChild(el('div', 'usage', meters.text)); said++; }
    var q = a.quota || {};
    // Spend on this account that did not come through the proxy (#475).
    var outside = outsideSpendText(q.outsideSpend);
    if (outside) { x.appendChild(el('div', 'usage', 'outside: ' + outside)); said++; }
    var forecast = forecastText(q.forecast, Date.now());
    if (forecast) { x.appendChild(el('div', 'usage', 'forecast: ' + forecast)); said++; }
    if (meters.extra.length) {
      var open = !!expanded['row:' + key];
      var names = meters.extra.map(function (m) { return m.label; }).join(', ');
      x.appendChild(button('more', (open ? 'Hide ' : 'Show ') + names, function () {
        expanded['row:' + key] = !open;
        if (lastStatus) render(lastStatus);
      }));
      if (open) {
        var grid = el('div', 'xmeters');
        meters.extra.forEach(function (m) { grid.appendChild(meterEl(m)); });
        x.appendChild(grid);
      }
      said++;
    }
    if (said) row.appendChild(x);
    return row;
  }

  // Which account in a group holds its provider's cursor. Backends share the
  // Claude provider's cursor, so a backend group has a current account only
  // when that cursor is on one of its own.
  function currentIn(s, group, members) {
    var provider = group === 'codex' ? 'codex' : 'anthropic';
    var name = s.currentAccounts ? s.currentAccounts[provider] : s.currentAccount;
    return members.some(function (a) { return a.name === name; }) ? name : null;
  }

  function poolBlock(p, small) {
    var box = el('div', small ? 'pool small' : 'pool');
    box.appendChild(el('div', 'pl', p.label));
    var v = el('div', 'v');
    v.appendChild(el('span', '', p.count ? pctText(p.left) : '?'));
    v.appendChild(el('small', '', p.count ? ' of ' + (p.count * 100) + '% left' : ' no reading yet'));
    box.appendChild(v);
    var seg = el('div', 'seg');
    p.segments.forEach(function (sg) {
      var cell = el('span');
      cell.title = sg.name + ': ' + pctText(sg.left) + ' left';
      var fill = el('i', sg.tone === 'warn' || sg.tone === 'bad' ? sg.tone : '');
      fill.style.width = (sg.left * 100) + '%';
      cell.appendChild(fill);
      seg.appendChild(cell);
    });
    box.appendChild(seg);
    var line = p.soonest ? 'soonest reset: ' + p.soonest.name + ' · ' + resetText(p.soonest.resetAt).replace('resets ', '') : '';
    if (p.unknown) line += (line ? ' · ' : '') + p.unknown + ' without a reading';
    if (line) box.appendChild(el('div', 'r', line));
    return box;
  }

  // A provider's summary card: its headline column pooled across its accounts
  // (Fable weekly for Claude, the weekly limit for Codex), and the rest behind
  // Show, the way the rows put the less used buckets behind theirs. The
  // adjacent session card uses the same display for just the five-hour pool.
  function summaryCard(s, group, members, fable, session) {
    var card = el('div', 'scard');
    var head = el('div', 'k');
    var title = el('span', '', groupLabel(group));
    title.insertBefore(el('span', 'pdot ' + providerTone(group)), title.firstChild);
    title.style.display = 'flex';
    title.style.alignItems = 'center';
    title.style.gap = '8px';
    head.appendChild(title);
    head.appendChild(el('span', '', members.length + (members.length === 1 ? ' account' : ' accounts')));
    card.appendChild(head);
    var order = session ? [1] : (group === 'codex' ? [2, 1] : [0, 1, 2]);
    var pools = order.map(function (i) { return poolSummary(members, i, fable); }).filter(function (p) { return p.label; });
    if (!pools.length) {
      if (session) card.appendChild(poolBlock({ label: '5-hour limit', count: 0, segments: [] }, false));
      else card.appendChild(el('div', 'r', 'no quota reading yet'));
    } else {
      card.appendChild(poolBlock(pools[0], false));
      var rest = pools.slice(1);
      if (rest.length) {
        var k = 'card:' + group;
        var open = !!expanded[k];
        var line = el('div', 'r');
        line.appendChild(el('span', '', rest.map(function (p) { return p.label + ' ' + (p.count ? pctText(p.left) + ' left' : '?'); }).join(' · ') + '  '));
        line.appendChild(button('more', open ? 'Hide' : 'Show', function () {
          expanded[k] = !open;
          if (lastStatus) render(lastStatus);
        }));
        card.appendChild(line);
        if (open) rest.forEach(function (p) { card.appendChild(poolBlock(p, true)); });
      }
    }
    // The free resets the Codex accounts hold between them: what could be
    // spent to clear a spent limit rather than wait it out.
    var resets = !session && group === 'codex' ? codexResetsSummary(members) : null;
    if (resets) card.appendChild(el('div', 'r', 'Resets left: ' + resets.left + ' across ' + resets.accounts + (resets.accounts === 1 ? ' account' : ' accounts')));
    // Drain mode's queue, when the server reports one: the account being spent
    // first and when it resets, so "why this account" reads off the card.
    var provider = group === 'codex' ? 'codex' : 'anthropic';
    var queue = !session && s.drainQueue && s.drainQueue[provider];
    var head0 = queue && queue.length ? members.filter(function (a) { return a.name === queue[0]; })[0] : null;
    if (head0) {
      var weekly = accountMeters(head0, fable).slots[2];
      var when = weekly ? resetText(weekly.resetAt) : '';
      card.appendChild(el('div', 'drain', 'Draining: ' + head0.name + (when ? ' · ' + when : '')));
    }
    return card;
  }

  function renderQuota(s) {
    var accounts = s.accounts || [];
    var tabs = providerTabs(accounts);
    if (!tabs.some(function (t) { return t.key === currentTab; })) currentTab = 'all';
    var tabBox = document.getElementById('tabs');
    tabBox.textContent = '';
    tabs.forEach(function (t) {
      var b = button(t.key === currentTab ? 'tab sel' : 'tab', t.label, function () {
        currentTab = t.key;
        if (lastStatus) render(lastStatus);
      });
      if (t.key !== 'all') b.insertBefore(el('span', 'pdot ' + providerTone(t.key)), b.firstChild);
      b.appendChild(el('span', 'count', String(t.count)));
      tabBox.appendChild(b);
    });
    var fable = fableLabel(accounts);
    var groups = tabs.slice(1).map(function (t) { return t.key; }).filter(function (g) { return currentTab === 'all' || g === currentTab; });
    var at = Date.now();
    var selected = accounts.filter(function (a) { return currentTab === 'all' || accountGroup(a) === currentTab; });
    var hidden = selected.filter(function (a) { return accountQuotaExhausted(a, at); }).length;
    var visibility = document.getElementById('quotaVisibility');
    visibility.textContent = '';
    if (hidden || showAllAccounts) {
      visibility.appendChild(el('span', 'hint', hidden + ' exhausted account' + (hidden === 1 ? '' : 's') + (showAllAccounts ? ' shown' : ' hidden')));
      var toggle = button('btn', showAllAccounts ? 'Hide exhausted' : 'Show all', function () {
        showAllAccounts = !showAllAccounts;
        if (lastStatus) render(lastStatus);
      });
      toggle.setAttribute('aria-pressed', String(showAllAccounts));
      visibility.appendChild(toggle);
    }
    var cards = document.getElementById('summaryCards');
    cards.textContent = '';
    var acc = document.getElementById('accounts');
    acc.textContent = '';
    if (!accounts.length) {
      acc.appendChild(el('div', 'card empty', 'No accounts yet. Sign one in on the Accounts page, or run teamclaude login.'));
      return;
    }
    var probeAccounts = (s.probe || {}).accounts || [];
    groups.forEach(function (g) {
      var members = [];
      accounts.forEach(function (a, i) { if (accountGroup(a) === g) members.push({ a: a, i: i }); });
      var list = members.map(function (m) { return m.a; });
      if (g === 'anthropic' || g === 'codex') {
        var pair = el('div', 'summary-pair');
        pair.appendChild(summaryCard(s, g, list, fable));
        pair.appendChild(summaryCard(s, g, list, fable, true));
        cards.appendChild(pair);
      } else cards.appendChild(summaryCard(s, g, list, fable));
      var head = el('div', 'sechead');
      head.appendChild(groupHeading(g, groupLabel(g)));
      var visible = members.filter(function (m) { return showAllAccounts || !accountQuotaExhausted(m.a, at); });
      head.appendChild(el('span', 'count', visible.length + ' of ' + members.length));
      var cur = currentIn(s, g, list);
      if (cur) head.appendChild(el('span', 'tag', 'current: ' + cur));
      acc.appendChild(head);
      var rows = el('div', 'rows ' + providerTone(g));
      if (!visible.length) rows.appendChild(el('div', 'empty', 'All accounts in this group have an exhausted limit. Use Show all to see them.'));
      visible.forEach(function (m) {
        // The probe's list is the fleet in the same order; the name check keeps a
        // payload that ever differs from pairing a row with another account's entry.
        var pe = probeAccounts[m.i] && probeAccounts[m.i].name === m.a.name ? probeAccounts[m.i] : null;
        rows.appendChild(renderAccountRow(m.a, s, fable, pe));
      });
      acc.appendChild(rows);
    });
  }

  function statusText(a) {
    if (a.disabled) return 'disabled';
    if (a.unavailable) return UNAVAILABLE_TEXT[a.unavailable] || a.unavailable;
    return a.status || 'unknown';
  }

  // What each provider section on the Accounts page says it holds.
  var GROUP_BLURB = {
    anthropic: 'Claude Pro and Max sign-ins, and Anthropic API keys. Claude Code uses these.',
    codex: 'ChatGPT sign-ins (Plus, Pro, Business). The Codex CLI uses these.',
  };

  // The heading over one provider's accounts, wherever they are listed.
  function groupHeading(group, text) {
    var h = el('h2');
    h.appendChild(el('span', 'pdot ' + providerTone(group)));
    h.appendChild(el('span', '', text));
    return h;
  }

  // The accounts, one section per provider, with the controls that change
  // where rotation may reach each one. A control this key would be refused is
  // not drawn at all; the line at the top of the page says why, once
  // (callerNotice). Claude and Codex always get a section, empty or not, so
  // the page says where a sign-in will land before there is one.
  function renderAccountsPage(s) {
    var canSignIn = callerCan(s.caller, '/teamclaude/login/start');
    var canRemove = callerCan(s.caller, '/teamclaude/remove');
    renderAddBar(canSignIn);
    var box = document.getElementById('accountGroups');
    box.textContent = '';
    var accounts = s.accounts || [];
    var groups = ['anthropic', 'codex'].concat(providerTabs(accounts).slice(1).map(function (t) { return t.key; })
      .filter(function (g) { return g !== 'anthropic' && g !== 'codex'; }));
    groups.forEach(function (g) {
      var members = accounts.filter(function (a) { return accountGroup(a) === g; });
      var head = el('div', 'phead');
      head.appendChild(groupHeading(g, g === 'codex' ? 'Codex (ChatGPT) accounts' : groupLabel(g) + ' accounts'));
      head.appendChild(el('span', 'count', String(members.length)));
      head.appendChild(el('span', 'tag', GROUP_BLURB[g] || 'A third-party backend, reached with an API key.'));
      box.appendChild(head);
      var card = el('div', 'pcard ' + providerTone(g));
      box.appendChild(card);
      if (!members.length) {
        card.appendChild(el('div', 'empty', canSignIn
          ? 'No ' + groupLabel(g) + ' accounts yet. Use Sign in to ' + groupLabel(g) + ' above to add one.'
          : 'No ' + groupLabel(g) + ' accounts yet.'));
        return;
      }
      var table = el('table');
      card.appendChild(table);
      var hr = el('tr');
      // Codex accounts carry a free-reset count the others do not.
      var heads = ['Account', 'Plan', 'Status', 'Priority', 'Conversations', 'Requests', 'Tokens', 'Last request'];
      if (g === 'codex') heads.push('Resets left');
      heads.push('');
      heads.forEach(function (h, i) {
        hr.appendChild(el('th', i >= 3 && i < heads.length - 1 ? 'num' : '', h));
      });
      table.appendChild(hr);
      members.forEach(function (a) { table.appendChild(accountTableRow(a, s, canSignIn, canRemove, g === 'codex')); });
    });
  }

  function accountTableRow(a, s, canSignIn, canRemove, withResets) {
    var key = cardNoteKey(a);
    var tr = el('tr');
    var name = el('td');
    name.appendChild(el('div', 'name', a.name));
    if (a.orgName) name.appendChild(el('div', 'tag', a.orgName));
    var emailLine = accountEmailLine(a);
    if (emailLine) name.appendChild(el('div', 'tag', emailLine));
    var cn = cardNoteFor(cardNotes, key, Date.now());
    if (cn) name.appendChild(el('div', 'cardnote ' + cn.kind, cn.text));
    var fileHint = fileSignInHint(a);
    if (fileHint) name.appendChild(el('div', 'cardnote warn', fileHint));
    tr.appendChild(name);
    tr.appendChild(el('td', '', a.plan || a.type || '—'));
    var st = el('td');
    st.appendChild(el('span', 'badge ' + (a.disabled ? 'disabled' : (a.status || '')), statusText(a)));
    if (isCurrentAccount(a, s)) { st.appendChild(el('span', '', ' ')); st.appendChild(el('span', 'badge current', 'current')); }
    tr.appendChild(st);
    tr.appendChild(el('td', 'num', String(a.priority || 0)));
    tr.appendChild(el('td', 'num', (a.sessions || 0) + ' / ' + (a.knownSessions || 0)));
    var u = a.usage || {};
    tr.appendChild(el('td', 'num', fmtNum(u.totalRequests)));
    tr.appendChild(el('td', 'num', fmtNum(accountTokens(u))));
    tr.appendChild(el('td', 'num', u.lastUsed ? fmtAgo(u.lastUsed) : '—'));
    if (withResets) {
      var left = codexResetsLeft(a);
      tr.appendChild(el('td', 'num', left == null ? '—' : String(left)));
    }
    var act = el('td', 'num');
    // Signed out upstream: the one thing that brings it back is a sign-in,
    // so it comes first. The tokens go to whichever account the browser
    // signs in as, which the panel says.
    var again = needsSignIn(a);
    if (again && canSignIn) {
      act.appendChild(button('btn ' + again, 'Sign in again', function () { startSignIn(again, a.email || a.name); }));
    }
    if (!isCurrentAccount(a, s) && !a.disabled) {
      var ctlSwitch = button('btn', 'Switch to', function () { doSwitch(a.name, key, ctlSwitch); });
      act.appendChild(ctlSwitch);
    }
    if (canRedeemReset(a, s.caller)) act.appendChild(resetButton(a, key));
    if (callerCan(s.caller, '/teamclaude/disable')) {
      var ctlDisable = button('btn', a.disabled ? 'Enable' : 'Disable', function () { doControlAccount(a.name, key, { disabled: !a.disabled }, ctlDisable); });
      act.appendChild(ctlDisable);
    }
    // Only enable/disable for a disabled account: the rest would move an
    // account that nothing will select anyway.
    if (!a.disabled && callerCan(s.caller, '/teamclaude/priority')) {
      var ctlFirst = button('btn', 'Prioritize', function () { doControlAccount(a.name, key, { place: 'first' }, ctlFirst); });
      act.appendChild(ctlFirst);
      var ctlLast = button('btn', 'Deprioritize', function () { doControlAccount(a.name, key, { place: 'last' }, ctlLast); });
      act.appendChild(ctlLast);
    }
    // Two clicks: the first arms the button for a few seconds, the second
    // removes. There is no undo short of signing in again. Arming changes
    // nothing but this button, which keeps its width, so no other control
    // slides under the pointer between the clicks; and a second click too
    // soon after the first is a double-click, not a decision.
    if (canRemove) {
      var armedAt = removeArmed[key];
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var ctlRemove = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm remove' : 'Remove', function () {
        if (!armed) { removeArmed[key] = Date.now(); if (lastStatus) render(lastStatus); return; }
        if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
        delete removeArmed[key];
        doRemove(a, key, ctlRemove);
      });
      ctlRemove.title = armed ? 'Click again to sign ' + a.name + ' out of TeamClaude' : 'Sign ' + a.name + ' out of TeamClaude';
      act.appendChild(ctlRemove);
    }
    tr.appendChild(act);
    return tr;
  }

  // The buttons that add an account. Rebuilt with the page; the sign-in
  // panel under them is not, so a paste being typed survives the poll.
  function renderAddBar(canSignIn) {
    var bar = document.getElementById('addBar');
    bar.textContent = '';
    bar.style.display = canSignIn ? '' : 'none';
    if (!canSignIn) return;
    bar.appendChild(el('span', 'lbl', 'Add an account:'));
    [['claude', 'Sign in to Claude', 'Sign in with a Claude Pro or Max account'], ['codex', 'Sign in to Codex', 'Sign in with a ChatGPT account, for the Codex CLI']].forEach(function (p) {
      var b = button('btn ' + p[0], p[1], function () { startSignIn(p[0], null); });
      b.title = p[2];
      b.insertBefore(el('span', 'pdot ' + p[0]), b.firstChild);
      bar.appendChild(b);
    });
  }

  // The window a usage table is showing, in its own heading. The control sits
  // above the Clients table, but the dimension tables are below it and can be
  // scrolled clear of it — and a five-hour figure under a bare "Input tok" is
  // the one way this feature can state a number under the wrong label.
  // Last used is a lifetime figure in a table whose heading may name a window.
  // Under Total that needs no saying; under a window it does, or it reads as
  // the one thing this control must never do — a number under the wrong label.
  function lastUsedLabel() {
    return usageView === 'total' ? 'Last used' : 'Last used (all time)';
  }

  function usageHeading(base) {
    if (usageView === 'total') return base;
    var view = USAGE_VIEWS.filter(function (v) { return v.key === usageView; })[0];
    return view ? base + ' · ' + view.label.toLowerCase() : base;
  }

  function renderClients(clients) {
    var wrap = document.getElementById('clientsWrap');
    var names = Object.keys(clients || {});
    if (!names.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    document.getElementById('clientsHeading').textContent = usageHeading('Clients');
    // Sorted on the window being shown, not on the lifetime total: a table
    // ordered by all-time spend while displaying the last five hours would put
    // the quiet clients on top of the busy one.
    names.sort(function (a, b) {
      var ua = usageFor(clients[a], usageView), ub = usageFor(clients[b], usageView);
      return (ub.inputTokens + ub.outputTokens) - (ua.inputTokens + ua.outputTokens);
    });
    var table = document.getElementById('clients');
    table.textContent = '';
    var hr = el('tr');
    ['Client', 'Requests', 'WebSockets', 'Input tok', 'Output tok', lastUsedLabel()].forEach(function (h, i) {
      hr.appendChild(el('th', i ? 'num' : '', h));
    });
    table.appendChild(hr);
    names.forEach(function (n) {
      var c = clients[n];
      var u = usageFor(c, usageView);
      var tr = el('tr');
      tr.appendChild(el('td', '', n));
      tr.appendChild(el('td', 'num', fmtNum(u.requests)));
      tr.appendChild(el('td', 'num', fmtNum(u.connections)));
      tr.appendChild(el('td', 'num', fmtNum(u.inputTokens)));
      tr.appendChild(el('td', 'num', fmtNum(u.outputTokens)));
      // Last used stays the lifetime figure under every window: it answers
      // when this client was last seen at all, which a window cannot.
      tr.appendChild(el('td', 'num', c.lastUsed ? fmtAgo(c.lastUsed) : '—'));
      table.appendChild(tr);
    });
  }

  // Client keys: the form and the panel holding a new key are static, so a name
  // being typed and a key not yet copied survive the poll; only the list of
  // configured names is rebuilt. Revoke is armed by a first click, like Remove.
  // No prototype: a key named __proto__ would otherwise set it.
  var ckRevokeArmed = Object.create(null);

  function renderClientKeys(s) {
    var card = document.getElementById('clientKeys');
    var can = callerCan(s.caller, '/teamclaude/client-keys/create');
    card.style.display = can ? '' : 'none';
    if (!can) return;
    var names = Array.isArray(s.clientKeys) ? s.clientKeys : [];
    var clients = s.clients || {};
    var table = document.getElementById('ckList');
    table.textContent = '';
    if (!names.length) return;
    var hr = el('tr');
    ['Key name', 'Last used', ''].forEach(function (h, i) { hr.appendChild(el('th', i ? 'num' : '', h)); });
    table.appendChild(hr);
    names.forEach(function (name) {
      var tr = el('tr');
      tr.appendChild(el('td', '', name));
      var used = clients[name] && clients[name].lastUsed;
      tr.appendChild(el('td', 'num', used ? fmtAgo(used) : 'not used yet'));
      var armedAt = ckRevokeArmed[name];
      var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
      var td = el('td', 'num');
      var open = issuedName === name;
      var d = button('btn', open ? 'Hide details' : 'Show details', function () {
        if (open) hideIssuedKey(); else doClientKey('show', name, d);
      });
      d.title = 'The key and the setup for Claude Code and the Codex CLI';
      td.appendChild(d);
      var b = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm revoke' : 'Revoke', function () {
        if (!armed) { ckRevokeArmed[name] = Date.now(); if (lastStatus) render(lastStatus); return; }
        if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
        delete ckRevokeArmed[name];
        doClientKey('revoke', name, b);
      });
      b.title = armed ? 'Click again: clients using this key are refused from now on' : 'Stop accepting this key';
      td.appendChild(b);
      tr.appendChild(td);
      table.appendChild(tr);
    });
  }

  function ckStatus(kind, text) {
    var st = document.getElementById('ckStatus');
    st.className = 'st ' + kind;
    st.textContent = text;
    st.style.display = text ? '' : 'none';
  }

  function doClientKey(step, name, btn) {
    btn.disabled = true;
    var r = clientKeyRequest(step, name, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = clientKeyOutcome(json, step);
        ckStatus(out.kind, out.text);
        if (json.ok && step === 'show') { showIssuedKey(json.name, json.key, true); if (lastStatus) render(lastStatus); return; }
        if (json.ok && step === 'create') {
          document.getElementById('ckName').value = '';
          // The proxy's first key closes a gate this page may have come in
          // through without a key. Its next poll would then be refused and
          // the key box would cover the panel before the key was copied, so
          // polling waits for Done.
          holdPoll = !!json.firstKey && !localStorage.getItem(KEY);
          showIssuedKey(json.name, json.key);
        }
        // A revoked key's panel would offer setup for a key that no longer works.
        if (json.ok && step === 'revoke' && issuedName === json.name) hideIssuedKey();
        poll();
      })
      .catch(function (e) { ckStatus('error', CLIENT_KEY_FAILED[step] + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // A key is shown in this panel only: the status endpoint never returns keys.
  // A new one opens it on create; Show details reads a key back on request.
  var issuedName = null;
  // Set while a first key's panel is open on a page that holds no key: see doClientKey.
  var holdPoll = false;

  function hideIssuedKey() {
    issuedName = null;
    var box = document.getElementById('ckIssued');
    box.textContent = '';
    box.style.display = 'none';
    if (holdPoll) { holdPoll = false; poll(); } else if (lastStatus) render(lastStatus);
  }

  function copyField(field, btn) {
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); };
    // The async clipboard needs a secure context, which a dashboard opened at
    // a plain-http LAN address is not; selecting the text still leaves it one
    // keystroke away.
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(field.value).then(done, function () { field.focus(); field.select(); });
      return;
    }
    field.focus();
    field.select();
    try { if (document.execCommand('copy')) done(); } catch (e) { /* the text stays selected */ }
  }

  function snippet(box, label, text, rows) {
    box.appendChild(el('div', 'lbl', label));
    var line = el('div', 'line');
    var field = rows ? el('textarea') : el('input');
    field.readOnly = true;
    field.value = text;
    if (rows) field.rows = rows;
    line.appendChild(field);
    var copy = button('btn', 'Copy', function () { copyField(field, copy); });
    line.appendChild(copy);
    box.appendChild(line);
  }

  function showIssuedKey(name, key, existing) {
    issuedName = name;
    var box = document.getElementById('ckIssued');
    box.textContent = '';
    var head = el('div', 'line');
    head.appendChild(el('b', '', 'Key for ' + name));
    head.appendChild(el('span', 'hint', existing ? 'Anyone who can see this screen can use the key.' : 'Copy it now, or come back with Show details.'));
    box.appendChild(head);
    var origin = peer ? peerUrl : typeof location !== 'undefined' ? location.origin : '';
    var setup = clientKeySetup(origin, key);
    snippet(box, 'Key', key, 0);
    snippet(box, 'Claude Code: run in the shell that starts claude', setup.claude, 2);
    snippet(box, 'Codex CLI: add to ~/.codex/config.toml', setup.codex, 7);
    if (isLoopbackHost(pageHost())) {
      box.appendChild(el('div', 'lbl', 'This page is open at ' + origin + '. A client on another machine needs an address of this one it can reach instead.'));
    }
    if (holdPoll) {
      box.appendChild(el('div', 'st warn', 'The proxy now asks every caller off its own machine for a key, this page included. Copy the key before you press Done: the page will then ask for one. To manage keys from here again, set proxy.apiKey.'));
    }
    var actions = el('div', 'line');
    var check = el('span', 'st');
    var test = button('btn', 'Test key', function () {
      test.disabled = true;
      check.className = 'st';
      check.textContent = 'Testing…';
      // Its own fetch, with the new key and not the page's: a 401 here says
      // the new key is refused and must not throw away the key the page holds.
      fetch('/teamclaude/status', { headers: { 'x-api-key': key } })
        .then(function (res) {
          return res.json().catch(function () { return null; }).then(function (body) { return clientKeyCheckOutcome(res.status, body, name); });
        })
        .catch(function (e) { return { kind: 'error', text: 'The test could not reach the proxy: ' + e.message }; })
        .then(function (out) { check.className = 'st ' + out.kind; check.textContent = out.text; test.disabled = false; });
    });
    // The test asks with the new key itself, which only the instance that
    // issued it accepts; a linked one is reached with this machine's key.
    if (!peer) actions.appendChild(test);
    actions.appendChild(button('btn', 'Done', hideIssuedKey));
    actions.appendChild(check);
    box.appendChild(actions);
    box.style.display = '';
  }

  // Linked instances (Settings). The list comes with every status; what the
  // instance shown can offer another machine (a name for itself, its
  // addresses, whether it can be linked back) is asked once per page load,
  // since it does not change while the proxy runs. Like everything else on
  // the page it is the shown instance's: picking a linked one manages ITS links.
  // Remove is armed by a first click, like Revoke.
  var linkSelf = null;
  var linkSelfState = 'unasked'; // 'unasked' | 'asking' | 'done' | 'unsupported'
  var linkRemoveArmed = Object.create(null);

  // The address this page was opened at, which is this machine as the browser
  // reaches it; nothing when the page shows a linked instance.
  function pageOrigin() {
    return !peer && typeof location !== 'undefined' ? location.origin : '';
  }

  function val(id) { return document.getElementById(id).value.trim(); }

  function renderLinks(s) {
    var card = document.getElementById('links');
    var can = Array.isArray(s.peers) && callerCan(s.caller, '/teamclaude/peer-links/add');
    card.style.display = can ? '' : 'none';
    if (!can) return;
    // Asked only once the card is on screen: every other page has no use for it.
    if (linkSelfState === 'unasked' && currentPage === 'settings') loadLinkSelf();
    var unsupported = linkSelfState === 'unsupported';
    document.getElementById('linkUnsupported').style.display = unsupported ? '' : 'none';
    document.getElementById('linkForm').style.display = unsupported ? 'none' : '';
    document.getElementById('ownKey').style.display = unsupported ? 'none' : '';
    document.getElementById('linkEmpty').style.display = s.peers.length ? 'none' : '';
    var table = document.getElementById('linkList');
    table.textContent = '';
    if (!s.peers.length) return;
    var hr = el('tr');
    ['Name', 'Address', 'State', ''].forEach(function (h, i) { hr.appendChild(el('th', i === 3 ? 'num' : '', h)); });
    table.appendChild(hr);
    s.peers.forEach(function (p) {
      var tr = el('tr');
      tr.appendChild(el('td', '', p.name));
      tr.appendChild(el('td', 'addr', p.url));
      var td = el('td');
      td.appendChild(el('span', 'st ' + (p.state === 'online' ? 'ok' : p.state === 'checking' ? '' : 'error'), p.state));
      tr.appendChild(td);
      var actions = el('td', 'num');
      // The picker lists this machine's links, so only those can be opened from here.
      if (!peer) actions.appendChild(button('btn', 'Open', function () { pickInstance(p.name); }));
      if (!unsupported) {
        var armedAt = linkRemoveArmed[p.name];
        var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
        var b = button(armed ? 'btn rm danger' : 'btn rm', armed ? 'Confirm remove' : 'Remove', function () {
          if (!armed) { linkRemoveArmed[p.name] = Date.now(); if (lastStatus) render(lastStatus); return; }
          if (Date.now() - armedAt < REMOVE_DOUBLE_CLICK_MS) return;
          delete linkRemoveArmed[p.name];
          doRemoveLink(p.name, b);
        });
        b.title = armed ? 'Click again: it leaves the Instance picker' : 'Stop showing this machine here';
        actions.appendChild(b);
      }
      tr.appendChild(actions);
      table.appendChild(tr);
    });
  }

  function loadLinkSelf() {
    linkSelfState = 'asking';
    fetch(at('/teamclaude/peer-links'), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // An instance from before this card: no such route.
        if (res.status === 404) return { unsupported: true };
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (j) {
        linkSelfState = j.unsupported ? 'unsupported' : 'done';
        linkSelf = j.self || null;
        fillLinkSelf();
        if (lastStatus) renderLinks(lastStatus);
      })
      // Asked again on a later render, not now: a loop on a proxy that keeps failing helps no one.
      .catch(function () { linkSelfState = 'unasked'; });
  }

  // Prefills what this machine would be called and reached at from the other
  // one, and says up front what stands in the way of linking it back.
  function fillLinkSelf() {
    var opts = linkSelfOptions(linkSelf, pageOrigin());
    var list = document.getElementById('linkSelfUrls');
    list.textContent = '';
    opts.forEach(function (o) { var op = el('option'); op.value = o; list.appendChild(op); });
    var url = document.getElementById('linkSelfUrl');
    if (!url.value && opts.length) url.value = opts[0];
    var name = document.getElementById('linkSelfName');
    if (!name.value && linkSelf && linkSelf.name) name.value = linkSelf.name;
    var notice = linkBackNotice(linkSelf);
    var blocked = document.getElementById('linkBackBlocked');
    blocked.textContent = notice ? notice.text : '';
    blocked.style.display = notice ? '' : 'none';
    var cb = document.getElementById('linkBack');
    var block = !!(notice && notice.block);
    // Ticked only with an address to offer; with none it is still the
    // operator's to tick after typing one in.
    if (block || !opts.length) cb.checked = false;
    cb.disabled = block;
    syncLinkBack();
  }

  function syncLinkBack() {
    document.getElementById('linkBackFields').style.display = document.getElementById('linkBack').checked ? '' : 'none';
  }

  // The card says "this machine" for the machine it manages, which is the
  // linked one when the page shows one.
  function labelLinkCard() {
    if (!peer) return;
    document.getElementById('linkBackText').textContent = 'Link back too: list ' + peer + ' on it, so its dashboard shows ' + peer;
    document.getElementById('linkSelfUrlLabel').textContent = peer + ', as it reaches it';
    document.getElementById('linkSelfNameLabel').textContent = 'Name for ' + peer + ' there';
    document.getElementById('ownKeyLabel').textContent = peer + "'s link, or its proxy key and address, for linking it from another machine's dashboard.";
  }

  function linkStatus(kind, text) {
    var st = document.getElementById('linkStatus');
    st.className = 'st ' + kind;
    st.textContent = text;
  }

  function postPeerLink(step, body) {
    var r = peerLinkRequest(step, body, localStorage.getItem(KEY));
    return fetch(at(r.url), r.init).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
      return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
    });
  }

  function doTestLink(btn) {
    var url = val('linkUrl');
    var apiKey = val('linkKey');
    if (!url || !apiKey) { linkStatus('error', 'Enter its address and its proxy key first.'); return; }
    btn.disabled = true;
    linkStatus('', 'Testing…');
    postPeerLink('test', { url: url, apiKey: apiKey })
      .then(function (j) {
        if (!j) return;
        var out = peerTestOutcome(j);
        linkStatus(out.kind, out.text);
        // Its own name is only a suggestion: naming the link is left to the operator.
        if (j.ok && j.name) document.getElementById('linkName').placeholder = 'e.g. ' + j.name;
        // It cannot take this machine's link, so the form should not offer to send one.
        if (j.ok && j.state === 'online' && !j.linkable) { document.getElementById('linkBack').checked = false; syncLinkBack(); }
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.test + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doAddLink() {
    var body = { name: val('linkName'), url: val('linkUrl'), apiKey: val('linkKey') };
    // The form keeps what it holds, so naming it and clicking Link again is all it takes.
    var missing = linkAddMissing(body);
    if (missing) {
      linkStatus('error', missing);
      if (body.url && body.apiKey) document.getElementById('linkName').focus();
      return;
    }
    var cb = document.getElementById('linkBack');
    if (cb.checked && !cb.disabled) body.linkBack = { name: val('linkSelfName'), url: val('linkSelfUrl') };
    var btn = document.getElementById('linkAdd');
    btn.disabled = true;
    linkStatus('', body.linkBack ? 'Linking both ways…' : 'Linking…');
    postPeerLink('add', body)
      .then(function (j) {
        if (!j) return;
        var out = peerLinkOutcome(j, 'add');
        linkStatus(out.kind, out.text);
        if (j.ok) {
          ['linkPaste', 'linkUrl', 'linkKey', 'linkName'].forEach(function (id) { document.getElementById(id).value = ''; });
          document.getElementById('linkName').placeholder = 'e.g. desktop';
          poll();
        }
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.add + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // A pasted link fills in the address and key; the name is left to the operator.
  // Typing is quiet until the field is left: a half-typed link is not an error yet.
  function useInstanceLink(quiet) {
    var text = val('linkPaste');
    if (!text) return;
    var got = parseInstanceLink(text);
    if (!got && quiet) return;
    if (!got) { linkStatus('error', 'That is not a link from the Linked instances card. Copy it again from the other machine: Settings, Linked instances, Show key, Copy link.'); return; }
    if (val('linkUrl') === got.url && val('linkKey') === got.apiKey) return;
    document.getElementById('linkUrl').value = got.url;
    document.getElementById('linkKey').value = got.apiKey;
    linkStatus('ok', 'Filled in its address and key from the link. Name it, then click Link.');
    document.getElementById('linkName').focus();
  }

  function doRemoveLink(name, btn) {
    btn.disabled = true;
    postPeerLink('remove', { name: name })
      .then(function (j) {
        if (!j) return;
        var out = peerLinkOutcome(j, 'remove');
        linkStatus(out.kind, out.text);
        poll();
      })
      .catch(function (e) { linkStatus('error', PEER_LINK_FAILED.remove + ': ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // The key and a best-guess address, which is what the other machine's form asks for.
  var ownKeyOpen = false;
  function toggleOwnKey(btn) {
    var box = document.getElementById('ownKeyBox');
    if (ownKeyOpen) { ownKeyOpen = false; box.textContent = ''; box.style.display = 'none'; btn.textContent = 'Show key'; return; }
    btn.disabled = true;
    postPeerLink('key', {})
      .then(function (j) {
        if (!j) return;
        box.textContent = '';
        if (!j.ok) {
          box.appendChild(el('div', 'st error', PEER_LINK_FAILED.key + (j.error ? ': ' + j.error : '')));
        } else {
          box.appendChild(el('div', 'lbl', 'Anyone who can see this screen, or has the link, can use the key. On the other machine, under Link another machine, paste the link or enter the address and key.'));
          var opts = linkSelfOptions(linkSelf, pageOrigin());
          var link = opts.length ? instanceLink(opts[0], j.key) : '';
          if (link) snippet(box, 'Link (the address below and the key): paste it under Its link on the other machine', link, 0);
          if (opts.length) snippet(box, 'Address (a best guess: use one the other machine can reach)', opts[0], 0);
          snippet(box, 'Proxy key', j.key, 0);
        }
        box.style.display = '';
        ownKeyOpen = true;
        btn.textContent = 'Hide key';
      })
      .catch(function (e) { box.textContent = ''; box.appendChild(el('div', 'st error', PEER_LINK_FAILED.key + ': ' + e.message)); box.style.display = ''; ownKeyOpen = true; btn.textContent = 'Hide key'; })
      .finally(function () { btn.disabled = false; });
  }

  // The window buttons, built once: the windows are fixed by the server that
  // served this page. Visibility is decided per render, since the control only
  // means something when there is a usage table under it.
  function buildUsageViews() {
    var wrap = document.getElementById('usageViewWrap');
    wrap.appendChild(el('span', 'lbl', 'Usage window'));
    USAGE_VIEWS.forEach(function (v) {
      var btn = el('button', '', v.label);
      btn.addEventListener('click', function () {
        usageView = v.key;
        markUsageView();
        if (lastStatus) render(lastStatus);
      });
      wrap.appendChild(btn);
      usageButtons.push({ key: v.key, btn: btn });
    });
    markUsageView();
  }

  function markUsageView() {
    usageButtons.forEach(function (b) { b.btn.className = b.key === usageView ? 'sel' : ''; });
  }

  // Header cells that re-sort in place. The sort is state, not a re-fetch, so
  // it survives the 5s poll: re-rendering re-reads sortState below.
  function addSortableHeader(tr, table, label, key, numeric) {
    var th = el('th', (numeric ? 'num ' : '') + 'sortable', label + (sortState[table].key === key ? (sortState[table].dir === 'asc' ? ' ▲' : ' ▼') : ''));
    th.addEventListener('click', function () {
      var st = sortState[table];
      if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = key; st.dir = numeric ? 'desc' : 'asc'; }
      if (lastStatus) render(lastStatus);
    });
    tr.appendChild(th);
  }

  // Session and conversation are two columns rather than one composite: sorting
  // by Session brings a fan-out's rows together (the sort is stable, so they
  // stay in recency order inside it) and Conv is the only column that differs
  // between them. Narrow on purpose — it is a digest, not a name.
  var SESSION_COLUMNS = [
    { key: 'session', label: 'Session' },
    { key: 'conversation', label: 'Conv' },
    { key: 'client', label: 'Client' },
    { key: 'project', label: 'Project' },
    { key: 'accounts', label: 'Accounts' },
    { key: 'requests', label: 'Req', num: true },
    { key: 'cacheRead', label: 'Cache read', num: true },
    { key: 'cacheCreation', label: 'Cache write', num: true },
    { key: 'input', label: 'Input', num: true },
    { key: 'output', label: 'Output', num: true },
    { key: 'context', label: 'Context', num: true },
    { key: 'lastSeen', label: 'Last seen', num: true },
  ];

  function renderSessions(sessions) {
    var wrap = document.getElementById('sessionsWrap');
    var empty = document.getElementById('sessionsEmpty');
    // Absent unless proxy.sessionDetail is on — the aggregate counts in the
    // summary line stay either way.
    if (!sessions || !sessions.items) {
      wrap.style.display = 'none';
      empty.style.display = '';
      empty.textContent = ((sessions && sessions.active) || 0) + ' active / ' + ((sessions && sessions.known) || 0)
        + ' known conversations. Set proxy.sessionDetail to true to list them here.';
      return;
    }
    wrap.style.display = '';
    empty.style.display = 'none';

    var all = sessionRows(sessions);
    var projectSel = document.getElementById('fProject');
    var clientSel = document.getElementById('fClient');
    fillFilter(projectSel, uniqSorted(all.map(function (r) { return r.project; })), sessionFilters.project);
    fillFilter(clientSel, uniqSorted(all.map(function (r) { return r.client; })), sessionFilters.client);
    sessionFilters.project = projectSel.value;
    sessionFilters.client = clientSel.value;

    var rows = sortRows(filterSessionRows(all, sessionFilters), sortState.sessions.key, sortState.sessions.dir);
    // Conversations, not sessions: one client session contributes a row per
    // agent it has in flight, and counting rows as sessions would report a
    // fleet carrying several times the clients it has.
    document.getElementById('sessionCount').textContent = rows.length + ' of ' + all.length + ' conversations';

    var table = document.getElementById('sessions');
    table.textContent = '';
    var hr = el('tr');
    SESSION_COLUMNS.forEach(function (c) { addSortableHeader(hr, 'sessions', c.label, c.key, !!c.num); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', r.active ? '' : 'dim', r.session));
      tr.appendChild(el('td', r.active ? '' : 'dim', r.conversation || '—'));
      tr.appendChild(el('td', '', r.client || '—'));
      tr.appendChild(el('td', '', r.project || '—'));
      tr.appendChild(el('td', '', r.accounts || '—'));
      ['requests', 'cacheRead', 'cacheCreation', 'input', 'output', 'context'].forEach(function (k) {
        tr.appendChild(el('td', 'num', fmtNum(r[k])));
      });
      tr.appendChild(el('td', 'num', r.lastSeen ? fmtAgo(r.lastSeen) : '—'));
      table.appendChild(tr);
    });
  }

  function fillFilter(select, values, value) {
    select.textContent = '';
    var all = el('option', '', 'All');
    all.value = '';
    select.appendChild(all);
    values.forEach(function (v) {
      var option = el('option', '', v);
      option.value = v;
      select.appendChild(option);
    });
    select.value = values.indexOf(value) === -1 ? '' : value;
  }

  // One table per configured usage dimension (proxy.usageDimensions).
  function renderDimensions(dimensions) {
    var wrap = document.getElementById('dimensionsWrap');
    wrap.textContent = '';
    Object.keys(dimensions || {}).forEach(function (name) {
      var entries = dimensions[name] || {};
      var rows = Object.keys(entries).map(function (key) {
        var e = entries[key] || {};
        var u = usageFor(e, usageView);
        return {
          name: key,
          requests: u.requests,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          lastUsed: e.lastUsed ? Date.parse(e.lastUsed) : 0,
        };
      });
      if (!rows.length) return;
      sortState[name] = sortState[name] || { key: 'inputTokens', dir: 'desc' };
      rows = sortRows(rows, sortState[name].key, sortState[name].dir);

      wrap.appendChild(el('h2', '', usageHeading(name.charAt(0).toUpperCase() + name.slice(1))));
      var card = el('div', 'card');
      card.style.padding = '4px 6px';
      var table = el('table');
      var hr = el('tr');
      [{ key: 'name', label: name.charAt(0).toUpperCase() + name.slice(1) },
        { key: 'requests', label: 'Req', num: true },
        { key: 'inputTokens', label: 'Input tok', num: true },
        { key: 'outputTokens', label: 'Output tok', num: true },
        { key: 'lastUsed', label: lastUsedLabel(), num: true }].forEach(function (c) {
        addSortableHeader(hr, name, c.label, c.key, !!c.num);
      });
      table.appendChild(hr);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', '', r.name));
        tr.appendChild(el('td', 'num', fmtNum(r.requests)));
        tr.appendChild(el('td', 'num', fmtNum(r.inputTokens)));
        tr.appendChild(el('td', 'num', fmtNum(r.outputTokens)));
        tr.appendChild(el('td', 'num', r.lastUsed ? fmtAgo(r.lastUsed) : '—'));
        table.appendChild(tr);
      });
      card.appendChild(table);
      wrap.appendChild(card);
    });
  }

  // How sessions are spread, as the router resolved it, and drain mode's
  // queue when the server reports one.
  var MODE_TEXT = {
    off: 'off: one account at a time, until it reaches its switch threshold',
    even: 'even: new conversations go to the least-loaded account',
    adaptive: 'adaptive: new conversations go where the quota burns slowest',
    affinity: 'affinity: conversations stay on the account holding their cache',
    drain: 'drain: the account whose weekly quota resets soonest is used until it runs out',
  };
  function renderRouting(s) {
    var card = document.getElementById('modeCard');
    card.textContent = '';
    var sess = s.sessions || {};
    var mode = sess.mode || (sess.distribute ? 'even' : 'off');
    var line = el('div', 'setting');
    var d = el('div');
    d.appendChild(el('b', '', 'Session distribution'));
    d.appendChild(el('span', 'tag', MODE_TEXT[mode] || mode));
    line.appendChild(d);
    line.appendChild(el('span', 'tag', 'Set with teamclaude distribute <mode>'));
    card.appendChild(line);
    var thr = el('div', 'setting');
    var t = el('div');
    t.appendChild(el('b', '', 'Switch threshold'));
    t.appendChild(el('span', 'tag', thresholdPercentText(s.switchThreshold) + '% of a quota window' + (s.expiryRouting && s.expiryRouting.enabled ? ' · expiry-pressure routing on' : '')));
    thr.appendChild(t);
    card.appendChild(thr);
    Object.keys(s.drainQueue || {}).forEach(function (provider) {
      var q = s.drainQueue[provider] || [];
      var row = el('div', 'setting');
      var c = el('div');
      c.appendChild(el('b', '', providerLabel(provider) + ' drain order'));
      c.appendChild(el('span', 'tag', q.length ? q.join(' → ') : 'no account can serve right now'));
      row.appendChild(c);
      card.appendChild(row);
    });
    renderRoutes(s);
  }

  // Where each metered family goes right now, and which accounts could take
  // it. The last row is the default: everything without its own route lands
  // on the current account.
  function renderRoutes(s) {
    var wrap = document.getElementById('routesWrap');
    var rows = routeRows(s);
    if (!rows.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var table = document.getElementById('routes');
    table.textContent = '';
    var hr = el('tr');
    ['Family', 'Goes to', 'Can serve it'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    rows.forEach(function (r) {
      var tr = el('tr');
      var fam = el('td', '', r.label + (r.match ? ' ' : ''));
      if (r.match) fam.appendChild(el('span', 'tag', r.match));
      if (r.provider) fam.appendChild(el('span', 'tag', ' ' + providerLabel(r.provider)));
      tr.appendChild(fam);
      var to = el('td', r.blocked ? 'badt' : '', r.blocked ? 'blocked' : (r.target || '—'));
      if (r.pinned) to.appendChild(el('span', 'pin', ' · pinned to ' + r.pinned));
      if (r.pinMismatch) to.appendChild(el('span', 'warnt', ' (not eligible)'));
      if (r.kind === 'default' && r.target !== r.current) {
        to.appendChild(el('span', 'warnt', r.currentUnavailable
          ? ' · current account ' + r.current + ' is blocked: ' + (UNAVAILABLE_TEXT[r.currentUnavailable] || r.currentUnavailable)
          : ' · outranks the current account ' + r.current));
      }
      tr.appendChild(to);
      var can = el('td', r.kind === 'default' ? 'dim' : '');
      if (r.kind === 'default') can.textContent = 'no route of its own';
      else if (r.blocked) can.textContent = '—';
      else if (!r.eligible.length && !r.ineligible.length) can.textContent = '—';
      else {
        can.appendChild(el('span', 'ok', r.eligible.length + ' of ' + (r.eligible.length + r.ineligible.length) + (r.ineligible.length ? ' ' : '')));
        if (r.ineligible.length) can.appendChild(el('span', 'no', r.ineligible.join(', ')));
      }
      tr.appendChild(can);
      table.appendChild(tr);
    });
  }

  // The banner over every page, only when something is wrong — a banner that
  // is always on is a banner nobody reads — and the same list on the Problems
  // page, where it is not repeated as a banner.
  function renderProblems(s) {
    var list = problems(s);
    var wrap = document.getElementById('problems');
    var page = document.getElementById('problemList');
    wrap.textContent = '';
    page.textContent = '';
    list.forEach(function (p) {
      wrap.appendChild(el('div', p.severity, p.text));
      page.appendChild(el('div', p.severity, p.text));
    });
    if (!list.length) page.appendChild(el('p', 'sub', 'Nothing needs attention.'));
    wrap.style.display = list.length && currentPage !== 'problems' ? 'block' : 'none';
    setCount('problems', list.length, true);
  }

  function setCount(page, n, bad) {
    var c = navCounts[page];
    if (!c) return;
    c.textContent = String(n);
    c.className = bad ? 'count bad' : 'count';
    c.style.display = n ? '' : 'none';
  }

  function buildLogFilters() {
    var box = document.getElementById('logKinds');
    LOG_KINDS.forEach(function (k) {
      var chip = button('chip', k.label, function () {
        logFilters.kind = k.key;
        renderLogs();
      });
      box.appendChild(chip);
      logChips.push({ key: k.key, btn: chip });
    });
    var provider = document.getElementById('logProvider');
    fillFilter(provider, [], '');
    [['anthropic', 'Claude'], ['codex', 'Codex']].forEach(function (p) {
      var option = el('option', '', p[1]);
      option.value = p[0];
      provider.appendChild(option);
    });
    provider.addEventListener('change', function () { logFilters.provider = this.value; renderLogs(); });
    document.getElementById('logAccount').addEventListener('change', function () { logFilters.account = this.value; renderLogs(); });
  }

  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  // Newest first, and at most the newest 500 drawn: the page holds the whole
  // log, but a table of thousands of rows rebuilt every few seconds would make
  // the page the slowest thing on the machine.
  function renderLogs() {
    logChips.forEach(function (c) { c.btn.className = c.key === logFilters.kind ? 'chip sel' : 'chip'; });
    var accSel = document.getElementById('logAccount');
    fillFilter(accSel, uniqSorted(logState.events.map(function (e) { return e.account; })), logFilters.account);
    logFilters.account = accSel.value;
    var rows = filterLogEvents(logState.events, logFilters).slice().reverse();
    document.getElementById('logCount').textContent = (logError ? 'cannot read the log: ' + logError + ' · ' : '')
      + rows.length + ' of ' + logState.events.length + ' events';
    var table = document.getElementById('logs');
    table.textContent = '';
    var hr = el('tr');
    ['Time', 'Kind', 'Account', 'Client', 'Event', 'Details'].forEach(function (h) { hr.appendChild(el('th', '', h)); });
    table.appendChild(hr);
    if (!rows.length) {
      var tr0 = el('tr');
      var td0 = el('td', 'dim', logState.events.length ? 'No events match these filters.' : 'No events yet.');
      td0.colSpan = 6;
      tr0.appendChild(td0);
      table.appendChild(tr0);
      return;
    }
    rows.slice(0, 500).forEach(function (e) {
      var tr = el('tr', logEventTone(e));
      tr.appendChild(el('td', 'when', fmtWhen(e.at)));
      var kind = LOG_KINDS.filter(function (k) { return k.key === e.kind; })[0];
      tr.appendChild(el('td', 'kind', (kind ? kind.label : e.kind) + (e.provider ? ' · ' + providerLabel(e.provider) : '')));
      tr.appendChild(el('td', '', e.account || '—'));
      tr.appendChild(el('td', 'client', logEventClient(e) || '—'));
      var ev = el('td', 'ev', e.message);
      if (e.prompt) ev.appendChild(el('div', 'prompt', '“' + e.prompt + '”'));
      tr.appendChild(ev);
      tr.appendChild(el('td', 'detail', logEventDetail(e)));
      table.appendChild(tr);
    });
  }

  function pollLogs() {
    // The status poll asks for the logs again once the check is through.
    if (logsInFlight || (peer && !peerChecked)) return;
    logsInFlight = true;
    var held = logState.events;
    var after = held.length ? held[held.length - 1].id : 0;
    var again = false;
    fetch(at('/teamclaude/logs?after=' + after), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      })
      .then(function (page) {
        if (!page) return;
        logState = mergeLogEvents(logState, page, LOG_CAP);
        again = logState.refetch;
        logError = null;
        renderLogs();
      })
      .catch(function (e) { logError = e.message; renderLogs(); })
      // A restarted server's log is read again from its start, now rather
      // than at the next poll.
      .finally(function () { logsInFlight = false; if (again) pollLogs(); });
  }

  function render(s) {
    lastStatus = s;
    // The poll owns the threshold field except while it is being typed into:
    // rewriting it every POLL_MS would delete the operator's half-entered
    // number under the cursor. It also means a change made from the CLI, the
    // TUI or another browser shows up here without a refresh.
    var thrInput = document.getElementById('thrVal');
    if (document.activeElement !== thrInput) thrInput.value = thresholdPercentText(s.switchThreshold);
    // Kept visible read-only: the number still tells a client where the fleet switches.
    var canThreshold = callerCan(s.caller, '/teamclaude/threshold');
    thrInput.disabled = !canThreshold;
    document.getElementById('thrSet').style.display = canThreshold ? '' : 'none';
    // Rebuilt from the status unless it is open or saving, like the threshold
    // field, so a change made from the CLI or the TUI shows up here without a
    // refresh.
    var probeSel = document.getElementById('probeEvery');
    // ponytail: a status read that started before a save and lands after it
    // still shows the old interval until the next poll; cosmetic, nothing is lost.
    if (document.activeElement !== probeSel && !probeSaving) {
      var probeSecs = (s.probe || {}).intervalSeconds || 0;
      probeSel.textContent = '';
      probeIntervalOptions(probeSecs).forEach(function (o) {
        var opt = el('option', '', o.label);
        opt.value = String(o.value);
        probeSel.appendChild(opt);
      });
      probeSel.value = String(probeSecs);
    }
    probeSel.disabled = !callerCan(s.caller, '/teamclaude/probe-interval');
    // Only the operator is told the name, and a proxy too old to have one
    // says nothing, so the row is there only when there is a name to change.
    var inst = s.instance;
    document.getElementById('nameRow').style.display = inst ? '' : 'none';
    var nameInput = document.getElementById('nameVal');
    if (inst && document.activeElement !== nameInput) {
      nameInput.value = inst.custom ? inst.name : '';
      nameInput.placeholder = inst.host || '';
    }
    var notice = callerNotice(s.caller);
    document.getElementById('callerText').textContent = notice || '';
    document.getElementById('caller').style.display = notice ? 'block' : 'none';
    var sess = s.sessions || {};
    var up = s.server && s.server.uptimeSeconds != null ? 'up ' + fmtIn(s.server.uptimeSeconds) : '';
    var sum = document.getElementById('summary');
    sum.textContent = '';
    var currentAccounts = s.currentAccounts || null;
    var providerIds = currentAccounts ? Object.keys(currentAccounts).sort(function (a, b) {
      if (a === 'anthropic') return -1;
      if (b === 'anthropic') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    }) : [];
    sum.appendChild(el('span', '', providerIds.length ? 'active accounts ' : 'active account '));
    if (providerIds.length) {
      providerIds.forEach(function (provider, i) {
        if (i) sum.appendChild(el('span', '', ' · '));
        sum.appendChild(el('span', '', providerLabel(provider) + ': '));
        sum.appendChild(el('b', '', currentAccounts[provider] || 'none'));
      });
    } else {
      sum.appendChild(el('b', '', s.currentAccount || 'none'));
    }
    // Conversations, like the Sessions table and the count above it: one page
    // saying "sessions" here and "conversations" there would read as two
    // different quantities rather than one counted twice.
    sum.appendChild(el('span', '', ' · ' + (sess.active || 0) + ' active / ' + (sess.known || 0) + ' known conversations' + (up ? ' · ' + up : '')));
    var probe = s.probe || {};
    var probeBtn = document.getElementById('probe');
    probeBtn.textContent = probe.running ? 'Probe running…' : 'Probe quotas';
    probeBtn.disabled = !!probe.running;
    renderQuota(s);
    renderAccountsPage(s);
    renderProblems(s);
    renderRouting(s);
    renderClientKeys(s);
    renderLinks(s);
    renderClients(s.clients);
    renderDimensions(s.usageDimensions);
    // The control means nothing with no usage table under it. The payload
    // already answers that: the server omits a dimension with no entries.
    var anyUsage = Object.keys(s.clients || {}).length || Object.keys(s.usageDimensions || {}).length;
    document.getElementById('usageViewWrap').style.display = anyUsage ? '' : 'none';
    document.getElementById('clientsEmpty').style.display = anyUsage ? 'none' : '';
    renderSessions(s.sessions);
    setCount('sessions', sess.active || 0, false);
    setCount('accounts', (s.accounts || []).length, false);
    document.getElementById('foot').textContent = 'refreshes every ' + (POLL_MS / 1000) + 's · ' + new Date().toLocaleTimeString();
  }

  // An account action reports beside its own row, where the click was: the
  // page-wide note sits above everything and is off screen for a row further down.
  // No prototype: an account named __proto__ would otherwise set it.
  var cardNotes = Object.create(null);
  // With now set it re-renders at once, for a failure no poll follows. Otherwise the
  // poll the caller starts shows it: re-rendering the stale status here would
  // rebuild the row and re-enable a switch button that must stay disabled
  // until the poll reports the switch.
  function cardNote(key, kind, text, now) {
    cardNotes[key] = { kind: kind, text: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text, at: Date.now() };
    if (now && lastStatus) render(lastStatus);
  }

  function note(kind, text) {
    var n = document.getElementById('note');
    n.className = kind;
    n.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' · ' + text;
    n.style.display = 'block';
  }

  // One manual switch. The endpoint is a nudge, not a pin: it sets the current
  // account and normal rotation resumes from there (see the handler's comment
  // in server.js for what "eligible" means).
  function doSwitch(name, noteKey, btn) {
    btn.disabled = true;
    var r = switchRequest(name, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = switchOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        // Re-enabled on any non-success, whether the server refused or the
        // fetch threw, so the two failure paths leave the button in one state.
        if (out.kind !== 'ok') btn.disabled = false;
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'switch failed: ' + e.message, true); btn.disabled = false; });
  }

  function doControlAccount(name, noteKey, spec, btn) {
    btn.disabled = true;
    var r = accountControlRequest(name, spec, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = accountControlOutcome(json, spec);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'change failed: ' + e.message, true); })
      // Unlike doSwitch, always re-enabled: the row is rebuilt by the poll
      // above, and a button that stayed dead after a refused change would be
      // the only control an operator could not retry.
      .finally(function () { btn.disabled = false; });
  }

  // Remove armed by a first click, by card, and how long the arming lasts.
  // No prototype: an account named __proto__ would otherwise set it.
  var removeArmed = Object.create(null);
  var REMOVE_CONFIRM_MS = 8000;
  var REMOVE_DOUBLE_CLICK_MS = 400;

  // "Reset usage" armed by a first click, by card, as Remove is: the second
  // click spends a reset, and there is no getting it back. Cards with a reset
  // in flight stay disabled across the polls that rebuild them.
  var resetArmed = Object.create(null);
  var resetBusy = Object.create(null);

  function resetsLeftText(n) {
    return n ? n + (n === 1 ? ' reset left' : ' resets left') : 'no resets left';
  }

  function resetButton(account, key) {
    if (resetBusy[key]) {
      var busy = button('btn codex', 'Resetting…', function () {});
      busy.disabled = true;
      return busy;
    }
    var armedAt = resetArmed[key];
    var armed = armedAt != null && Date.now() - armedAt < REMOVE_CONFIRM_MS;
    var b = button(armed ? 'btn codex danger' : 'btn codex', armed ? 'Confirm reset' : 'Reset usage', function () {
      // Read afresh: what the button showed when it was drawn may be stale.
      var now = Date.now();
      var step = resetClickStep(resetArmed[key], now, REMOVE_CONFIRM_MS, REMOVE_DOUBLE_CLICK_MS);
      if (step === 'wait') return;
      if (step === 'arm') { resetArmed[key] = now; if (lastStatus) render(lastStatus); return; }
      delete resetArmed[key];
      doRedeemReset(account, key);
    });
    b.title = armed
      ? 'Click again to spend one free reset on ' + account.name
      : 'Clear the spent usage limits on this account with one of its free resets';
    return b;
  }

  // Spend one reset now. The request waits for the redemption and the quota
  // re-read after it, so the poll that follows shows the cleared bars.
  function doRedeemReset(account, noteKey) {
    resetBusy[noteKey] = true;
    if (lastStatus) render(lastStatus);
    var r = redeemResetRequest(account, localStorage.getItem(KEY));
    // Every way of NOT reading the server's verdict — the request rejected,
    // the body unreadable — is reported as uncertain: the server may have
    // spent the credit before the answer was lost, and "failed" would invite
    // spending another. Only a refused key (401) is known to have spent nothing.
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return undefined; }
        return res.json().catch(function () { return null; });
      }, function () { return null; })
      .then(function (json) {
        delete resetBusy[noteKey];
        if (json === undefined) { if (lastStatus) render(lastStatus); return; }
        var out = redeemResetOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      });
  }

  // The account leaves TeamClaude: the running fleet and the config file,
  // credentials included. Nothing is revoked upstream, so the login keeps
  // working wherever else it is signed in.
  function doRemove(account, noteKey, btn) {
    btn.disabled = true;
    var r = removeRequest(account, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = removeOutcome(json);
        // The page-wide note: on success the row this would sit on is gone.
        if (out.kind === 'ok') note(out.kind, out.text);
        else cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'remove failed: ' + e.message, true); })
      .finally(function () { btn.disabled = false; });
  }

  // The dashboard's one sign-in (the server runs one at a time): which
  // provider, the server's id for it once started, and what the panel shows.
  // seq tells a reply from a sign-in that has since been replaced.
  var signIn = null;
  var signInSeq = 0;
  var signInTimer = null;
  var SIGN_IN_POLL_MS = 2000;
  var SIGN_IN_LABEL = { claude: 'Claude', codex: 'Codex' };

  function pageHost() {
    // A linked instance is another machine whatever its address says: one
    // reached over an SSH tunnel at 127.0.0.1 still runs its sign-in callback
    // listener over there, out of this browser's reach.
    if (peer) return '';
    return typeof location !== 'undefined' ? location.hostname : '';
  }

  function signInFetch(step, body) {
    var r = signInRequest(step, body, localStorage.getItem(KEY));
    return fetch(at(r.url), r.init).then(function (res) {
      if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
      return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
    });
  }

  function stopSignInPoll() {
    if (signInTimer) { clearInterval(signInTimer); signInTimer = null; }
  }

  // who is the account a Sign in again button stands on, so the panel can
  // say which login to use; null for a new account. A sign-in already under
  // way keeps its panel until the server has taken the new one: it refuses
  // while the last one is finishing, and that one's outcome must still show.
  function startSignIn(provider, who) {
    var prev = signIn && signIn.id && !signIn.done ? signIn : null;
    var seq = ++signInSeq;
    var next = { seq: seq, provider: provider, who: who, id: null, plan: null, done: false, pasteError: null, notice: null, status: { kind: '', text: 'Starting the sign-in…' } };
    showPage('accounts');
    if (!prev) {
      stopSignInPoll();
      signIn = next;
      renderSignIn();
    }
    var refused = function (text) {
      if (seq !== signInSeq) return;
      if (prev && signIn === prev) {
        prev.notice = text;
        renderSignIn();
        return;
      }
      if (signIn !== next) return;
      next.done = true;
      next.status = { kind: 'error', text: text };
      renderSignIn();
    };
    signInFetch('start', { provider: provider })
      .then(function (json) {
        if (!json) return;
        if (json.ok !== true) { refused('The sign-in could not start' + (json.error ? ': ' + json.error : '')); return; }
        if (seq !== signInSeq) return;
        stopSignInPoll();
        signIn = next;
        next.id = json.id;
        next.plan = signInPlan(json, pageHost());
        next.status = { kind: '', text: 'Waiting for you to sign in…' };
        renderSignIn();
        signInTimer = setInterval(pollSignIn, SIGN_IN_POLL_MS);
      })
      .catch(function (e) { refused('The sign-in could not start: ' + e.message); });
  }

  function pollSignIn() {
    if (!signIn || !signIn.id || signIn.done) { stopSignInPoll(); return; }
    var seq = signIn.seq;
    signInFetch('status', { id: signIn.id })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq || signIn.done) return;
        var out = signInStatusOutcome(json, SIGN_IN_LABEL[signIn.provider]);
        if (!out.done) { setSignInStatus(out); return; }
        stopSignInPoll();
        if (out.kind === 'ok') {
          signIn = null;
          renderSignIn();
          note('ok', out.text);
          poll();
          return;
        }
        signIn.done = true;
        signIn.status = out;
        renderSignIn();
      })
      // A missed poll is retried by the next one.
      .catch(function () {});
  }

  function submitSignInCode(input, btn) {
    if (!signIn || !signIn.id) return;
    var code = input.value.trim();
    if (!code) { signIn.pasteError = 'Paste the ' + (signIn.provider === 'codex' ? 'address' : 'code') + ' first.'; renderSignIn(); return; }
    var seq = signIn.seq;
    btn.disabled = true;
    signInFetch('code', { id: signIn.id, code: code })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq) return;
        if (json.ok !== true) {
          signIn.pasteError = json.error || 'that could not be used';
          renderSignIn();
          return;
        }
        signIn.pasteError = null;
        signIn.pasted = true;
        renderSignIn();
        pollSignIn();
      })
      .catch(function (e) {
        if (!signIn || signIn.seq !== seq) return;
        signIn.pasteError = 'could not send it: ' + e.message;
        renderSignIn();
      })
      .finally(function () { btn.disabled = false; });
  }

  // Close the panel, cancelling a sign-in still waiting. One whose code has
  // arrived cannot be cancelled (the server says cancelled: false): the panel
  // stays and follows it to the end, since an account is stored either way.
  function closeSignIn() {
    if (!signIn) return;
    if (!signIn.id || signIn.done) {
      stopSignInPoll();
      signIn = null;
      renderSignIn();
      return;
    }
    var seq = signIn.seq;
    signInFetch('cancel', { id: signIn.id })
      .then(function (json) {
        if (!json || !signIn || signIn.seq !== seq) return;
        if (json.ok === true && json.cancelled === false) {
          signIn.notice = 'The code has already arrived, so this sign-in can no longer be cancelled. It is being finished.';
          renderSignIn();
          pollSignIn();
          return;
        }
        if (json.ok !== true) {
          signIn.notice = 'Could not cancel' + (json.error ? ': ' + json.error : '');
          renderSignIn();
          return;
        }
        stopSignInPoll();
        signIn = null;
        renderSignIn();
      })
      .catch(function (e) {
        if (!signIn || signIn.seq !== seq) return;
        signIn.notice = 'Could not cancel: ' + e.message;
        renderSignIn();
      });
  }

  // Only the status line, while the person may be typing a paste: rebuilding
  // the panel would drop what is in the field.
  var signInStatusEl = null;
  function setSignInStatus(out) {
    if (!signIn) return;
    signIn.status = out;
    if (signInStatusEl) {
      signInStatusEl.className = 'st' + (out.kind ? ' ' + out.kind : '');
      signInStatusEl.textContent = out.text;
    }
  }

  function renderSignIn() {
    var box = document.getElementById('signIn');
    box.textContent = '';
    signInStatusEl = null;
    if (!signIn) { box.style.display = 'none'; return; }
    var p = signIn.provider;
    var label = SIGN_IN_LABEL[p];
    box.className = 'signin ' + p;
    box.style.display = '';
    var head = el('div', 'sh');
    head.appendChild(el('span', 'pdot ' + p));
    head.appendChild(el('span', 'sp', (signIn.who ? 'Sign in to ' + label + ' again' : 'Sign in to ' + label)));
    head.appendChild(button('btn', signIn.done ? 'Close' : 'Cancel', closeSignIn));
    box.appendChild(head);
    var plan = signIn.plan;
    if (plan && !signIn.done) {
      var steps = el('ol');
      var one = el('li', '', signIn.who
        ? 'Open the sign-in page and sign in as ' + signIn.who + '.'
        : 'Open the sign-in page and sign in with the ' + (p === 'codex' ? 'ChatGPT' : 'Claude') + ' account you want to add.');
      var line = el('div', 'line');
      var open = el('a', 'btn ' + p, 'Open sign-in page');
      open.href = plan.href;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      line.appendChild(open);
      // The link itself, to copy to a browser on another device.
      var link = el('input');
      link.readOnly = true;
      link.value = plan.href;
      link.title = 'The sign-in link, to open on another device';
      link.addEventListener('focus', function () { this.select(); });
      line.appendChild(link);
      one.appendChild(line);
      steps.appendChild(one);
      var two = el('li', '', plan.ask);
      var line2 = el('div', 'line');
      var paste = el('input');
      paste.placeholder = p === 'codex' ? 'http://localhost:1455/auth/callback?code=…' : 'Paste the code here';
      paste.autocomplete = 'off';
      paste.spellcheck = false;
      var finish = button('btn primary', 'Finish sign-in', function () { submitSignInCode(paste, finish); });
      paste.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitSignInCode(paste, finish); });
      line2.appendChild(paste);
      line2.appendChild(finish);
      two.appendChild(line2);
      if (signIn.pasteError) two.appendChild(el('div', 'st error', signIn.pasteError));
      steps.appendChild(two);
      box.appendChild(steps);
      if (plan.note) box.appendChild(el('div', 'st warn', plan.note));
      box.appendChild(el('div', 'st', 'Signing in to an account TeamClaude already has refreshes its sign-in instead of adding it twice.'));
    }
    if (signIn.notice) box.appendChild(el('div', 'st warn', signIn.notice));
    var st = signIn.status || { kind: '', text: '' };
    signInStatusEl = el('div', 'st' + (st.kind ? ' ' + st.kind : ''), st.text);
    box.appendChild(signInStatusEl);
    if (signIn.done) {
      var who = signIn.who;
      var provider = p;
      box.appendChild(button('btn ' + p, 'Try again', function () { startSignIn(provider, who); }));
    }
  }

  // One account's quota, read now from the zero-spend usage endpoint. The
  // request waits for the probe, so the poll after it shows the new bars.
  function doRefreshQuota(account, noteKey, btn) {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    var r = refreshQuotaRequest(account, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = refreshQuotaOutcome(json);
        cardNote(noteKey, out.kind, out.text, false);
        poll();
      })
      .catch(function (e) { cardNote(noteKey, 'error', 'quota refresh failed: ' + e.message, true); });
  }

  // The one control here that writes a setting rather than nudging the running
  // fleet: the server saves it to the config file and reloads, so it holds
  // across a restart. One number governs every quota bucket — a fleet using
  // per-bucket thresholds is told what the save dropped (thresholdOutcome).
  function doThreshold(btn) {
    var input = document.getElementById('thrVal');
    var raw = input.value.trim();
    // Left to the server otherwise: an empty field is the one case it would see
    // as a missing key rather than a bad number, and "invalid request body" is
    // not what an operator who cleared the box needs to read.
    if (!raw) { note('error', 'switch threshold: enter a percentage from 1 to 100'); return; }
    btn.disabled = true;
    var r = thresholdRequest(Number(raw), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = thresholdOutcome(json);
        note(out.kind, out.text);
        // The stored number, not the typed one: the setting is quantised to
        // tenths, and a field left reading 97.55 after a save of 97.6 invites a
        // re-save that changes nothing.
        if (json.ok) input.value = thresholdPercentText(json.switchThreshold);
        poll();
      })
      .catch(function (e) { note('error', 'switch threshold change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  function doInstanceName(btn) {
    var input = document.getElementById('nameVal');
    btn.disabled = true;
    var r = instanceNameRequest(input.value.trim(), localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = instanceNameOutcome(json);
        note(out.kind, out.text);
        if (json.ok) input.value = json.custom ? json.name : '';
        poll();
      })
      .catch(function (e) { note('error', 'instance name change failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // Saved on pick: a select has no half-entered state to protect, so a Set
  // button would only be a second click. The select is neither disabled nor
  // blurred while it saves: either would drop keyboard focus, and arrowing
  // through the choices fires one change per step. Steps that land while a save
  // is in flight are coalesced into one save of the latest choice, so the
  // requests can't arrive out of order and leave an earlier step on disk. The
  // choice is kept in probeWanted rather than re-read from the select, which a
  // poll may have rewritten by then (render leaves it alone only while it has
  // focus or a save is running).
  var probeSaving = false, probeWanted = null;
  function doProbeInterval(sel) {
    probeWanted = Number(sel.value);
    if (!probeSaving) saveProbeInterval(sel);
  }

  function saveProbeInterval(sel) {
    var seconds = probeWanted;
    probeWanted = null;
    probeSaving = true;
    var r = probeIntervalRequest(seconds, localStorage.getItem(KEY));
    fetch(at(r.url), r.init)
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        var out = probeIntervalOutcome(json);
        note(out.kind, out.text);
        // A focused select is left alone by the poll, so a refused choice would
        // otherwise stay on screen as if it applied. A newer pick waiting to be
        // sent is left showing instead: it is about to be saved.
        if (!json.ok && probeWanted === null) sel.value = String(((lastStatus || {}).probe || {}).intervalSeconds || 0);
      })
      .catch(function (e) { note('error', 'quota refresh change failed: ' + e.message); })
      .finally(function () {
        probeSaving = false;
        if (probeWanted !== null) saveProbeInterval(sel); else poll();
      });
  }

  function doControl(path, label, btn) {
    btn.disabled = true;
    fetch(at(path), { method: 'POST', headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return null; }
        return res.json().catch(function () { return { ok: false, error: 'status ' + res.status }; });
      })
      .then(function (json) {
        if (!json) return;
        if (json.ok !== true) { note('error', label + ' failed' + (json.error ? ': ' + json.error : '')); return; }
        note('ok', label + ' complete');
        poll();
      })
      .catch(function (e) { note('error', label + ' failed: ' + e.message); })
      .finally(function () { btn.disabled = false; });
  }

  // The instance picker: this machine and the linked ones it lists, each with
  // what it last answered. Hidden while there is nothing to pick.
  function renderInstances(list, self) {
    var selfName = selfInstanceLabel(self);
    document.getElementById('instanceBack').textContent = 'Back to ' + (self && self.name ? self.name : 'this machine');
    var peers = Array.isArray(list) ? list : [];
    var box = document.getElementById('instances');
    box.style.display = peers.length || peer ? '' : 'none';
    var shown = null;
    peers.forEach(function (p) { if (p.name === peer) shown = p; });
    // Gone from the config (or renamed): back to the machine that is certainly here.
    if (peer && Array.isArray(list) && !shown) { pickInstance(''); return; }
    peerUrl = shown ? shown.url : '';
    var sel = document.getElementById('instance');
    if (document.activeElement !== sel) {
      sel.textContent = '';
      var here = el('option', '', selfName);
      here.value = '';
      sel.appendChild(here);
      peers.forEach(function (p) {
        var o = el('option', '', p.name + (p.state === 'online' ? '' : ' (' + p.state + ')'));
        o.value = p.name;
        sel.appendChild(o);
      });
      sel.value = peer;
    }
    var noteBox = document.getElementById('instanceNote');
    noteBox.style.display = peer ? '' : 'none';
    if (peer) document.getElementById('instanceText').textContent = 'Showing ' + peer + (peerUrl ? ' (' + peerUrl + ')' : '') + ', reached through ' + (self && self.name ? self.name : 'this machine') + '.';
  }

  // Showing a linked instance, this machine is asked first: that read is what
  // proves the key the page holds, and it lists the instances to pick from, so
  // the picker (and the way back) is there even while the one shown is down.
  // Resolves whether the instance shown should be asked next.
  function pollInstances() {
    return fetch('/teamclaude/peers', { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        if (res.status === 401) { localStorage.removeItem(KEY); showKeybox(); return false; }
        // A valid key that may not reach linked instances (a client key), or
        // the loopback exemption refusing a key-less page: either way this
        // machine's own page is the one to show, and it handles the rest.
        if (res.status === 403) { pickInstance(''); return false; }
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json().then(function (j) {
          document.getElementById('keybox').style.display = 'none';
          document.getElementById('app').style.display = '';
          renderInstances(j.peers, j.self);
          peerChecked = !!peer;
          return peerChecked;
        });
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = 'Cannot reach the proxy: ' + e.message;
        if (document.getElementById('keybox').style.display !== 'block') document.getElementById('app').style.display = '';
        return false;
      });
  }

  function showKeybox() {
    if (timer) { clearInterval(timer); timer = null; }
    peerChecked = false;
    document.getElementById('app').style.display = 'none';
    document.getElementById('keybox').style.display = 'block';
    document.getElementById('key').focus();
  }

  function poll() {
    if (holdPoll) return;
    if (peer) { pollInstances().then(function (ok) { if (ok) pollStatus(); }); return; }
    pollStatus();
  }

  function pollStatus() {
    fetch(at('/teamclaude/status'), { headers: { 'x-api-key': localStorage.getItem(KEY) || '' } })
      .then(function (res) {
        // 403 is the loopback exemption refusing a key-less request (a Host
        // that does not name this machine, e.g. behind a local reverse proxy
        // that adds no forwarding headers). A valid key clears that gate too.
        if (res.status === 401 || res.status === 403) { localStorage.removeItem(KEY); showKeybox(); return null; }
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'status ' + res.status); });
        }
        return res.json();
      })
      .then(function (s) {
        if (!s) return;
        // A linked instance's status lists ITS peers; the picker lists ours.
        if (!peer) renderInstances(s.peers, s.instance);
        document.getElementById('keybox').style.display = 'none';
        document.getElementById('app').style.display = '';
        document.getElementById('err').style.display = 'none';
        render(s);
        if (currentPage === 'logs') pollLogs();
      })
      .catch(function (e) {
        var err = document.getElementById('err');
        err.style.display = 'block';
        err.textContent = peer ? e.message : 'Cannot reach the proxy: ' + e.message;
        // The banner lives inside #app, which stays hidden until a first
        // status lands; without this a first poll that fails is a blank page.
        if (document.getElementById('keybox').style.display !== 'block') document.getElementById('app').style.display = '';
      });
  }

  function start() {
    poll();
    if (!timer) timer = setInterval(poll, POLL_MS);
  }

  function buildNav() {
    var nav = document.getElementById('nav');
    var section = null;
    PAGES.forEach(function (p) {
      if (p.section !== section) {
        section = p.section;
        nav.appendChild(el('div', 'navsec', section));
      }
      var b = button('navbtn', p.label, function () { showPage(p.key); });
      var c = el('span', 'count');
      c.style.display = 'none';
      b.appendChild(c);
      nav.appendChild(b);
      navButtons[p.key] = b;
      navCounts[p.key] = c;
    });
  }

  // The page is in the URL's fragment, so a reload or a bookmark comes back to
  // it; read and written only where there is a location to read (not in the
  // test harness that boots this script).
  function showPage(key) {
    var page = PAGES.filter(function (p) { return p.key === key; })[0] || PAGES[0];
    currentPage = page.key;
    PAGES.forEach(function (p) {
      document.getElementById('page-' + p.key).style.display = p.key === page.key ? '' : 'none';
      navButtons[p.key].className = p.key === page.key ? 'navbtn sel' : 'navbtn';
    });
    document.getElementById('pageTitle').textContent = page.label;
    if (typeof location !== 'undefined' && typeof history !== 'undefined' && location.hash !== '#' + page.key) {
      try { history.replaceState(null, '', '#' + page.key); } catch (e) { /* a sandboxed frame: the page still switches */ }
    }
    if (lastStatus) renderProblems(lastStatus);
    if (page.key === 'logs') { renderLogs(); pollLogs(); }
    if (page.key === 'settings' && lastStatus) renderLinks(lastStatus);
  }

  document.getElementById('go').addEventListener('click', function () {
    var v = document.getElementById('key').value.trim();
    if (!v) return;
    localStorage.setItem(KEY, v);
    start();
  });
  document.getElementById('key').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('go').click();
  });
  // Theme: system → light → dark → system. "system" is the absence of a
  // stored choice, so a viewer who never touches this keeps following their
  // desktop, and one who does is not re-decided for by it later.
  var THEMES = ['system', 'light', 'dark'];
  function readTheme() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) { return 'system'; }
  }
  function applyTheme(theme) {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('theme');
    // Name the state, not the action: a button reading "Dark" while the page is
    // light is the ambiguity every theme toggle has, and this one says where it
    // is rather than where it would go.
    btn.textContent = theme === 'system' ? 'Theme: system' : theme === 'light' ? 'Theme: light' : 'Theme: dark';
  }
  function storeTheme(theme) {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage disabled: the choice lasts for this page only */ }
  }
  // The current theme lives in a variable rather than being re-read from
  // storage on each click: with storage blocked, readTheme() would always say
  // 'system' and the button would be stuck on 'light' instead of cycling.
  var theme = readTheme();
  applyTheme(theme);
  document.getElementById('theme').addEventListener('click', function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    storeTheme(theme);
    applyTheme(theme);
  });

  document.getElementById('reload').addEventListener('click', function () { doControl('/teamclaude/reload', 'config reload', this); });
  document.getElementById('probe').addEventListener('click', function () { doControl('/teamclaude/probe', 'quota probe', this); });
  document.getElementById('thrSet').addEventListener('click', function () { doThreshold(this); });
  document.getElementById('nameSet').addEventListener('click', function () { doInstanceName(this); });
  document.getElementById('nameVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doInstanceName(document.getElementById('nameSet')); }
  });
  document.getElementById('probeEvery').addEventListener('change', function () { doProbeInterval(this); });
  // A client key is a valid key, so nothing else on the page would ever ask for
  // another one: the operator needs a way back to the key box.
  function forgetKey() { localStorage.removeItem(KEY); document.getElementById('key').value = ''; showKeybox(); }
  document.getElementById('changeKey').addEventListener('click', forgetKey);
  document.getElementById('instance').addEventListener('change', function () { pickInstance(this.value); });
  document.getElementById('instanceBack').addEventListener('click', function () { pickInstance(''); });
  document.getElementById('forgetKey').addEventListener('click', forgetKey);
  document.getElementById('thrVal').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('thrSet').click();
  });
  buildUsageViews();
  document.getElementById('ckForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('ckName').value.trim();
    if (!name) { ckStatus('error', 'Name the key first: the machine or agent that will use it.'); return; }
    doClientKey('create', name, document.getElementById('ckCreate'));
  });
  document.getElementById('linkForm').addEventListener('submit', function (e) { e.preventDefault(); doAddLink(); });
  document.getElementById('linkTest').addEventListener('click', function () { doTestLink(this); });
  document.getElementById('linkPaste').addEventListener('input', function () { useInstanceLink(true); });
  document.getElementById('linkPaste').addEventListener('change', function () { useInstanceLink(false); });
  document.getElementById('linkBack').addEventListener('change', syncLinkBack);
  document.getElementById('ownKeyShow').addEventListener('click', function () { toggleOwnKey(this); });
  labelLinkCard();
  buildLogFilters();
  buildNav();

  ['fProject', 'fClient'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () {
      sessionFilters[id === 'fProject' ? 'project' : 'client'] = this.value;
      if (lastStatus) render(lastStatus);
    });
  });

  showPage(typeof location !== 'undefined' ? String(location.hash || '').slice(1) : '');
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', function () { showPage(String(location.hash || '').slice(1)); });
  }

  // Poll before asking: a loopback browser is key-exempt, so the prompt is
  // shown only once the server refuses the request without a valid key.
  start();
})();
</script>
</body>
</html>
`;
