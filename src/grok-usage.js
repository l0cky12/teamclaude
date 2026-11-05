// Read-only Grok plan usage.
//
// Grok Build reads the plan's allowance from the inference proxy's billing
// endpoint (crates/codegen/xai-grok-shell/src/extensions/billing.rs in
// github.com/xai-org/grok-build). It spends nothing, and its responses carry no
// rate-limit headers to learn from instead, so this is the only place a Grok
// account's usage is known. A Grok plan meters one shared pool per period,
// weekly or monthly, with no five-hour window; the reading is normalised to the
// shape the Codex usage probe returns, so the account manager stores it in the
// fields rotation and every renderer already read.

import { proxyFetch } from './upstream-fetch.js';
import { PROVIDERS } from './provider.js';

export const GROK_BILLING_URL = `${PROVIDERS.grok.upstream}/v1/billing?format=credits`;

/**
 * @typedef {object} GrokUsage
 * @property {null} fiveHour  Grok plans have no session window
 * @property {{ utilization: number, resetAt: number|null }} sevenDay  the plan's period, weekly or monthly
 * @property {'weekly'|'monthly'|null} period
 * @property {string|null} planType  the subscription tier as xAI names it
 */

/**
 * Convert a billing reply into quota fields.
 *
 * proto3 JSON leaves zero values out, so a plan with nothing spent arrives
 * without `creditUsagePercent`: absent is 0%, not unknown. A reply with no
 * `config` at all says nothing and is refused, rather than read as an empty
 * allowance.
 *
 * @param {any} data
 * @returns {GrokUsage|{ error: string }}
 */
export function normalizeGrokBilling(data) {
  const config = data?.config;
  if (!config || typeof config !== 'object') return { error: 'billing reply carried no plan' };
  const pct = config.creditUsagePercent == null ? 0 : Number(config.creditUsagePercent);
  if (!Number.isFinite(pct)) return { error: 'billing reply carried an unreadable usage figure' };
  const end = Date.parse(config.currentPeriod?.end);
  const type = String(config.currentPeriod?.type || '');
  return {
    fiveHour: null,
    sevenDay: { utilization: Math.max(0, pct) / 100, resetAt: Number.isFinite(end) ? end : null },
    period: type.endsWith('_MONTHLY') ? 'monthly' : type.endsWith('_WEEKLY') ? 'weekly' : null,
    planType: typeof data.subscriptionTier === 'string' && data.subscriptionTier ? data.subscriptionTier : null,
  };
}

/**
 * Fetch a Grok account's plan usage without sending an inference request.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {{ fetchImpl?: Function, timeoutMs?: number, url?: string }} [opts]
 */
export async function fetchGrokUsage(account, { fetchImpl = proxyFetch, timeoutMs = 10_000, url = GROK_BILLING_URL } = {}) {
  if (!account?.credential) return { error: 'missing Grok credential' };
  try {
    /** @type {Record<string, string>} */
    const headers = { Authorization: `Bearer ${account.credential}`, 'X-XAI-Token-Auth': 'xai-grok-cli', Accept: 'application/json' };
    if (account.userId) headers['x-userid'] = account.userId;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), routing: account.routing ?? null });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    return normalizeGrokBilling(await res.json());
  } catch (/** @type {any} */ err) {
    return { error: err?.message || String(err), status: null };
  }
}
