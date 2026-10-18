// Removing one account from a running server, and keeping that removal out of
// the way of a reload.
//
// A reload (sync-accounts.js) walks the fleet by position and awaits between
// steps: an `importFrom` account's file is read in the middle of it. A removal
// that lands in one of those gaps splices the list under it, and the reload's
// next write goes to whichever account slid into the removed one's place. So
// the two take turns on one queue, and the removal finds its account by
// object, not by a position that a reload may have changed.

import { configIndexFor, markAccountRemoved } from './account-pairing.js';
import { providerOf } from './provider.js';

/**
 * A queue that runs the async jobs given to it one at a time, in order. A job
 * that fails does not stop the ones after it.
 * @returns {<T>(job: () => Promise<T> | T) => Promise<T>}
 */
export function serialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return job => {
    const run = tail.catch(() => {}).then(job);
    tail = run;
    return run;
  };
}

/** A removal refused for a reason the caller may show as it is. */
export class RemovalRefused extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * The dashboard's Remove, bound to one server's fleet and config.
 *
 * The account leaves the running fleet and the config file, credentials
 * included, the way the TUI's remove does: in-process rather than a file edit
 * and a reload, since the TUI may be saving the same list. The manager's
 * removal hook leaves the callback.net tombstone, when the install is signed in
 * there.
 *
 * The last account is refused: a server whose config holds none refuses to
 * start, and the dashboard that could sign one in again would go with it.
 *
 * @param {object} opts
 * @param {any} opts.accountManager
 * @param {{ accounts: Record<string, any>[] }} opts.config  the server's in-memory config
 * @param {() => Promise<unknown>} opts.persist  writes the account list to disk
 * @param {<T>(job: () => Promise<T>) => Promise<T>} opts.exclusive  the queue reloads run on
 * @returns {(account: Record<string, any>) => Promise<{ name: string, provider: string, persisted: boolean }>}
 */
export function createAccountRemover({ accountManager, config, persist, exclusive }) {
  return account => exclusive(async () => {
    const index = accountManager.accounts.indexOf(account);
    if (index < 0) throw new RemovalRefused('that account was already removed', 404);
    if (config.accounts.length <= 1 && accountManager.accounts.length <= 1) {
      throw new RemovalRefused('this is the only account, and the proxy needs one to start: sign in another account first', 409);
    }
    // Resolved before removeAccount, which splices the manager's list.
    const cfgIdx = configIndexFor(config.accounts, accountManager.accounts, index);
    accountManager.removeAccount(index);
    if (cfgIdx >= 0) {
      // The save adopts rows on disk that are not in memory, so the entry has
      // to be marked before it goes or the save would read it back in.
      markAccountRemoved(config, config.accounts[cfgIdx]?.id);
      config.accounts.splice(cfgIdx, 1);
    }
    accountManager.events?.add({ kind: 'control', type: 'account_removed', provider: providerOf(account), account: account.name, message: 'Removed (dashboard)' });
    await persist();
    return { name: account.name, provider: providerOf(account), persisted: cfgIdx >= 0 };
  });
}
