// Sign-ins started from the web dashboard.
//
// The OAuth flows (oauth.js, codex-auth.js) end with an authorization code
// that comes back either to a loopback listener or as a paste, and the TUI's
// login panel holds the paste field for the whole sign-in. A browser page
// cannot hold anything across requests, so this holds it for the page: the
// flow is started by one request, a paste arrives in another, and the page
// asks how it went in a third. The routes in server.js are thin over this.
//
// One sign-in at a time. Codex's redirect names port 1455, which only one
// listener can hold, and a second Claude flow would only be a second link the
// person has to tell apart from the first. Starting a new one cancels the old.

import { randomBytes } from 'node:crypto';
import { briefError } from './event-log.js';
import { safeLine } from './safe-text.js';

/** The providers the dashboard can sign in. */
export const WEB_SIGN_IN_PROVIDERS = /** @type {const} */ (['claude', 'codex']);

/**
 * What the page needs to show a started sign-in.
 * @typedef {object} WebSignInStart
 * @property {string} id
 * @property {'claude' | 'codex'} provider
 * @property {string} url  the link that works from any device (Claude's code page, OpenAI's authorize page)
 * @property {string | null} browserUrl  Claude only: the link whose redirect reaches this machine's
 *   loopback listener, for a browser running on the proxy's own machine
 * @property {boolean} listening  something on this machine is waiting for the browser to come back by itself
 * @property {string | null} note  why that listener is not running, when it matters
 */

/**
 * Where a sign-in stands, as the page polls for it.
 * @typedef {object} WebSignInState
 * @property {'waiting' | 'finishing' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'} state
 * @property {'claude' | 'codex'} [provider]
 * @property {string | null} [account]  the account the tokens went to
 * @property {'added' | 'updated' | null} [action]
 * @property {string | null} [error]  one line, safe for the page
 * @property {boolean} [fileBacked]  the account reads its tokens from a credentials file
 *   (`importFrom`), so the ones this sign-in stored are not the ones it uses
 */

/**
 * @typedef {(provider: 'claude' | 'codex', opts: {
 *   signal: AbortSignal,
 *   onPrompt: (prompt: import('./login-flow.js').LoginPrompt & { browserUrl?: string | null }) => void,
 * }) => Promise<{ name?: string, action?: 'added' | 'updated', fileBacked?: boolean } | null | undefined>} SignIn
 */

/**
 * @typedef {object} SignInEntry
 * @property {string} id
 * @property {'claude' | 'codex'} provider
 * @property {AbortController} controller
 * @property {((text: string) => boolean) | null} submit  null once the flow is past taking a paste
 * @property {WebSignInState['state']} state
 * @property {string | null} account
 * @property {'added' | 'updated' | null} action
 * @property {string | null} error
 * @property {boolean} fileBacked
 */

export class WebSignIns {
  /**
   * @param {object} opts
   * @param {SignIn} opts.signIn  runs one provider's flow and stores the result
   *   (index.js: the TUI panel's sign-in, without a browser opened on the server)
   */
  constructor({ signIn }) {
    this._signIn = signIn;
    /** @type {SignInEntry | null} */
    this._current = null;
  }

  /**
   * Start a sign-in, cancelling one still pending. Resolves once the flow is
   * waiting for the browser, with the link to open; rejects when it could not
   * get that far.
   * @param {string} provider
   * @returns {Promise<WebSignInStart>}
   */
  async start(provider) {
    if (provider !== 'claude' && provider !== 'codex') throw new WebSignInError('provider must be "claude" or "codex"');
    // A sign-in whose code is already being exchanged will store an account
    // whatever happens here; replacing it would only stop the page from
    // hearing how it ended.
    if (this._current?.state === 'finishing') {
      throw new WebSignInError('the last sign-in is still finishing; it shows in the list in a moment');
    }
    this.cancel(this._current?.id ?? '');
    const id = randomBytes(16).toString('hex');
    const controller = new AbortController();
    /** @type {SignInEntry} */
    const entry = { id, provider, controller, submit: null, state: 'waiting', account: null, action: null, error: null, fileBacked: false };
    this._current = entry;

    /** @type {(prompt: any) => void} */
    let prompted = () => {};
    /** @type {Promise<any>} */
    const prompt = new Promise(resolve => { prompted = resolve; });
    const outcome = Promise.resolve().then(() => this._signIn(provider, { signal: controller.signal, onPrompt: p => prompted(p) }));
    outcome.then(
      result => {
        entry.state = 'succeeded';
        entry.account = typeof result?.name === 'string' ? result.name : null;
        entry.action = result?.action === 'updated' || result?.action === 'added' ? result.action : null;
        entry.fileBacked = result?.fileBacked === true;
      },
      err => {
        entry.state = /** @type {any} */ (err)?.name === 'AbortError' ? 'cancelled' : 'failed';
        entry.error = entry.state === 'failed' ? briefError(err) : null;
      },
    ).finally(() => { entry.submit = null; });

    // The flow can fail before it ever asks for the browser (no listener for
    // Codex and a refusal to go on without it, say): that is this request's
    // failure, not something for the page to find on its first poll.
    // Both sides settle into a value, so the side that loses the race is never
    // a rejection nobody handles.
    const first = await Promise.race([
      prompt.then(p => ({ prompt: p, error: null })),
      outcome.then(() => ({ prompt: null, error: null }), err => ({ prompt: null, error: err })),
    ]);
    if (first.error) throw first.error;
    if (!first.prompt) throw new WebSignInError('the sign-in ended before it started');
    const { prompt: started } = first;
    entry.submit = started.submit;
    // The wait for a code is over. A paste says so through submit; the
    // loopback listener says so only here, and from then on the exchange is
    // under way and Cancel cannot stop it. A cancel or the timeout ends the
    // wait too, and the outcome's own handler names those.
    started.settled?.then(() => {
      if (entry.state === 'waiting' && !controller.signal.aborted) entry.state = 'finishing';
    });
    return {
      id,
      provider,
      url: started.url,
      browserUrl: provider === 'claude' && typeof started.browserUrl === 'string' ? started.browserUrl : null,
      listening: Boolean(started.listening),
      note: started.note ? safeLine(started.note, 200) : null,
    };
  }

  /**
   * A paste from the page: the code Claude's page shows, or the address
   * OpenAI's redirect left in the address bar.
   * @param {string} id
   * @param {unknown} text
   * @returns {{ accepted: boolean }}  false when there was nothing to use
   */
  submit(id, text) {
    const entry = this._entry(id);
    if (!entry || entry.state !== 'waiting' || !entry.submit) throw new WebSignInError('no sign-in is waiting for a code; start it again');
    let accepted;
    try {
      accepted = entry.submit(String(text ?? ''));
    } catch (err) {
      // These are written for the person who pasted (login-flow.js codeRace),
      // and quote at most what they pasted.
      throw new WebSignInError(safeLine(err instanceof Error ? err.message : String(err), 240));
    }
    if (accepted) entry.state = 'finishing';
    return { accepted };
  }

  /**
   * @param {string} id
   * @returns {WebSignInState}
   */
  status(id) {
    const entry = this._entry(id);
    if (!entry) return { state: 'unknown' };
    return { state: entry.state, provider: entry.provider, account: entry.account, action: entry.action, error: entry.error, fileBacked: entry.fileBacked };
  }

  /**
   * Cancel the sign-in `id` names, closing its listener. Nothing to cancel is
   * not an error: the page's Cancel can cross a sign-in finishing. A code
   * already accepted is past cancelling: its exchange is under way, and the
   * account it signs in is stored when that ends.
   * @param {string} id
   * @returns {boolean}  whether a pending sign-in was cancelled
   */
  cancel(id) {
    const entry = this._entry(id);
    if (!entry || entry.state !== 'waiting') return false;
    entry.controller.abort();
    return true;
  }

  /** @param {string} id */
  _entry(id) {
    return this._current && typeof id === 'string' && id && this._current.id === id ? this._current : null;
  }
}

/** A refusal the page may show as it is. */
export class WebSignInError extends Error {}
