import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// POST /teamclaude/reset-credits/redeem — the dashboard's "Reset usage"
// button. The redeemer behind it is a hook (index.js wires the real one), so
// these tests stand in for it and pin the route: which account it resolves,
// how each outcome maps onto a status, and who may call it at all. Nothing
// here reaches upstream.

/** @param {string} name @param {Record<string, any>} [extra] */
function codex(name, extra = {}) {
  return { name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name, accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

/**
 * A proxy with a fake redeemer, and one POST to the route.
 * @param {{ body?: any, result?: any, hook?: boolean, key?: string, accounts?: any[] }} [opts]
 */
async function redeem({ body = { account: 'a' }, result = { redeemed: true, reason: 'asked', code: 'reset', windowsReset: 1 }, hook = true, key = 'k', accounts = [codex('a'), codex('b')] } = {}) {
  const am = new AccountManager(accounts, 0.98);
  /** @type {string[]} */
  const asked = [];
  const hooks = hook ? {
    redeemCodexReset: async (/** @type {any} */ account) => {
      asked.push(account.name);
      if (result instanceof Error) throw result;
      return result;
    },
  } : {};
  const config = { proxy: { apiKey: 'k', clientKeys: [{ name: 'laptop', key: 'ck' }] }, upstreamProxy: false };
  const proxy = createProxyServer(am, config, hooks);
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(/** @type {any} */ (proxy.address()).port)));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/reset-credits/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json(), asked };
  } finally {
    proxy.closeAllConnections();
    proxy.close();
  }
}

test('a reset that went through is a 200 naming the account and the windows cleared', async () => {
  const r = await redeem();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, account: 'a', code: 'reset', windowsReset: 1 });
  assert.deepEqual(r.asked, ['a']);
});

test('a reset that spent nothing is a 409 carrying the reason and upstream\'s code', async () => {
  const r = await redeem({ result: { redeemed: false, reason: 'upstream declined (nothing_to_reset)', code: 'nothing_to_reset' } });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { ok: false, account: 'a', code: 'nothing_to_reset', error: 'upstream declined (nothing_to_reset)' });
});

test('a reset whose verdict never arrived is a 502 marked uncertain, not a refusal', async () => {
  const r = await redeem({ result: { redeemed: false, reason: 'redeem failed (socket hang up)', uncertain: true } });
  assert.equal(r.status, 502);
  assert.equal(r.json.uncertain, true);
  assert.equal(r.json.ok, false);
});

test('an unknown account is a 404 and reaches no redeemer', async () => {
  const r = await redeem({ body: { account: 'nobody' } });
  assert.equal(r.status, 404);
  assert.deepEqual(r.asked, []);
});

test('a missing account or a malformed body is a 400', async () => {
  assert.equal((await redeem({ body: {} })).status, 400);
  assert.equal((await redeem({ body: 'not json' })).status, 400);
});

test('two accounts under one name are told apart by provider', async () => {
  const accounts = [{ name: 'me', type: 'api', apiKey: 'sk-demo-1' }, codex('me')];
  assert.equal((await redeem({ accounts, body: { account: 'me' } })).status, 400);
  const r = await redeem({ accounts, body: { account: 'me', provider: 'codex' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.asked, ['me']);
});

test('a client key may not spend the operator\'s reset credits', async () => {
  const r = await redeem({ key: 'ck' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'a client key cannot spend reset credits');
  assert.deepEqual(r.asked, []);
});

test('a proxy built without the hook says so', async () => {
  const r = await redeem({ hook: false });
  assert.equal(r.status, 501);
});

test('a redeemer that throws is a 500 that leaks nothing of the error', async () => {
  const r = await redeem({ result: new Error('internal detail') });
  assert.equal(r.status, 500);
  assert.doesNotMatch(JSON.stringify(r.json), /internal detail/);
});
