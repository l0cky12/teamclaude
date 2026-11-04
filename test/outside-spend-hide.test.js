import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { ConfigOpError, setOutsideSpendHidePercent } from '../src/config-ops.js';
import { OUTSIDE_SPEND_HIDE_DEFAULT, outsideSpendHidePercent } from '../src/outside-spend.js';
import { outsideSpendText, renderStatus } from '../src/status-renderer.js';
import { outsideSpendHideOutcome, outsideSpendHideRequest, renderDashboardHtml } from '../src/dashboard.js';

// `outsideSpendHidePercent`: the share at or below which the "outside" line
// leaves a measured window out, 5 by default, set from the dashboard's
// Outside spend row on Settings (POST /teamclaude/outside-spend-hide). Every
// server test points TEAMCLAUDE_CONFIG (and TEAMROUTER_CONFIG, which wins
// over it) at a throwaway file, so the real config is never touched.

const since = '2026-10-05T08:00:00.000Z';
/** @param {number} share */
const measured = share => ({ share, state: 'measured', since });

// ── the read-out ──────────────────────────────────────────────────────────

test('by default a window at or below 5% is left out, and with every window left out there is no line', () => {
  assert.equal(outsideSpendText({ unified7d: measured(0.04), unified7dFable: measured(0) }), null);
  assert.equal(outsideSpendText({ unified7d: measured(0.05) }), null, '5.0% is at the cut-off');
  assert.equal(outsideSpendText({ unified7d: measured(0.0504) }), null, 'judged as printed: 5.0%');
  assert.equal(outsideSpendText({ unified7d: measured(0.051) }), '5.1% of the week went elsewhere');
  assert.equal(outsideSpendText({ unified7d: measured(0.14), unified7dFable: measured(0) }), '14.0% of the week went elsewhere');
});

test('"no answer" is never hidden, whatever the cut-off', () => {
  assert.equal(outsideSpendText({
    unified7d: measured(0.02),
    unified7dFable: { share: null, state: 'not_measurable', since },
    'scoped:opus': { share: null, state: 'not_observed', since: null },
  }, 100), 'Opus week: not observed (quota probe off?) · Fable week: not measurable');
});

test('the cut-off moves the line, and 0 shows every share', () => {
  const o = { unified7d: measured(0.14), unified7dFable: measured(0) };
  assert.equal(outsideSpendText(o, 0), '14.0% of the week went elsewhere · 0.0% of the Fable week went elsewhere');
  assert.equal(outsideSpendText(o, 14), null);
  assert.equal(outsideSpendText(o, 13.9), '14.0% of the week went elsewhere');
});

test('a missing or bad cut-off is the default, which matches OUTSIDE_SPEND_HIDE_DEFAULT', () => {
  // outsideSpendText writes the 5 out, since the page has no module scope.
  const at = { unified7d: measured(OUTSIDE_SPEND_HIDE_DEFAULT / 100) };
  const above = { unified7d: measured((OUTSIDE_SPEND_HIDE_DEFAULT + 0.1) / 100) };
  for (const cut of [undefined, null, NaN, -1, 101, /** @type {any} */ ('3')]) {
    assert.equal(outsideSpendText(at, cut), null, String(cut));
    assert.notEqual(outsideSpendText(above, cut), null, String(cut));
  }
});

test('teamclaude status hides by the cut-off the status carries', () => {
  const account = { name: 'demo-a@example.com', type: 'apikey', quota: { outsideSpend: { unified7d: measured(0.04) } }, usage: {} };
  assert.doesNotMatch(renderStatus({ accounts: [account] }, { color: false }), /Outside/);
  assert.match(renderStatus({ accounts: [account], outsideSpendHidePercent: 0 }, { color: false }), /Outside\s+4\.0% of the week went elsewhere/);
});

// ── the setting ───────────────────────────────────────────────────────────

test('outsideSpendHidePercent reads the config, and falls back to the default', () => {
  assert.equal(outsideSpendHidePercent({}), OUTSIDE_SPEND_HIDE_DEFAULT);
  assert.equal(outsideSpendHidePercent(null), OUTSIDE_SPEND_HIDE_DEFAULT);
  assert.equal(outsideSpendHidePercent({ outsideSpendHidePercent: 0 }), 0);
  assert.equal(outsideSpendHidePercent({ outsideSpendHidePercent: 12.5 }), 12.5);
  for (const bad of ['5', -1, 101, NaN, null]) {
    assert.equal(outsideSpendHidePercent({ outsideSpendHidePercent: bad }), OUTSIDE_SPEND_HIDE_DEFAULT, String(bad));
  }
});

test('setOutsideSpendHidePercent stores tenths and refuses anything but a 0-100 number', () => {
  const config = {};
  assert.equal(setOutsideSpendHidePercent(config, 7.25), 7.3);
  assert.equal(config.outsideSpendHidePercent, 7.3);
  assert.equal(setOutsideSpendHidePercent(config, 0), 0);
  assert.equal(config.outsideSpendHidePercent, 0);
  for (const bad of [undefined, null, '5', -0.1, 100.1, NaN, Infinity, {}]) {
    const kept = { outsideSpendHidePercent: 5 };
    assert.throws(() => setOutsideSpendHidePercent(kept, bad), ConfigOpError, String(bad));
    assert.equal(kept.outsideSpendHidePercent, 5);
  }
});

// ── the endpoint ──────────────────────────────────────────────────────────

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const ACCTS = [{ name: 'demo-a@example.com', type: 'apikey', apiKey: 'sk-demo-1' }];
const PROXY = { apiKey: 'tc-local', clientKeys: [{ name: 'laptop', key: 'tc-client' }] };

/**
 * A server on a throwaway config file whose reload hook copies
 * `outsideSpendHidePercent` onto the running config, as index.js does. Pass
 * `reload: null` for a server without one.
 */
async function withServer(fn, { reload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-outside-hide-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 3, ...PROXY }, accounts: ACCTS }));
  const saved = { tc: process.env.TEAMCLAUDE_CONFIG, tr: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  const config = { proxy: JSON.parse(JSON.stringify(PROXY)), upstream: 'https://api.anthropic.com' };
  const reloads = { count: 0 };
  const hooks = reload === null ? {} : {
    reload: async () => {
      reloads.count++;
      const disk = JSON.parse(await readFile(path, 'utf-8'));
      if (disk.outsideSpendHidePercent === undefined) delete config.outsideSpendHidePercent;
      else config.outsideSpendHidePercent = disk.outsideSpendHidePercent;
      return {};
    },
  };
  const server = createProxyServer(new AccountManager(ACCTS, 0.98), config, hooks);
  const port = await listen(server);
  try {
    await fn({ port, path, reloads });
  } finally {
    server.closeAllConnections?.();
    server.close();
    for (const [name, value] of [['TEAMCLAUDE_CONFIG', saved.tc], ['TEAMROUTER_CONFIG', saved.tr]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function setCut(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/teamclaude/outside-spend-hide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function status(port, headers = {}) {
  return (await fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers })).json();
}

test('the status carries the default cut-off, to client keys too', async () => {
  await withServer(async ({ port }) => {
    assert.equal((await status(port)).outsideSpendHidePercent, OUTSIDE_SPEND_HIDE_DEFAULT);
    assert.equal((await status(port, { 'x-api-key': 'tc-client' })).outsideSpendHidePercent, OUTSIDE_SPEND_HIDE_DEFAULT);
  });
});

test('a cut-off is saved, reloaded, and is what the status then carries', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const res = await setCut(port, { percent: 12.34 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, outsideSpendHidePercent: 12.3 });
    assert.equal(JSON.parse(await readFile(path, 'utf-8')).outsideSpendHidePercent, 12.3);
    assert.equal(reloads.count, 1);
    assert.equal((await status(port)).outsideSpendHidePercent, 12.3);
    const off = await setCut(port, { percent: 0 });
    assert.deepEqual(await off.json(), { ok: true, outsideSpendHidePercent: 0 });
    assert.equal((await status(port)).outsideSpendHidePercent, 0);
  });
});

test('a refused cut-off leaves the file as it was and does not reload', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    for (const body of [{ percent: -1 }, { percent: 101 }, { percent: '5' }, {}, 'not json']) {
      const res = await setCut(port, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
  });
});

test('a client key cannot change the cut-off, and the page knows to hide the Set button', async () => {
  await withServer(async ({ port, path, reloads }) => {
    const before = await readFile(path, 'utf-8');
    const res = await setCut(port, { percent: 20 }, { 'x-api-key': 'tc-client' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /client key cannot change settings/);
    assert.equal(await readFile(path, 'utf-8'), before);
    assert.equal(reloads.count, 0);
    assert.ok((await status(port, { 'x-api-key': 'tc-client' })).caller.refused.includes('/teamclaude/outside-spend-hide'));
  });
});

test('without a reload hook nothing is written', async () => {
  await withServer(async ({ port, path }) => {
    const before = await readFile(path, 'utf-8');
    const res = await setCut(port, { percent: 20 });
    assert.equal(res.status, 501);
    assert.equal(await readFile(path, 'utf-8'), before);
  }, { reload: null });
});

// ── the dashboard ─────────────────────────────────────────────────────────

test('outsideSpendHideRequest posts the percentage, and outsideSpendHideOutcome says what is hidden', () => {
  const r = outsideSpendHideRequest(7.5, 'tc-k');
  assert.equal(r.url, '/teamclaude/outside-spend-hide');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.headers['x-api-key'], 'tc-k');
  assert.deepEqual(JSON.parse(r.init.body), { percent: 7.5 });
  assert.deepEqual(outsideSpendHideOutcome({ ok: true, outsideSpendHidePercent: 7.5 }), { kind: 'ok', text: 'outside spend at or below 7.5% is now hidden' });
  assert.equal(outsideSpendHideOutcome({ ok: true, outsideSpendHidePercent: 0 }).text, 'outside spend is now shown at every share');
  assert.equal(outsideSpendHideOutcome({ ok: false, error: 'bad' }).text, 'outside spend change failed: bad');
  assert.equal(outsideSpendHideOutcome(null).kind, 'error');
});

test('the page carries the helpers, the Settings row, and passes the cut-off to the read-out', () => {
  const html = renderDashboardHtml();
  for (const fn of [outsideSpendHideRequest, outsideSpendHideOutcome, outsideSpendText]) {
    assert.ok(html.includes(fn.toString()), `${fn.name} not serialized into the page`);
  }
  assert.match(html, /id="ospRow"/);
  assert.match(html, /id="ospVal" type="number" min="0" max="100"/);
  assert.ok(html.includes('outsideSpendText(q.outsideSpend, s.outsideSpendHidePercent)'));
});
