// A Grok sign-in from the dashboard is a device sign-in: the page shows the
// code and a link, takes no paste, and finishes when the flow does. And a Grok
// account is listed and drawn as its own provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSignIns } from '../src/web-login.js';
import { signInPlan, signInStatusOutcome, accountGroup, groupLabel, providerTone, providerTabs, accountMeters, needsSignIn, fileSignInHint } from '../src/dashboard.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a Grok sign-in hands the page its code, and succeeds when the flow does', async () => {
  /** @type {(v: any) => void} */
  let finish = () => {};
  const signIns = new WebSignIns({
    signIn: (_provider, { onPrompt }) => {
      onPrompt({ provider: 'grok', url: 'https://accounts.example/device?user_code=ABCD-1234', userCode: 'ABCD-1234', remote: false, listening: true, note: null, submit: () => false });
      return new Promise(resolve => { finish = resolve; });
    },
  });
  const start = await signIns.start('grok');
  assert.equal(start.provider, 'grok');
  assert.equal(start.userCode, 'ABCD-1234');
  assert.equal(start.browserUrl, null);
  assert.equal(signIns.status(start.id).state, 'waiting');

  finish({ name: 'grok@example.com', action: 'added' });
  await tick();
  assert.deepEqual(signIns.status(start.id), { state: 'succeeded', provider: 'grok', account: 'grok@example.com', action: 'added', error: null, fileBacked: false });
  assert.deepEqual(signInStatusOutcome({ ok: true, ...signIns.status(start.id) }, 'Grok'), { done: true, kind: 'ok', text: 'Added the Grok account as grok@example.com' });
});

test('the panel shows the code and offers no paste for a Grok sign-in', () => {
  const plan = signInPlan({ provider: 'grok', url: 'https://accounts.example/device?user_code=WXYZ', userCode: 'WXYZ', listening: true }, 'example.net');
  assert.equal(plan.href, 'https://accounts.example/device?user_code=WXYZ');
  assert.equal(plan.code, 'WXYZ');
  assert.equal(plan.auto, true);
  assert.equal(signInPlan({ provider: 'codex', url: 'https://auth.example/', listening: true }, 'example.net').code, undefined);
});

test('a Grok account is its own group, tab and colour, after Claude and Codex', () => {
  const grok = { name: 'g', provider: 'grok', type: 'oauth' };
  assert.equal(accountGroup(grok), 'grok');
  assert.equal(groupLabel('grok'), 'Grok');
  assert.equal(providerTone('grok'), 'grok');
  assert.deepEqual(providerTabs([grok, { name: 'c', provider: 'codex' }, { name: 'a' }]).map(t => t.key), ['all', 'anthropic', 'codex', 'grok']);
});

test('a Grok row draws its plan window, Monthly when the plan is, and no Fable or session slot', () => {
  const reset = Date.now() + 3 * 24 * 3600_000;
  const weekly = accountMeters({ provider: 'grok', quota: { unified7d: 0.4, unified7dReset: reset, sessionWindowStated: false } });
  assert.equal(weekly.slots[0], null);
  assert.equal(weekly.slots[1], null);
  assert.equal(weekly.slots[2].label, '7-day limit');
  const monthly = accountMeters({ provider: 'grok', quota: { unified7d: 0.4, unified7dReset: reset, sessionWindowStated: false, planPeriod: 'monthly' } });
  assert.equal(monthly.slots[2].label, 'Monthly limit');
});

test('a signed-out Grok account is signed in again as Grok, or in Grok Build when its file owns it', () => {
  assert.equal(needsSignIn({ provider: 'grok', type: 'oauth', status: 'error' }), 'grok');
  assert.match(String(fileSignInHint({ provider: 'grok', type: 'oauth', status: 'error', credentialsFromFile: true })), /Grok Build \(grok login\)/);
});
