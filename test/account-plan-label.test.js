// The plan and backend fields /teamclaude/status adds per account, which the
// dashboard shows as a plan badge and uses to give each backend its own tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, planLabel, backendHost } from '../src/account-manager.js';

test('planLabel reads the Claude tier, then the plan flags, then the Codex plan type', () => {
  assert.equal(planLabel({ rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(planLabel({ rateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(planLabel({ hasClaudeMax: true }), 'Max');
  assert.equal(planLabel({ hasClaudePro: true }), 'Pro');
  assert.equal(planLabel({ quota: { planType: 'plus' } }), 'Plus');
  assert.equal(planLabel({ quota: { planType: 'pro\nforged' } })?.includes('\n'), false);
  assert.equal(planLabel({}), null);
  assert.equal(planLabel(null), null);
});

test('backendHost is the hostname of an API-key account\'s own upstream, and nothing else of the URL', () => {
  assert.equal(backendHost({ type: 'apikey', upstream: 'https://user:secret@API.z.ai/api/anthropic' }), 'api.z.ai');
  assert.equal(backendHost({ type: 'apikey' }), null);
  assert.equal(backendHost({ type: 'oauth', upstream: 'http://127.0.0.1:9' }), null, 'an OAuth override is not a backend');
  assert.equal(backendHost({ type: 'apikey', upstream: 'not a url' }), null);
});

test('status carries plan and backend for each account', () => {
  const am = new AccountManager([
    { name: 'max', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, rateLimitTier: 'default_claude_max_20x' },
    { name: 'glm', type: 'apikey', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.98);
  const byName = Object.fromEntries(am.getStatus().accounts.map(a => [a.name, a]));
  assert.equal(byName.max.plan, 'Max 20x');
  assert.equal(byName.max.backend, null);
  assert.equal(byName.glm.backend, 'api.z.ai');
  assert.equal(JSON.stringify(byName.glm).includes('secret'), false);
});
