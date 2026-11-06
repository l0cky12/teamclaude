// Grok shares Anthropic's `/v1/*` namespace upstream, so it is reached on this
// listener under a `/grok` mount that is removed before the request leaves.
// These pin the three things that keep that straight: which requests classify
// as Grok, what path they go upstream on, and whose identity they carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerForPath, providerForRequest, upstreamPathFor, applyAuthHeaders,
  upstreamFor, rewritesBody, canServeProvider, interceptHostsFor, loginCommandFor,
} from '../src/provider.js';
import { clientPassthroughOrigin } from '../src/server.js';

test('the /grok mount selects Grok, and Grok\'s own paths without it stay Anthropic', () => {
  assert.equal(providerForPath('/grok/v1/responses'), 'grok');
  assert.equal(providerForPath('/grok/v1/models'), 'grok');
  assert.equal(providerForPath('/grok/v1/billing?format=credits'), 'grok');
  assert.equal(providerForPath('/grok'), 'grok');
  assert.equal(providerForPath('/v1/responses'), 'anthropic');
  assert.equal(providerForPath('/grokker/v1/responses'), 'anthropic');
});

test('the mount is recognised on the decoded, separator-folded path', () => {
  assert.equal(providerForPath('/grok%2fv1/responses'), 'grok');
  assert.equal(providerForPath('/%67rok/v1/responses'), 'grok');
  assert.equal(providerForPath('/grok\\v1/responses'), 'grok');
  assert.equal(providerForPath('/grok%5cv1/responses'), 'grok');
  // One decode deep: %252f is a literal %2f inside the segment.
  assert.equal(providerForPath('/grok%252fv1/responses'), 'anthropic');
});

test('upstream receives the path without the mount', () => {
  assert.equal(upstreamPathFor('/grok/v1/responses', 'grok'), '/v1/responses');
  assert.equal(upstreamPathFor('/grok/v1/billing?format=credits', 'grok'), '/v1/billing?format=credits');
  assert.equal(upstreamPathFor('/grok', 'grok'), '/');
  assert.equal(upstreamPathFor('/grok?x=1', 'grok'), '/?x=1');
  // new URL() folds the backslash, so the request still lands on /v1/responses.
  assert.equal(new URL(`${upstreamFor({ provider: 'grok' }, null)}${upstreamPathFor('/grok\\v1/responses', 'grok')}`).pathname, '/v1/responses');
  // A spelling that only classifies once decoded goes to xAI as sent.
  assert.equal(upstreamPathFor('/grok%2fv1/responses', 'grok'), '/grok%2fv1/responses');
  // Under MITM the path already has no mount.
  assert.equal(upstreamPathFor('/v1/responses', 'grok'), '/v1/responses');
  // Codex's prefix is the upstream's own path, never removed.
  assert.equal(upstreamPathFor('/backend-api/codex/responses', 'codex'), '/backend-api/codex/responses');
  assert.equal(upstreamPathFor('/v1/messages', 'anthropic'), '/v1/messages');
});

test('under MITM xAI\'s host alone says Grok, and is intercepted only for a Grok fleet', () => {
  assert.equal(providerForRequest('/v1/responses', 'cli-chat-proxy.grok.com'), 'grok');
  assert.equal(providerForRequest('/v1/settings', 'cli-chat-proxy.grok.com'), 'grok');
  assert.equal(providerForRequest('/v1/responses', 'localhost'), 'anthropic');
  assert.equal(providerForRequest('/grok/v1/responses', null), 'grok');
  // chatgpt.com serves the client's own non-inference calls too, so its host
  // does not decide by itself.
  assert.equal(providerForRequest('/backend-api/wham/accounts/check', 'chatgpt.com'), 'anthropic');

  assert.ok(!interceptHostsFor([{ provider: 'codex' }]).includes('cli-chat-proxy.grok.com'));
  assert.ok(interceptHostsFor([{ provider: 'grok' }]).includes('cli-chat-proxy.grok.com'));
  const config = { accounts: [{ provider: 'grok', type: 'oauth' }] };
  assert.equal(clientPassthroughOrigin({ authority: 'cli-chat-proxy.grok.com:443', url: '/v1/responses', config }), null);
});

test('a Grok request carries the serving account\'s token and identity, never the client\'s', () => {
  const headers = {
    authorization: 'Bearer client-token',
    'x-userid': 'client-user', 'x-grok-user-id': 'client-user', 'x-email': 'client@example.com',
    'x-grok-session-id': 'sess-1',
  };
  applyAuthHeaders(headers, { provider: 'grok', type: 'oauth', credential: 'pool-token', userId: 'user-b', email: 'b@example.com' });
  assert.deepEqual(headers, {
    authorization: 'Bearer pool-token',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-userid': 'user-b', 'x-grok-user-id': 'user-b', 'x-email': 'b@example.com',
    'x-grok-session-id': 'sess-1',
  });

  const bare = { 'x-userid': 'client-user', 'x-grok-user-id': 'client-user', 'x-email': 'client@example.com' };
  applyAuthHeaders(bare, { provider: 'grok', type: 'oauth', credential: 'pool-token' });
  assert.deepEqual(bare, { authorization: 'Bearer pool-token', 'x-xai-token-auth': 'xai-grok-cli' });
});

test('Grok is a passthrough subscription provider of its own', () => {
  assert.equal(upstreamFor({ provider: 'grok' }, 'https://anthropic.internal'), 'https://cli-chat-proxy.grok.com');
  assert.equal(rewritesBody({ provider: 'grok' }), false);
  const grok = { provider: 'grok', type: 'oauth' };
  assert.equal(canServeProvider(grok, 'grok'), true);
  assert.equal(canServeProvider(grok, 'codex'), false);
  assert.equal(canServeProvider(grok, 'anthropic'), false);
  assert.equal(canServeProvider({ provider: 'codex', type: 'oauth' }, 'grok'), false);
  assert.equal(loginCommandFor(grok), 'teamclaude login --grok');
  assert.equal(loginCommandFor({ provider: 'codex' }), 'teamclaude login --codex');
  assert.equal(loginCommandFor({}), 'teamclaude login');
});
