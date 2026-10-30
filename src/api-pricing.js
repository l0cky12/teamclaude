// What a model's tokens would cost at the provider's API list price: the
// Insights page's "estimated API cost".
//
// Most of what the pool spends goes through subscriptions (Claude Max,
// ChatGPT), which bill a flat fee rather than by the token. The question the
// estimate answers is what the same tokens would have cost on a pay-as-you-go
// API key, so the prices are the providers' published standard-tier rates in
// USD per million tokens, copied from
//   https://platform.claude.com/docs/en/about-claude/pricing      (2026-10-29)
//   https://developers.openai.com/api/docs/pricing                (2026-10-29)
// They change; a model this table does not know is reported as unpriced
// rather than guessed at.
//
// The history keeps tokens per day and model, not per request, so a few
// per-request rules cannot be applied and the estimate takes the common case:
//   - Cache writes are priced at the 5-minute rate. Claude Code also writes
//     1-hour entries, which cost more, so this can read low.
//   - Long-prompt surcharges (Claude Haiku 5.5 over 100K tokens, OpenAI's
//     flagships over 272K) are not applied.
//   - Fast mode, batch, data-residency and regional multipliers are not applied.
//
// Only `anthropic` and `codex` rows are priced. A third-party backend
// (DeepSeek, z.ai) is already billed by the token at its own rates, which
// are not Anthropic's even when it serves a Claude-named model.

/**
 * USD per million tokens. `cacheWrite` is the 5-minute write; OpenAI does not
 * charge separately for writing its cache, so its rows have none (and the
 * Codex path never reports one anyway: responses-usage.js).
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite?: number }} Price
 */

/**
 * Claude models by family and version, as claudeKey() names them.
 * @type {Record<string, Price>}
 */
export const CLAUDE_PRICES = {
  'fable-5.1': { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  'mythos-5.1': { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 },
  'fable-5': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'mythos-5': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'opus-5.5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.8': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.7': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.6': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'opus-4.1': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'opus-4': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'sonnet-5.5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'sonnet-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 },
  'sonnet-4.6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'sonnet-4.5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'sonnet-4': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'haiku-5.5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
  'haiku-4.5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'haiku-3.5': { input: 0.8, cacheWrite: 1, cacheRead: 0.08, output: 4 },
};

/**
 * OpenAI models by id, short-context standard tier. The `-pro` models have no
 * cached-input price because they take no cache; a cached token there is
 * charged as input.
 * @type {Record<string, Price>}
 */
export const OPENAI_PRICES = {
  'gpt-6-astra': { input: 10, cacheRead: 1, output: 50 },
  'gpt-6.1-sol': { input: 2, cacheRead: 0.1, output: 10 },
  'gpt-6.1-terra': { input: 1, cacheRead: 0.05, output: 5 },
  'gpt-6-luna': { input: 0.1, cacheRead: 0.01, output: 0.5 },
  'gpt-6-sol': { input: 2, cacheRead: 0.2, output: 10 },
  'gpt-5.6-sol': { input: 4, cacheRead: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cacheRead: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cacheRead: 0.02, output: 1.2 },
  'gpt-5.6-cyber': { input: 12.5, cacheRead: 1.25, output: 75 },
  'gpt-5.5': { input: 5, cacheRead: 0.5, output: 30 },
  'gpt-5.5-pro': { input: 30, cacheRead: 30, output: 180 },
  'gpt-5.5-cyber': { input: 12.5, cacheRead: 1.25, output: 75 },
  'gpt-5.4': { input: 2.5, cacheRead: 0.25, output: 15 },
  'gpt-5.4-pro': { input: 30, cacheRead: 30, output: 180 },
  'gpt-5.4-mini': { input: 0.75, cacheRead: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cacheRead: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cacheRead: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cacheRead: 0.175, output: 14 },
  'gpt-5.2-pro': { input: 21, cacheRead: 21, output: 168 },
  'gpt-5.1': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cacheRead: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cacheRead: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cacheRead: 0.005, output: 0.4 },
  'gpt-5-pro': { input: 15, cacheRead: 15, output: 120 },
  'gpt-4.1': { input: 2, cacheRead: 0.5, output: 8 },
  'o3': { input: 2, cacheRead: 0.5, output: 8 },
  'o4-mini': { input: 1.1, cacheRead: 0.275, output: 4.4 },
};

/**
 * A Claude model id as `<family>-<version>`: `claude-opus-4-5-20251101` →
 * `opus-4.5`, `claude-3-5-haiku-20241022` → `haiku-3.5`. Cloud prefixes
 * (`us.anthropic.`), suffixes (`[1m]`, `-v1:0`, `@20250514`) and date stamps
 * are not part of the price, so they are dropped. Null for an id that names
 * no Claude family.
 * @param {string} model
 */
export function claudeKey(model) {
  const s = model.toLowerCase().replace(/\[.*$/, '').replace(/[@:].*$/, '');
  const m = /claude-(.*)$/.exec(s);
  if (!m) return null;
  const parts = m[1].split(/[-.]/);
  const family = parts.find(p => /^(fable|mythos|opus|sonnet|haiku)$/.test(p));
  if (!family) return null;
  // Version numbers are one or two digits; a date stamp is eight, `v1` is not a number.
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).slice(0, 2);
  return version.length ? `${family}-${version.join('.')}` : null;
}

/**
 * The price of one model's tokens on one provider, or null when this table
 * has no price for it.
 * @param {string} provider  a history row's provider: `anthropic`, `codex` or `backend:<host>`
 * @param {string} model
 * @returns {Price|null}
 */
export function priceFor(provider, model) {
  if (typeof model !== 'string' || !model) return null;
  if (provider === 'anthropic') {
    const key = claudeKey(model);
    return key ? CLAUDE_PRICES[key] ?? null : null;
  }
  if (provider === 'codex') {
    const id = model.toLowerCase().trim();
    if (OPENAI_PRICES[id]) return OPENAI_PRICES[id];
    // A dated snapshot (`gpt-5-2025-08-07`) is priced as its model.
    const undated = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (OPENAI_PRICES[undated]) return OPENAI_PRICES[undated];
    // Codex-tuned variants the price page no longer lists (gpt-5.1-codex,
    // gpt-5.1-codex-max) were priced as the model they tune, which is what
    // the one it still lists (gpt-5.3-codex at gpt-5.2's rate) shows.
    const base = undated.replace(/-codex(-max)?$/, '');
    return base !== undated ? OPENAI_PRICES[base] ?? null : null;
  }
  return null;
}

/**
 * What a tally of tokens costs at `price`, in USD.
 * @param {Price} price
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number }} t
 */
export function costAt(price, t) {
  return (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead
    + t.cacheWrite * (price.cacheWrite ?? price.input)) / 1e6;
}

/**
 * A priceFor() that remembers its answers, for summing many rows of the same
 * few models. Lives as long as the caller keeps it: one read of the history.
 */
export function priceLookup() {
  /** @type {Map<string, Price|null>} */
  const seen = new Map();
  return (/** @type {string} */ provider, /** @type {string} */ model) => {
    const key = provider + '\u0000' + model;
    let p = seen.get(key);
    if (p === undefined) seen.set(key, p = priceFor(provider, model));
    return p;
  };
}
