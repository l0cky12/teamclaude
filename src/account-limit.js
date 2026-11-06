// A cap on how many accounts of one kind the pool may hold.
//
// The proxy pools one person's own accounts. Twenty of a kind is more than
// any one person's subscriptions; a list past that is a config growing by
// mistake (a sync loop, a script adding the same login again), or a pool
// being built for something other than one person. So every path that adds
// an account (login, import, the TUI, the dashboard, credential sync, a
// transfer bundle) asks here first and refuses the twenty-first.
//
// The cap is per kind: Claude subscriptions, Codex subscriptions, Anthropic
// API keys, and each third-party backend (by its upstream host) count apart.
// Accounts a config already holds are never dropped: the cap only stops new
// ones from being added.

import { providerOf } from './provider.js';

/** The most accounts of one kind the pool takes. */
export const MAX_ACCOUNTS_PER_PROVIDER = 20;

/**
 * The kind an account is counted under, and how to name it to a person.
 * @param {Record<string, any>|null|undefined} account
 * @returns {{ key: string, label: string }}
 */
export function accountLimitGroup(account) {
  if (account?.upstream) {
    const host = backendHost(account.upstream);
    return { key: `backend:${host}`, label: `${host} backend` };
  }
  if (providerOf(account) === 'codex') return { key: 'codex', label: 'Codex' };
  if (account?.type === 'apikey') return { key: 'apikey', label: 'Anthropic API key' };
  return { key: 'claude', label: 'Claude' };
}

/**
 * A backend's host, lower-cased: two entries for one service count together
 * whatever the case or path of their upstream URL.
 * @param {any} upstream
 */
function backendHost(upstream) {
  try {
    return new URL(String(upstream)).host.toLowerCase();
  } catch {
    return String(upstream).toLowerCase();
  }
}

/**
 * Why `entry` cannot be added to `accounts`, or null when it can.
 *
 * Only for a NEW account: an update of one already in the list is never
 * refused, so the caller asks once it knows the entry adds a row.
 * @param {Array<Record<string, any>>|null|undefined} accounts  the accounts already held (the config's list)
 * @param {Record<string, any>} entry  the account about to be added
 * @param {number} [limit]
 * @returns {{ label: string, count: number, limit: number, message: string } | null}
 */
export function accountLimitReached(accounts, entry, limit = MAX_ACCOUNTS_PER_PROVIDER) {
  const { key, label } = accountLimitGroup(entry);
  const count = (accounts || []).filter((a) => accountLimitGroup(a).key === key).length;
  if (count < limit) return null;
  return {
    label, count, limit,
    message: `Account limit reached: ${count} ${label} account${count === 1 ? '' : 's'} already (at most ${limit}). Remove one before adding another.`,
  };
}

/** Thrown by an add that would go past the cap. */
export class AccountLimitError extends Error {
  /** @param {{ label: string, count: number, limit: number, message: string }} reached */
  constructor(reached) {
    super(reached.message);
    this.name = 'AccountLimitError';
    this.label = reached.label;
    this.count = reached.count;
    this.limit = reached.limit;
  }
}

/**
 * Throw an AccountLimitError when `entry` cannot be added to `accounts`.
 * @param {Array<Record<string, any>>|null|undefined} accounts
 * @param {Record<string, any>} entry
 * @param {number} [limit]
 */
export function assertAccountLimit(accounts, entry, limit = MAX_ACCOUNTS_PER_PROVIDER) {
  const reached = accountLimitReached(accounts, entry, limit);
  if (reached) throw new AccountLimitError(reached);
}
