// The price table behind the Insights page's estimated API cost
// (api-pricing.js): which model id gets which price, and the arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeKey, priceFor, costAt, priceLookup, CLAUDE_PRICES, OPENAI_PRICES } from '../src/api-pricing.js';

test('Claude ids are priced by family and version, whatever is around them', () => {
  assert.equal(claudeKey('claude-opus-5-5'), 'opus-5.5');
  assert.equal(claudeKey('claude-opus-4-5-20251101'), 'opus-4.5', 'a date stamp is not a version');
  assert.equal(claudeKey('claude-opus-4-20250514'), 'opus-4');
  assert.equal(claudeKey('claude-3-5-haiku-20241022'), 'haiku-3.5', 'the old order, version first');
  assert.equal(claudeKey('claude-sonnet-4-6[1m]'), 'sonnet-4.6', 'the context suffix');
  assert.equal(claudeKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'sonnet-4.5', 'a cloud id');
  assert.equal(claudeKey('claude-fable-5'), 'fable-5');
  assert.equal(claudeKey('Claude-Haiku-4-5'), 'haiku-4.5');
  assert.equal(claudeKey('claude-unknown'), null);
  assert.equal(claudeKey('gpt-5'), null);
});

test('a model the table does not know is unpriced, not guessed', () => {
  assert.equal(priceFor('anthropic', 'claude-3-7-sonnet-20250219'), null, 'retired and no longer listed');
  assert.equal(priceFor('anthropic', '(unknown)'), null);
  assert.equal(priceFor('anthropic', '(other)'), null);
  assert.equal(priceFor('codex', 'gpt-99'), null);
  assert.equal(priceFor('anthropic', ''), null);
});

test('a third-party backend is never priced, even on a Claude-named model', () => {
  assert.equal(priceFor('backend:api.deepseek.com', 'claude-opus-5-5'), null);
  assert.equal(priceFor('backend:api.z.ai', 'glm-5'), null);
  assert.equal(priceFor('unknown', 'claude-opus-5-5'), null);
});

test('OpenAI ids: exact, dated snapshots, and Codex variants at their base model', () => {
  assert.equal(priceFor('codex', 'gpt-6-astra'), OPENAI_PRICES['gpt-6-astra']);
  assert.equal(priceFor('codex', 'GPT-5.4'), OPENAI_PRICES['gpt-5.4']);
  assert.equal(priceFor('codex', 'gpt-5-2025-08-07'), OPENAI_PRICES['gpt-5']);
  assert.equal(priceFor('codex', 'gpt-5.3-codex'), OPENAI_PRICES['gpt-5.3-codex'], 'a variant still listed keeps its own row');
  assert.equal(priceFor('codex', 'gpt-5.1-codex'), OPENAI_PRICES['gpt-5.1']);
  assert.equal(priceFor('codex', 'gpt-5.1-codex-max'), OPENAI_PRICES['gpt-5.1']);
  assert.equal(priceFor('codex', 'gpt-5.1-codex-mini'), null, 'no gpt-5.1-mini to fall back to');
  assert.equal(priceFor('anthropic', 'gpt-5'), null, 'the provider decides which table');
});

test('the cost of a tally: each kind at its own rate, per million', () => {
  const t = { input: 1_000_000, output: 1_000_000, cacheRead: 10_000_000, cacheWrite: 2_000_000 };
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 per 5-minute cache write.
  assert.equal(costAt(CLAUDE_PRICES['opus-5.5'], t), 4 + 20 + 2 + 10);
  // OpenAI has no cache-write charge; a token reported as one is plain input.
  assert.equal(costAt(OPENAI_PRICES['gpt-5'], t), 1.25 + 10 + 1.25 + 2.5);
  assert.equal(costAt(CLAUDE_PRICES['haiku-4.5'], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test('every price is a positive number, and output dearer than input', () => {
  for (const [name, p] of [...Object.entries(CLAUDE_PRICES), ...Object.entries(OPENAI_PRICES)]) {
    for (const k of /** @type {const} */ (['input', 'output', 'cacheRead'])) assert.ok(p[k] > 0, `${name}.${k}`);
    assert.ok(p.output > p.input, name);
    assert.ok(p.cacheRead <= p.input, `${name}: a cache read never costs more than input`);
  }
});

test('a lookup remembers what it found, unpriced answers included', () => {
  const price = priceLookup();
  assert.equal(price('anthropic', 'claude-opus-5-5'), CLAUDE_PRICES['opus-5.5']);
  assert.equal(price('anthropic', 'claude-opus-5-5'), CLAUDE_PRICES['opus-5.5']);
  assert.equal(price('codex', 'nope'), null);
  assert.equal(price('codex', 'nope'), null);
});
