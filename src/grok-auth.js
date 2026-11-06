// Grok (xAI) credentials.
//
// Grok Build, xAI's coding CLI, signs in against xAI's OIDC issuer and keeps
// the login in ~/.grok/auth.json: an object keyed by `<issuer>::<client id>`
// whose entry holds the bearer token (`key`), its refresh token and expiry, and
// the user it belongs to. The user id has no place in the request body; Grok
// Build sends it as headers beside the token, which provider.js replaces with
// the serving account's.
//
// Signing in here uses the device authorization grant (RFC 8628), the flow
// `grok login --device-auth` uses: there is no redirect to catch, so it works
// the same on a laptop, over SSH and from the dashboard. The client id and the
// scopes are Grok Build's own (crates/codegen/xai-grok-login/src/config.rs in
// github.com/xai-org/grok-build), so the consent is the one the user already
// gives that CLI.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { proxyFetch } from './upstream-fetch.js';
import { tokenPairFromResponse } from './oauth.js';
import { envVar } from './brand.js';
import { openBrowser } from './login-flow.js';
import { safeLine } from './safe-text.js';
/** @typedef {import('./types.js').CodedError} CodedError */

export const DEFAULT_GROK_CREDENTIALS_PATH = '~/.grok/auth.json';

const ISSUER = 'https://auth.x.ai';
const TOKEN_ENDPOINT = `${ISSUER}/oauth2/token`;
const DEVICE_ENDPOINT = `${ISSUER}/oauth2/device/code`;
// Grok Build's public OAuth client, the `oidc_client_id` its auth.json stores.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
// Grok Build's default_oauth2_scopes. `grok-cli:access` is the one that lets
// the token through cli-chat-proxy.grok.com; `offline_access` is the refresh
// token.
const SCOPES = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
// RFC 8628 defaults, the same ones Grok Build applies.
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const DEFAULT_DEVICE_EXPIRY_S = 600;
// How long the issuer has to hand out a code, before that code's own expiry
// takes over as the flow's deadline.
const START_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} GrokCredentials
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {number|null} [expiresAt]  ms
 * @property {string} [userId]  xAI user id, sent as `x-userid`
 * @property {string} [email]
 */

/** Decode a JWT payload without verifying it. Claims are used for labelling only. */
function decodeJwtClaims(/** @type {unknown} */ token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} fields */
function defined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

/** @param {unknown} v */
function str(v) {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Read a Grok Build login from disk.
 *
 * The entry for Grok Build's own client is preferred; otherwise the first entry
 * holding a token, which covers the older `https://accounts.x.ai/sign-in` key.
 * A file with no such entry yields no access token, which the caller reports.
 *
 * @param {string} [filePath]
 * @param {{ home?: string }} [opts]
 * @returns {Promise<GrokCredentials>}
 */
export async function importGrokCredentials(filePath = DEFAULT_GROK_CREDENTIALS_PATH, { home = homedir() } = {}) {
  const raw = JSON.parse(await readFile(filePath.replace(/^~/, home), 'utf-8'));
  const entries = Object.entries(raw && typeof raw === 'object' ? raw : {})
    .filter(([, v]) => v && typeof v === 'object' && str(v.key));
  const entry = (entries.find(([k]) => k === `${ISSUER}::${CLIENT_ID}`) || entries[0])?.[1];
  if (!entry) return {};
  const expires = Date.parse(entry.expires_at);
  return /** @type {GrokCredentials} */ (defined({
    accessToken: entry.key,
    refreshToken: str(entry.refresh_token),
    expiresAt: Number.isFinite(expires) ? expires : undefined,
    userId: str(entry.user_id) || str(entry.principal_id),
    email: str(entry.email),
  }));
}

/**
 * POST a form to one of xAI's OAuth endpoints.
 * @param {string} url
 * @param {Record<string, string>} form
 * @param {{ routing?: import('./account-routing.js').RoutingProxy|null, signal?: AbortSignal, fetchImpl?: typeof proxyFetch }} opts
 */
function postForm(url, form, { routing = null, signal, fetchImpl = proxyFetch }) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal,
    routing,
  });
}

/**
 * Exchange a Grok refresh token for a fresh access token, in the same
 * `{ accessToken, refreshToken, expiresAt }` shape the other providers return.
 * xAI rotates refresh tokens (Grok Build retries with the one on disk when a
 * sibling process rotated it first), so a returned one replaces the old.
 * @param {string} refreshToken
 * @param {string} [endpoint]
 * @param {import('./account-routing.js').RoutingProxy|null} [routing]
 * @param {{ budgetMs?: number }} [opts]
 */
export async function refreshGrokToken(refreshToken, endpoint = TOKEN_ENDPOINT, routing = null, { budgetMs = Infinity } = {}) {
  const timeoutMs = Math.min(Number(envVar('REFRESH_TIMEOUT_MS')) || 30_000, budgetMs);
  if (!(timeoutMs > 0)) throw new Error('Grok token refresh ran out of time');
  const res = await postForm(endpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
    { routing, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = /** @type {CodedError} */ (new Error(`Grok token refresh failed (${res.status}): ${safeLine(await res.text(), 300)}`));
    // A 400/401 is a dead refresh token (re-login needed); anything else is
    // transient. The account manager tells them apart by this.
    err.status = res.status;
    throw err;
  }
  return tokenPairFromResponse(await res.json(), { previousRefreshToken: /** @type {any} */ (refreshToken) });
}

/**
 * Turn a token response into the shape importGrokCredentials returns. The user
 * id is the id token's `sub`, as Grok Build reads it.
 * @param {any} data
 * @returns {GrokCredentials}
 */
export function credentialsFromGrokTokenResponse(data) {
  const claims = decodeJwtClaims(data?.id_token) || {};
  return { ...tokenPairFromResponse(data), ...defined({ userId: str(claims.sub), email: str(claims.email) }) };
}

// ── Device sign-in ──────────────────────────────────────────────────────────

/**
 * A device sign-in under way: what to show the person, and the credentials
 * once they approve it.
 * @typedef {object} GrokLogin
 * @property {string} url  the verification page, with the code filled in when the issuer offers that
 * @property {string} verificationUri  the bare page, for typing the code by hand
 * @property {string} userCode
 * @property {Promise<GrokCredentials>} credentials
 */

/** @param {number} ms @param {AbortSignal|null} signal */
function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(undefined); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A page address from the issuer, which this process prints and may open.
 * Only http(s), and no control characters.
 * @param {unknown} value
 */
function pageUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

/**
 * Start a device sign-in: ask the issuer for a code, then poll the token
 * endpoint in the background until the person approves it, refuses it, or it
 * expires.
 *
 * @param {object} [opts]
 * @param {import('./account-routing.js').RoutingProxy|null} [opts.routing]  the about-to-be-added account's own egress proxy
 * @param {AbortSignal|null} [opts.signal]  cancels the polling
 * @param {number} [opts.timeoutMs]  gives up sooner than the code's own expiry
 * @param {string} [opts.deviceEndpoint]
 * @param {string} [opts.tokenEndpoint]
 * @param {(ms: number, signal: AbortSignal|null) => Promise<unknown>} [opts.wait]  the pause between polls; tests pass one that does not sleep
 * @param {typeof proxyFetch} [opts.fetchImpl]  tests pass one that stalls on cue
 * @param {{ set: (fn: () => void, ms: number) => any, clear: (handle: any) => void }} [opts.timers]  arms the flow's deadline; tests pass one they fire themselves
 * @returns {Promise<GrokLogin>}
 */
export async function startGrokLogin({ routing = null, signal = null, timeoutMs = Infinity, deviceEndpoint = DEVICE_ENDPOINT, tokenEndpoint = TOKEN_ENDPOINT, wait = abortableWait, fetchImpl = proxyFetch, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  // One controller bounds the whole flow, every request and every body read
  // included: a connection that goes quiet mid-reply would otherwise hold a
  // poll (and the panel's sign-in slot) open past the code's own expiry. The
  // caller's cancel is relayed onto it by hand, as upstream-fetch.js does,
  // because AbortSignal.any needs Node 20.3 and package.json admits 20.0.
  const flow = new AbortController();
  const relay = () => flow.abort(signal?.reason);
  if (signal?.aborted) relay();
  else signal?.addEventListener('abort', relay, { once: true });
  /** @type {any} */
  let timer;
  /** @param {number} ms @param {string} message */
  const deadlineIn = (ms, message) => {
    timers.clear(timer);
    // Clamped: setTimeout reads a delay past 2^31-1 ms as 1 ms, and expires_in
    // is the issuer's number.
    if (Number.isFinite(ms)) timer = timers.set(() => flow.abort(new Error(message)), Math.min(Math.max(0, ms), 2 ** 31 - 1));
  };
  const settle = () => { timers.clear(timer); signal?.removeEventListener('abort', relay); };
  /** Settle `promise`, or fail with the flow's abort reason, whichever is first.
   * @template T @param {Promise<T>} promise @returns {Promise<T>} */
  const bounded = promise => new Promise((resolve, reject) => {
    // Settled either way, so a promise that fails after the flow did is still
    // observed rather than left to end the process as an unhandled rejection.
    if (flow.signal.aborted) { promise.catch(() => {}); reject(flow.signal.reason); return; }
    const onAbort = () => reject(flow.signal.reason);
    flow.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => flow.signal.removeEventListener('abort', onAbort));
  });
  /** POST a form and read its whole reply, both within the flow's deadline.
   * @param {string} url @param {Record<string, string>} form */
  const post = async (url, form) => {
    const res = await bounded(postForm(url, form, { routing, signal: flow.signal, fetchImpl }));
    return { status: res.status, ok: res.ok, text: await bounded(res.text()) };
  };
  /** @param {string} text */
  const parse = text => { try { return JSON.parse(text); } catch { return null; } };

  let body;
  try {
    // The code's expiry is not known until the issuer answers, so the first
    // request has a deadline of its own.
    deadlineIn(Math.min(timeoutMs, START_TIMEOUT_MS), 'xAI did not answer the sign-in request in time. Try again');
    const res = await post(deviceEndpoint, { client_id: CLIENT_ID, scope: SCOPES });
    if (!res.ok) throw new Error(`xAI refused to start the sign-in (${res.status}): ${safeLine(res.text, 200)}`);
    body = parse(res.text);
  } catch (err) {
    settle();
    throw err;
  }
  const userCode = typeof body?.user_code === 'string' && /^[A-Z0-9-]{1,32}$/.test(body.user_code) ? body.user_code : null;
  const verificationUri = pageUrl(body?.verification_uri);
  if (!userCode || !verificationUri || typeof body?.device_code !== 'string') {
    settle();
    throw new Error('xAI answered the sign-in request without a usable code or page');
  }
  const complete = pageUrl(body.verification_uri_complete);
  const url = complete || `${verificationUri}${verificationUri.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(userCode)}`;

  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_DEVICE_EXPIRY_S;
  deadlineIn(Math.min(expiresIn * 1000, timeoutMs), 'The sign-in code expired before it was approved. Start the sign-in again');
  let interval = Number(body.interval) > 0 ? Number(body.interval) : DEFAULT_INTERVAL_S;

  const credentials = (async () => {
    try {
      for (;;) {
        // Waiting first, as RFC 8628 asks: a poll on a code just issued can
        // only be `authorization_pending`, and polling early earns a `slow_down`.
        await bounded(Promise.resolve(wait(interval * 1000, flow.signal)));
        const poll = await post(tokenEndpoint, { grant_type: DEVICE_GRANT, device_code: body.device_code, client_id: CLIENT_ID });
        const data = parse(poll.text);
        if (poll.ok) return credentialsFromGrokTokenResponse(data);
        const error = typeof data?.error === 'string' ? data.error : '';
        if (error === 'authorization_pending') continue;
        if (error === 'slow_down') { interval += SLOW_DOWN_STEP_S; continue; }
        if (error === 'access_denied') throw new Error('The sign-in was refused in the browser');
        if (error === 'expired_token') throw new Error('The sign-in code expired before it was approved. Start the sign-in again');
        throw new Error(`xAI refused the sign-in (${poll.status}): ${safeLine(data?.error_description || error || 'no reason given', 200)}`);
      }
    } finally {
      settle();
    }
  })();
  // Awaited by every caller; this only keeps a rejection that lands before
  // the caller awaits from ending the process.
  credentials.catch(() => {});
  return { url, verificationUri, userCode, credentials };
}

/**
 * `teamclaude login --grok`: a device sign-in from the CLI. The page and the
 * code are printed, and the page is opened here unless `noBrowser` says not to
 * (the flag, or a remote session).
 * @param {object} [opts]
 * @param {boolean} [opts.noBrowser]
 * @param {import('./account-routing.js').RoutingProxy|null} [opts.routing]
 */
export async function loginGrok({ noBrowser = false, routing = null } = {}) {
  const flow = await startGrokLogin({ routing });
  console.log(`Open this page on any device and approve the sign-in:\n${flow.url}`);
  console.log(`If it asks for a code, enter: ${flow.userCode}`);
  if (!noBrowser) openBrowser(flow.url);
  console.log('Waiting for approval...');
  return flow.credentials;
}
