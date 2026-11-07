// A username and password for the web dashboard, as a way to get the proxy key.
//
// Opened from another machine, the dashboard needs `proxy.apiKey`, and copying
// it off the server for every new browser is the chore this removes. The
// password does not replace the key: a correct one is answered with the key,
// which the page stores and sends as it always has, so every route keeps one
// gate. The config holds a salted scrypt hash, never the password.
//
// A password can be guessed where a 32-byte key cannot, so failures are
// limited per caller address and the hashing that answers a guess is capped.

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigOpError } from './config-ops.js';

// N = 2^15 costs about 50 ms and 32 MiB per guess: slow for a guesser, and
// still quick for a person signing in.
const KDF = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 };
const KDF_MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

// Five wrong guesses are free. Each one after that locks the address out for
// twice as long as the last, from one minute up to an hour.
const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
// An address that stops guessing is forgotten after a day.
const FORGET_MS = 24 * 60 * 60_000;
// Hashes running at once, across every caller. A guess past this is refused
// before it costs anything.
const MAX_IN_FLIGHT = 4;

/**
 * @typedef {object} DashboardLogin  `proxy.dashboardLogin`
 * @property {string} username
 * @property {string} passwordHash  `scrypt$<N>$<r>$<p>$<salt>$<hash>`, base64url
 */

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {{ N: number, r: number, p: number, keyLen: number }} kdf
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, kdf) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: KDF_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Hash a password for `proxy.dashboardLogin.passwordHash`.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KDF);
  return ['scrypt', KDF.N, KDF.r, KDF.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * Whether `password` matches a stored hash. A hash this version cannot read
 * matches nothing.
 * @param {string} stored
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(stored, password) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const want = Buffer.from(parts[5], 'base64url');
  // A hand-edited cost could make one guess take minutes or all the memory.
  if (!(N >= 2 ** 10 && N <= 2 ** 17) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4) || want.length < 16 || salt.length < 8) return false;
  let got;
  try {
    got = await derive(password, salt, { N, r, p, keyLen: want.length });
  } catch {
    return false;
  }
  return timingSafeEqual(got, want);
}

/**
 * The configured login, or null when there is none or it is not usable.
 * @param {Record<string, any>|undefined} proxyConfig
 * @returns {DashboardLogin|null}
 */
export function configuredLogin(proxyConfig) {
  const login = proxyConfig?.dashboardLogin;
  if (!login || typeof login.username !== 'string' || typeof login.passwordHash !== 'string') return null;
  if (!login.username.trim() || !login.passwordHash.startsWith('scrypt$')) return null;
  return { username: login.username.trim(), passwordHash: login.passwordHash };
}

/**
 * Whether the dashboard can offer a password sign-in: a login is set and there
 * is a proxy key to answer it with.
 * @param {Record<string, any>|undefined} proxyConfig
 */
export function passwordLoginAvailable(proxyConfig) {
  return !!configuredLogin(proxyConfig) && typeof proxyConfig?.apiKey === 'string' && !!proxyConfig.apiKey;
}

/**
 * Set or clear `proxy.dashboardLogin` on a config being written. An empty
 * username and password clears it.
 * @param {Record<string, any>} config
 * @param {{ username?: unknown, password?: unknown }} body
 * @returns {Promise<string|null>}  the username saved, or null when cleared
 */
export async function setDashboardLogin(config, body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username && !password) {
    if (config.proxy) delete config.proxy.dashboardLogin;
    return null;
  }
  if (!USERNAME.test(username)) throw new ConfigOpError('A username is up to 64 letters, digits and . _ @ -, starting with a letter or digit.');
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new ConfigOpError(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (!config.proxy?.apiKey) throw new ConfigOpError('Set a proxy key (proxy.apiKey) first: signing in hands the page that key.');
  config.proxy.dashboardLogin = { username, passwordHash: await hashPassword(password) };
  return username;
}

/**
 * @typedef {object} LoginOutcome
 * @property {string|null} key  the proxy key, when the sign-in succeeded
 * @property {'ok' | 'unavailable' | 'wrong' | 'locked' | 'busy'} reason
 * @property {number} [retryAfterSec]  for `locked` and `busy`
 */

/**
 * Checks sign-in attempts against the config, limiting wrong guesses per
 * caller address. One per server.
 * @param {{ now?: () => number }} [opts]
 */
export function createDashboardLogin({ now = Date.now } = {}) {
  /** @type {Map<string, { failures: number, lockedUntil: number, lastAt: number }>} */
  const callers = new Map();
  let inFlight = 0;

  function forgetStale() {
    const t = now();
    for (const [addr, c] of callers) if (t - c.lastAt > FORGET_MS && c.lockedUntil <= t) callers.delete(addr);
  }

  /**
   * @param {Record<string, any>|undefined} proxyConfig
   * @param {string} addr  the caller's address
   * @param {{ username?: unknown, password?: unknown }} body
   * @returns {Promise<LoginOutcome>}
   */
  async function attempt(proxyConfig, addr, body) {
    const login = configuredLogin(proxyConfig);
    const key = proxyConfig?.apiKey;
    if (!login || typeof key !== 'string' || !key) return { key: null, reason: 'unavailable' };
    forgetStale();
    const caller = callers.get(addr);
    if (caller && caller.lockedUntil > now()) {
      return { key: null, reason: 'locked', retryAfterSec: Math.ceil((caller.lockedUntil - now()) / 1000) };
    }
    if (inFlight >= MAX_IN_FLIGHT) return { key: null, reason: 'busy', retryAfterSec: 1 };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    inFlight++;
    let match;
    try {
      // The hash runs for a wrong username too, so the reply time does not say
      // which of the two was wrong.
      const passwordOk = await verifyPassword(login.passwordHash, password);
      match = passwordOk && username === login.username;
    } finally {
      inFlight--;
    }
    if (match) {
      callers.delete(addr);
      return { key, reason: 'ok' };
    }
    const c = callers.get(addr) ?? { failures: 0, lockedUntil: 0, lastAt: 0 };
    c.failures++;
    c.lastAt = now();
    if (c.failures > FREE_FAILURES) {
      const lockMs = Math.min(MAX_LOCK_MS, FIRST_LOCK_MS * 2 ** (c.failures - FREE_FAILURES - 1));
      c.lockedUntil = now() + lockMs;
    }
    callers.set(addr, c);
    return { key: null, reason: 'wrong' };
  }

  return { attempt };
}
