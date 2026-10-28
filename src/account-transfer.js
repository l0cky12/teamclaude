// Moving your own accounts from one of your machines to another.
//
// Setting up a new machine meant signing in to every pooled account again.
// `teamclaude accounts export <file>` writes the accounts — identity, tokens and
// the per-account settings that mean the same thing anywhere — to one file, and
// `teamclaude accounts import <file>` on the new machine merges them into its
// config without a single sign-in.
//
// The file holds live refresh tokens, so it is encrypted by default: scrypt
// derives an AES-256-GCM key from a passphrase, and the readable header is the
// cipher's associated data, so editing it fails the decrypt instead of being
// believed. Only `node:crypto`: no dependencies.
//
// What does NOT travel is what belongs to the machine: the entry id (the
// running server pairs accounts by it), `source`, an `importFrom` path (its
// tokens are read from the file and inlined instead) and per-account `routing`,
// which names a proxy, often with its credentials, that the other machine may
// not reach. Quota state is re-learned from traffic.
//
// A refresh rotates the token family on both providers, so two machines
// renewing one copied token sign each other out of that account. The CLI says
// so on export and offers --disable-source; the import side never refreshes,
// fetches a profile or touches callback.net, so importing spends nothing and
// rotates nothing. A token this machine already holds is replaced only by a
// newer one (later `expiresAt`, the rule credential-sync.js uses too).

import { scrypt, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { findUpsertTarget, updateAccountEntry } from './identity.js';
import { importCredentials } from './oauth.js';
import { importCodexCredentials, DEFAULT_CODEX_CREDENTIALS_PATH } from './codex-auth.js';
import { providerOf } from './provider.js';

export const BUNDLE_FORMAT = 'teamrouter-accounts';
export const BUNDLE_VERSION = 1;

// scrypt cost. N = 2^17 takes about half a second and 128 MiB, which is what
// one export or import can afford and a guesser cannot; maxmem has to be raised
// past Node's 32 MiB default to allow it.
const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
const KDF_MAXMEM = 256 * 1024 * 1024;
// The most a file may ask for. The parameters are read from the file, and an
// unbounded N would let a crafted one hold the CPU and memory hostage.
const MAX_LOG2_N = 20;

/** Fields that belong to this machine and never leave it. */
const LOCAL_FIELDS = ['id', 'source', 'importFrom', 'routing'];

/** The credential fields: what an import replaces on an account already here. */
const CREDENTIAL_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'apiKey'];

/**
 * Identity fields an import refreshes alongside the credential: the newer
 * login is the better witness to who the account is.
 */
const IDENTITY_FIELDS = [
  'accountUuid', 'orgUuid', 'orgName', 'email', 'accountId', 'userId',
  'organizationType', 'rateLimitTier', 'seatTier', 'hasClaudeMax', 'hasClaudePro',
];

/** A refused export or import, with a message meant for the terminal. */
export class TransferError extends Error {}

/**
 * The accounts to export, with their credentials inlined and the machine's own
 * fields removed.
 *
 * An `importFrom` account, and a Codex account that reads the Codex CLI's own
 * file, have their tokens read from that file now: the path means nothing on
 * the other machine. One whose file cannot be read is left out and reported.
 * @param {Array<Record<string, any>>} accounts
 * @param {{ readClaude?: typeof importCredentials, readCodex?: typeof importCodexCredentials }} [readers] - test seams
 * @returns {Promise<{ accounts: Array<Record<string, any>>, ids: string[], fileBacked: string[], skipped: Array<{ name: string, reason: string }> }>}
 *   `ids` are the exported entries' own ids on this machine, for --disable-source.
 */
export async function collectExportAccounts(accounts, { readClaude = importCredentials, readCodex = importCodexCredentials } = {}) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const fileBacked = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  for (const acct of accounts || []) {
    if (!acct || typeof acct !== 'object') continue;
    const entry = { ...acct };
    const isCodex = providerOf(acct) === 'codex';
    const from = acct.importFrom || (isCodex && acct.type === 'oauth' && !acct.accessToken ? DEFAULT_CODEX_CREDENTIALS_PATH : null);
    if (from) {
      try {
        const creds = isCodex ? await readCodex(from) : await readClaude(from);
        if (!creds?.accessToken) throw new Error(`no token in ${from}`);
        for (const [k, v] of Object.entries(creds)) if (v != null) entry[k] = v;
        fileBacked.push(acct.name);
      } catch (/** @type {any} */ err) {
        skipped.push({ name: acct.name, reason: `could not read ${from}: ${err?.message || err}` });
        continue;
      }
    }
    if (!entry.accessToken && !entry.apiKey) {
      skipped.push({ name: acct.name, reason: 'no credential stored' });
      continue;
    }
    for (const k of LOCAL_FIELDS) delete entry[k];
    out.push(entry);
    if (acct.id) ids.push(acct.id);
  }
  return { accounts: out, ids, fileBacked, skipped };
}

/**
 * Derive the AES key for `passphrase` with the given scrypt parameters.
 * @param {string} passphrase
 * @param {Buffer} salt
 * @param {{ N: number, r: number, p: number }} params
 * @returns {Promise<Buffer>}
 */
function deriveKey(passphrase, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: KDF_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * The header fields bound to the ciphertext as associated data, in a fixed
 * order so the encoding is the same on both machines.
 * @param {Record<string, any>} bundle
 */
function associatedData(bundle) {
  const e = bundle.encryption;
  return Buffer.from(JSON.stringify([bundle.format, bundle.v, bundle.exportedAt, bundle.count, e.kdf, e.N, e.r, e.p, e.salt, e.cipher, e.iv]));
}

/**
 * Build the file contents for `accounts`: encrypted under `passphrase`, or
 * plain JSON when it is null.
 * @param {Array<Record<string, any>>} accounts
 * @param {string|null} passphrase
 * @param {{ now?: Date, kdf?: { N: number, r: number, p: number } }} [opts] - test seams; a test may lower the cost
 * @returns {Promise<Record<string, any>>}
 */
export async function createBundle(accounts, passphrase, { now = new Date(), kdf = KDF } = {}) {
  const header = { format: BUNDLE_FORMAT, v: BUNDLE_VERSION, exportedAt: now.toISOString(), count: accounts.length };
  const payload = Buffer.from(JSON.stringify({ accounts }));
  if (passphrase == null) return { ...header, encryption: null, accounts };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const bundle = {
    ...header,
    encryption: {
      kdf: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p,
      salt: salt.toString('base64'),
      cipher: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: '',
    },
    data: '',
  };
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(bundle));
  bundle.data = Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64');
  bundle.encryption.tag = cipher.getAuthTag().toString('base64');
  return bundle;
}

/**
 * Whether a parsed file is an encrypted bundle (so a passphrase is needed).
 * @param {any} bundle
 */
export function isEncryptedBundle(bundle) {
  return !!bundle?.encryption;
}

/**
 * Check a parsed file is a bundle this version can read, throwing a
 * TransferError saying why not.
 * @param {any} bundle
 */
export function checkBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== BUNDLE_FORMAT) {
    throw new TransferError('Not a TeamClaude account export.');
  }
  if (bundle.v !== BUNDLE_VERSION) {
    throw new TransferError(`This export is format version ${bundle.v}; this TeamClaude reads version ${BUNDLE_VERSION}. Update TeamClaude on this machine and try again.`);
  }
}

/**
 * The accounts in a bundle, decrypting it with `passphrase` when it is
 * encrypted. A wrong passphrase and a tampered file look the same to GCM, and
 * the message says so.
 * @param {any} bundle
 * @param {string|null} passphrase
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function openBundle(bundle, passphrase) {
  checkBundle(bundle);
  let accounts;
  if (!isEncryptedBundle(bundle)) {
    accounts = bundle.accounts;
  } else {
    const e = bundle.encryption;
    if (e.kdf !== 'scrypt' || e.cipher !== 'aes-256-gcm') throw new TransferError(`Unsupported encryption (${e.kdf}/${e.cipher}).`);
    const log2N = Math.log2(e.N);
    if (!Number.isInteger(log2N) || log2N < 1 || log2N > MAX_LOG2_N || !(e.r >= 1 && e.r <= 32) || !(e.p >= 1 && e.p <= 16)) {
      throw new TransferError('The export\'s key-derivation settings are out of range.');
    }
    if (passphrase == null || passphrase === '') throw new TransferError('This export is encrypted: a passphrase is needed.');
    const key = await deriveKey(passphrase, Buffer.from(e.salt, 'base64'), e);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
      decipher.setAAD(associatedData(bundle));
      decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(bundle.data, 'base64')), decipher.final()]);
      accounts = JSON.parse(plain.toString('utf8')).accounts;
    } catch {
      throw new TransferError('Wrong passphrase, or the file was changed after it was exported.');
    }
  }
  if (!Array.isArray(accounts)) throw new TransferError('The export holds no account list.');
  return accounts.filter(a => a && typeof a === 'object' && typeof a.name === 'string' && a.name !== '' && typeof a.type === 'string');
}

/**
 * Whether two records hold the very same credential.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
function sameCredential(a, b) {
  if (a.apiKey || b.apiKey) return a.apiKey === b.apiKey;
  return !!a.accessToken && a.accessToken === b.accessToken && (a.refreshToken || null) === (b.refreshToken || null);
}

/**
 * A display name no entry in `accounts` holds yet, starting from `name`.
 * @param {Array<Record<string, any>>} accounts
 * @param {Record<string, any>} incoming
 */
function freeName(accounts, incoming) {
  const taken = new Set(accounts.map(a => a?.name));
  if (!taken.has(incoming.name)) return incoming.name;
  if (incoming.orgName && !incoming.name.includes(' (')) {
    const withOrg = `${incoming.name} (${incoming.orgName})`;
    if (!taken.has(withOrg)) return withOrg;
  }
  for (let n = 2; ; n++) {
    const candidate = `${incoming.name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Merge imported accounts into `config.accounts`, in place.
 *
 * - A new account is added as exported, minus the machine's own fields.
 * - An account already here (findUpsertTarget: identity first, the name only
 *   when nothing contradicts it) has its credential and identity replaced, and
 *   only when the imported token is newer, unless `force`. Its name, id,
 *   priority, routing and other settings stay this machine's own.
 * - An account here that reads its tokens from a file (`importFrom`) is left
 *   alone: the next reload reads that file again, over anything written here.
 * @param {{ accounts: Array<Record<string, any>> }} config
 * @param {Array<Record<string, any>>} incoming
 * @param {{ force?: boolean }} [opts]
 * @returns {{ added: string[], updated: string[], skipped: Array<{ name: string, reason: string }> }}
 */
export function mergeImportedAccounts(config, incoming, { force = false } = {}) {
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const updated = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  for (const raw of incoming) {
    const acct = { ...raw };
    for (const k of LOCAL_FIELDS) delete acct[k];
    const idx = findUpsertTarget(config.accounts, acct);
    if (idx < 0) {
      acct.name = freeName(config.accounts, acct);
      acct.source = 'transfer';
      config.accounts.push(acct);
      added.push(acct.name);
      continue;
    }
    const prev = config.accounts[idx];
    if (prev.importFrom) {
      skipped.push({ name: prev.name, reason: `reads its login from ${prev.importFrom} on this machine` });
      continue;
    }
    if (sameCredential(prev, acct)) {
      skipped.push({ name: prev.name, reason: 'already up to date' });
      continue;
    }
    if (!force) {
      const comparable = Number.isFinite(acct.expiresAt) && Number.isFinite(prev.expiresAt);
      if (comparable && acct.expiresAt <= prev.expiresAt) {
        skipped.push({ name: prev.name, reason: 'this machine has a newer login (--force to replace it)' });
        continue;
      }
      // A Codex entry that reads the Codex CLI's file has no token of its own,
      // so any imported one is an improvement. Anything else with nothing to
      // compare is the operator's call.
      const hasOwn = !!(prev.accessToken || prev.apiKey);
      if (!comparable && hasOwn) {
        skipped.push({ name: prev.name, reason: 'a different login is already here (--force to replace it)' });
        continue;
      }
    }
    /** @type {Record<string, any>} */
    const fields = {};
    for (const k of [...CREDENTIAL_FIELDS, ...IDENTITY_FIELDS]) if (acct[k] !== undefined) fields[k] = acct[k];
    config.accounts[idx] = updateAccountEntry(prev, fields);
    updated.push(prev.name);
  }
  return { added, updated, skipped };
}
