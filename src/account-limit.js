// A cap on how many accounts of one kind the pool may hold.
//
// The proxy pools one person's own accounts. Twenty of a kind is more than
// any one person's subscriptions; a list past that is a config growing by
// mistake (a sync loop, a script adding the same login again), or a pool
// being built for something other than one person. So every path that adds
// an account (login, import, the TUI, the dashboard, credential sync, a
// transfer bundle) asks here first and refuses the twenty-first.
//
// The cap is per kind: Claude subscriptions, the subscriptions of each other
// provider (Codex, Grok), Anthropic API keys, and each third-party backend (by
// its upstream host) count apart.
// An account that only names its own provider's host as `upstream` counts
// with that provider.
//
// Accounts a config already holds are never dropped: the cap only stops new
// ones from being added.

import { PROVIDERS, providerOf } from './provider.js';
import { sameIdentity } from './identity.js';
import { mintAccountId, ensureAccountIds } from './account-id.js';

/** The most accounts of one kind the pool takes. */
export const MAX_ACCOUNTS_PER_PROVIDER = 20;

/**
 * The kind an account is counted under, and how to name it to a person.
 * @param {Record<string, any>|null|undefined} account
 * @returns {{ key: string, label: string }}
 */
export function accountLimitGroup(account) {
  const provider = providerOf(account);
  if (account && isThirdPartyBackend(account)) {
    const host = backendHost(account.upstream);
    return { key: `backend:${host}`, label: `${host} backend` };
  }
  // Every provider other than Anthropic is its own kind (Codex, Grok): a
  // provider added to the registry later must not fill the Claude cap.
  if (provider !== 'anthropic') return { key: provider, label: PROVIDERS[provider].label };
  if (account?.type === 'apikey') return { key: 'apikey', label: 'Anthropic API key' };
  return { key: 'claude', label: 'Claude' };
}

/**
 * Whether an account is a third-party backend: an API key sent to a host
 * other than its provider's own. A subscription (OAuth) login is never one,
 * whatever upstream it is pointed through, and an `upstream` that only spells
 * out the provider's own host (`https://chatgpt.com` on a Codex account) is
 * that provider, so twenty of either cannot step around their own cap.
 * @param {Record<string, any>|null|undefined} account
 */
function isThirdPartyBackend(account) {
  if (!account?.upstream || account.type === 'oauth') return false;
  return backendHost(account.upstream) !== backendHost(PROVIDERS[providerOf(account)].upstream);
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
    message: `Account limit reached: ${count}/${limit} ${label} accounts. Remove one to add another.`,
  };
}

/** Thrown by an add that would go past the cap. */
export class AccountLimitError extends Error {
  /** @param {{ label: string, count: number, limit: number, message: string }} reached */
  constructor(reached) {
    super(reached.message);
    this.name = 'AccountLimitError';
    // Our own words, no upstream text in them: the dashboard and the event log
    // show it as is (event-log.js briefError) instead of a generic failure.
    this.publicMessage = reached.message;
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

/**
 * Add a NEW account to a running server under the cap, without a race against
 * other writers.
 *
 * The count a running process holds can be stale: a `teamclaude login` in
 * another terminal may have saved the twentieth account before this process
 * reloaded. So the check runs inside `update` (atomicConfigUpdate: the config
 * lock and a fresh read) against everything the file holds plus anything this
 * process runs that the file does not have yet, and the row is written there.
 * Only once it is on disk does it join the running lists. A refusal aborts the
 * write, so the file is left as it was.
 *
 * `added` says whether it was; `idx` is then its manager index. When it was
 * not, `reason` says why (null: the account is already there, nothing to add).
 * @param {object} opts
 * @param {Record<string, any>} opts.entry  the new account's config entry
 * @param {{ accounts: Array<Record<string, any>> }} opts.config  the running config
 * @param {{ accounts: Array<Record<string, any>>, addAccount: (entry: Record<string, any>) => number }} opts.accountManager
 * @param {(updater: (disk: { accounts: Array<Record<string, any>> }) => void) => Promise<any>} opts.update
 * @param {number} [opts.limit]
 * @param {((taken: Set<string>) => string) | null} [opts.pickName]  names the entry from the
 *   names already taken, for an account named by the proxy (`api-N`) rather than by its
 *   login. Asked again under the lock with the file's names too: an API key's identity
 *   is its name, so a name another row holds would read as that account.
 * @returns {Promise<{ added: boolean, idx: number | null, reason: string | null }>}
 */
export async function admitUnderCap({ entry, config, accountManager, update, limit = MAX_ACCOUNTS_PER_PROVIDER, pickName = null }) {
  const namesIn = (/** @type {Array<Array<Record<string, any>>>} */ lists) => new Set(lists.flat().map((a) => a?.name).filter(Boolean));
  if (pickName) entry.name = pickName(namesIn([config.accounts, accountManager.accounts]));
  const held = (/** @type {Record<string, any>} */ a) => sameIdentity(a, entry);
  if (config.accounts.some(held) || accountManager.accounts.some(held)) return { added: false, idx: null, reason: null };
  if (!entry.id) entry.id = mintAccountId();
  /** @type {string | null} */
  let reason = null;
  try {
    await update((disk) => {
      if (pickName) entry.name = pickName(namesIn([disk.accounts, config.accounts, accountManager.accounts]));
      // On disk already (another process added it): the next reload brings it in.
      if (disk.accounts.some(held)) throw new NotAdded(null);
      // The file's rows, and this process's own that the file does not have
      // (an add not saved yet). A row is the same row by id or by identity:
      // a hand-written row with no id is given a fresh one on each read.
      const onDisk = (/** @type {Record<string, any>} */ a) => disk.accounts.some((d) => (a.id && d.id === a.id) || sameIdentity(d, a));
      const reached = accountLimitReached([...disk.accounts, ...config.accounts.filter((a) => !onDisk(a))], entry, limit);
      if (reached) throw new NotAdded(reached.message);
      disk.accounts.push(entry);
    });
  } catch (err) {
    if (!(err instanceof NotAdded)) throw err;
    reason = err.reason;
    return { added: false, idx: null, reason };
  }
  // A reload that ran between the write and here has already brought it in.
  const live = accountManager.accounts.findIndex((a) => a.id === entry.id);
  if (live >= 0) return { added: true, idx: live, reason: null };
  config.accounts.push(entry);
  ensureAccountIds(config.accounts);
  return { added: true, idx: accountManager.addAccount(entry), reason: null };
}

/** Aborts admitUnderCap's write; not an error anyone sees. */
class NotAdded extends Error {
  /** @param {string | null} reason */
  constructor(reason) {
    super(reason || 'already present');
    this.reason = reason;
  }
}
