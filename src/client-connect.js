// Points the operator's own coding clients on this machine at the proxy by
// writing their settings, so nobody has to hand-edit three config files in
// three formats: Claude Code's settings.json, the Codex CLI's config.toml, and
// the variable Grok Build reads (the Windows user environment, or a managed
// line in the shell rc elsewhere).
//
// Each client is a store (where its setting lives) and a codec (pure text
// transforms over what the store holds). The transforms are what the tests
// pin; the stores are thin IO. A setting that names some other address is
// never overwritten without `replace`, and disconnecting takes out only what
// is ours.

import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PROVIDERS } from './provider.js';
import { detectShell, markedLine, rcPathForShell, removeMarkedLine, setMarkedLine, writeFileAtomic } from './alias.js';

/** @typedef {'claude'|'codex'|'grok'} ClientId */
/** @typedef {'connect'|'disconnect'} ConnectAction */

/**
 * Where one client's setting stands. `current` is set only for `elsewhere`
 * (the setting it has now), `problem` only for `unreadable`.
 * @typedef {object} ClientStatus
 * @property {ClientId} id
 * @property {string} label
 * @property {string} where  the file, or "Windows user environment"
 * @property {'connected'|'disconnected'|'elsewhere'|'unreadable'} state
 * @property {string} [current]
 * @property {string} [problem]
 * @property {string} [note]  what the operator has to do for a change to take effect
 */

/** @typedef {{ state: 'connected'|'disconnected' } | { state: 'elsewhere', current: string }} Inspection */

/**
 * Pure transforms over what a store holds (`null`: nothing there yet). Each
 * throws ConnectError when it cannot read the text safely.
 * @typedef {object} Codec
 * @property {(text: string|null, target: string) => Inspection} inspect
 * @property {(text: string|null, target: string) => string} apply  only called when not connected
 * @property {(text: string|null, target: string) => string|null} remove  only called when connected
 */

/**
 * @typedef {object} Store
 * @property {string} where
 * @property {() => Promise<string|null>} read
 * @property {(text: string|null) => Promise<void>} write
 */

/**
 * Runs a PowerShell script and resolves with its stdout. `env` is added to the
 * child's environment: values travel that way, never inside the script.
 * @typedef {(script: string, env?: Record<string, string>) => Promise<string>} PowerShellRunner
 */

/**
 * @typedef {object} ConnectContext
 * @property {NodeJS.Platform} platform
 * @property {NodeJS.ProcessEnv} env
 * @property {string} home
 * @property {PowerShellRunner} runPowerShell
 */

/** A setting this module refuses to touch, with the reason to show. */
export class ConnectError extends Error {
  /**
   * @param {string} message
   * @param {{ replaceable?: boolean }} [opts]  true when connecting with `replace` would go ahead
   */
  constructor(message, { replaceable = false } = {}) {
    super(message);
    this.replaceable = replaceable;
  }
}

/**
 * The proxy's origin as a client on this machine reaches it without a key, or
 * null when there is none: the loopback exemption is off (`trustLoopback`), or
 * the listener is bound to one address that is not loopback.
 * @param {Record<string, any>|undefined} proxyConfig
 * @param {string|null|undefined} bindHost
 * @param {number} port
 * @returns {string|null}
 */
export function loopbackOrigin(proxyConfig, bindHost, port) {
  if (proxyConfig?.trustLoopback === false || !(port > 0)) return null;
  const host = String(bindHost || '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '::1') return `http://[::1]:${port}`;
  if (['127.0.0.1', 'localhost', '0.0.0.0', '::'].includes(host)) return `http://127.0.0.1:${port}`;
  return null;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Whether two URLs name the same proxy endpoint. `localhost` and `127.0.0.1`
 * are one machine, so the documented `http://localhost:3456` reads as connected.
 * @param {string} a
 * @param {string} b
 */
export function sameAddress(a, b) {
  let ua, ub;
  try { ua = new URL(a); ub = new URL(b); } catch { return false; }
  const host = (/** @type {URL} */ u) => (LOOPBACK_NAMES.has(u.hostname) ? 'loopback' : u.hostname);
  const path = (/** @type {URL} */ u) => u.pathname.replace(/\/+$/, '');
  return ua.protocol === ub.protocol && ua.port === ub.port && host(ua) === host(ub) && path(ua) === path(ub);
}

// ── Claude Code: env.ANTHROPIC_BASE_URL in settings.json ────────────────────

/**
 * @param {string|null} text
 * @returns {Record<string, any>}
 */
function parseSettings(text) {
  const body = (text ?? '').replace(/^﻿/, '');
  if (!body.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    throw new ConnectError('the file is not valid JSON; fix it by hand, nothing was changed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConnectError('the file does not hold a JSON object; nothing was changed');
  if (parsed.env != null && (typeof parsed.env !== 'object' || Array.isArray(parsed.env))) throw new ConnectError('its "env" is not an object; nothing was changed');
  return parsed;
}

/**
 * Re-serialise `settings` with the indentation and line ending `text` used.
 * @param {string|null} text
 * @param {Record<string, any>} settings
 */
function serializeSettings(text, settings) {
  const indent = /^([ \t]+)"/m.exec(text ?? '')?.[1] ?? '  ';
  const eol = (text ?? '').includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(settings, null, indent).replace(/\n/g, eol) + eol;
}

/** @type {Codec} */
export const claudeCodec = {
  inspect(text, target) {
    const value = parseSettings(text).env?.ANTHROPIC_BASE_URL;
    if (value == null || value === '') return { state: 'disconnected' };
    return sameAddress(String(value), target) ? { state: 'connected' } : { state: 'elsewhere', current: String(value) };
  },
  apply(text, target) {
    const settings = parseSettings(text);
    settings.env = { ...(settings.env || {}), ANTHROPIC_BASE_URL: target };
    return serializeSettings(text, settings);
  },
  remove(text) {
    const settings = parseSettings(text);
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      if (!Object.keys(settings.env).length) delete settings.env;
    }
    return serializeSettings(text, settings);
  },
};

// ── Codex CLI: model_provider and [model_providers.teamclaude] ──────────────

const PROVIDER_NAME = 'teamclaude';
const HEADER_RE = /^\s*\[\[?([^[\]]*)\]\]?\s*(?:#.*)?$/;
const PROVIDER_RE = /^(\s*)model_provider\s*=\s*(.*)$/;
const PROFILE_RE = /^\s*profile\s*=\s*(.*)$/;
const WAS_RE = /^#\s*teamclaude: was ("(?:[^"\\]|\\.)*")\s*(.*)$/;

/**
 * The dotted key path of a table header line, or null for any other line.
 * @param {string} line
 * @returns {string[]|null}
 */
function headerPath(line) {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  return m[1].split('.').map(part => part.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2'));
}

/** @param {string[]|null} path */
const isOurTable = path => !!path && path[0] === 'model_providers' && path[1] === PROVIDER_NAME;

/**
 * A TOML string value and the comment after it, or null for anything else.
 * @param {string} rest  what follows the `=`
 * @returns {{ value: string, comment: string }|null}
 */
function parseTomlString(rest) {
  const basic = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(rest.trim());
  if (basic) {
    let value;
    try { value = JSON.parse(`"${basic[1]}"`); } catch { value = basic[1]; }
    return { value, comment: basic[2] ?? '' };
  }
  const literal = /^'([^']*)'\s*(#.*)?$/.exec(rest.trim());
  return literal ? { value: literal[1], comment: literal[2] ?? '' } : null;
}

/**
 * Which lines continue a multi-line string (`"""` or `'''`) opened on an
 * earlier line. Their text is string content, so a `[table]` or `key = ...`
 * there is not one. Comments and one-line strings are stepped over while
 * looking for a delimiter, so a `"""` quoted in either opens nothing.
 * @param {string[]} lines
 */
function multilineContinuations(lines) {
  /** @type {boolean[]} */
  const inside = [];
  /** @type {string|null} */
  let open = null;
  for (const line of lines) {
    inside.push(open !== null);
    let i = 0;
    while (i < line.length) {
      if (open) {
        if (open === '"""' && line[i] === '\\') { i += 2; continue; }
        if (line.startsWith(open, i)) {
          // Up to two more quotes may close it: `"""a"""""` is the string `a""`.
          i += 3;
          while (line[i] === open[0]) i++;
          open = null;
          continue;
        }
        i++;
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        open = line.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const close = line.indexOf("'", i + 1);
        i = close < 0 ? line.length : close + 1;
        continue;
      }
      i++;
    }
  }
  return inside;
}

/**
 * A `model_provider = "..."` line, its value and the value it replaced.
 * @typedef {{ index: number, indent: string, value: string, was: string|null, comment: string }} ProviderLine
 */

/**
 * @param {string} line
 * @param {number} index
 * @returns {ProviderLine|null}
 */
function providerLine(line, index) {
  const m = PROVIDER_RE.exec(line);
  if (!m) return null;
  const parsed = parseTomlString(m[2]);
  if (!parsed) throw new ConnectError('its model_provider is not a plain string; change it by hand');
  const was = WAS_RE.exec(parsed.comment);
  return was
    ? { index, indent: m[1], value: parsed.value, was: JSON.parse(was[1]), comment: was[2] }
    : { index, indent: m[1], value: parsed.value, was: null, comment: parsed.comment };
}

/**
 * The parts of a config.toml this module reads, located by line. `provider`
 * is the model_provider Codex uses: the one in the profile the root `profile`
 * key selects when that profile sets one, since it wins over the root key.
 * @param {string|null} text
 */
function parseCodexConfig(text) {
  const eol = (text ?? '').includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const inString = multilineContinuations(lines);
  const paths = lines.map((line, i) => (inString[i] ? null : headerPath(line)));
  const firstHeader = paths.findIndex(Boolean);
  const topEnd = firstHeader < 0 ? lines.length : firstHeader;

  /** @type {ProviderLine|null} */
  let top = null;
  /** @type {string|null} */
  let profile = null;
  for (let i = 0; i < topEnd; i++) {
    if (inString[i]) continue;
    if (/^\s*model_providers\s*\.\s*["']?teamclaude\b/.test(lines[i])) throw unsupportedProvider();
    if (/^\s*profiles\s*\./.test(lines[i]) && DOTTED_PROFILE_PROVIDER_RE.test(lines[i])) throw dottedProfileProvider();
    const p = PROFILE_RE.exec(lines[i]);
    if (p) profile = parseTomlString(p[1])?.value ?? null;
    const found = providerLine(lines[i], i);
    if (!found) continue;
    if (top) throw new ConnectError('it sets model_provider more than once; fix that by hand');
    top = found;
  }
  /** @type {ProviderLine|null} */
  let profileProvider = null;

  /** @type {{ start: number, end: number }[]} */
  const tables = [];
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = topEnd; i < lines.length; i++) {
    const path = paths[i];
    if (!path) continue;
    let end = i + 1;
    while (end < lines.length && (!paths[end] || (isOurTable(path) && isOurTable(paths[end])))) end++;
    if (profile != null && path.length === 2 && path[0] === 'profiles' && path[1] === profile) {
      for (let k = i + 1; k < end; k++) {
        const found = inString[k] ? null : providerLine(lines[k], k);
        if (!found) continue;
        if (profileProvider) throw new ConnectError(`profile "${profile}" sets model_provider more than once; fix that by hand`);
        profileProvider = found;
      }
    }
    if (path.length === 1 && path[0] === 'profiles'
      && lines.slice(i + 1, end).some((l, k) => !inString[i + 1 + k] && DOTTED_PROFILE_PROVIDER_RE.test(l))) throw dottedProfileProvider();
    if (path.length === 1 && path[0] === 'model_providers'
      && lines.slice(i + 1, end).some(l =>/^\s*["']?teamclaude["']?\s*[.=]/.test(l))) throw unsupportedProvider();
    if (isOurTable(path)) {
      if (path.length === 2) {
        for (let k = i + 1; k < end; k++) {
          if (inString[k]) continue;
          const line = lines[k];
          const kv = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
          const parsed = kv && parseTomlString(kv[2]);
          if (kv && parsed) fields[kv[1]] = parsed.value;
        }
      }
      // Comments and blank lines closing the range belong to whatever follows.
      let last = end;
      while (last > i + 1 && /^\s*(#.*)?$/.test(lines[last - 1])) last--;
      tables.push({ start: i, end: last });
    }
    i = end - 1;
  }
  return { eol, lines, topEnd, top, provider: profileProvider ?? top, profile: profileProvider ? profile : null, tables, fields };
}

function unsupportedProvider() {
  return new ConnectError('it defines model_providers.teamclaude in a form this command does not edit; change it by hand');
}

// `profiles.work.model_provider = ...` at the root, or `work.model_provider`
// inside `[profiles]`: the profile key this module reads, in dotted form.
const DOTTED_PROFILE_PROVIDER_RE = /^\s*(?:profiles\s*\.\s*)?["']?[\w-]+["']?\s*\.\s*model_provider\s*=/;

function dottedProfileProvider() {
  return new ConnectError("it sets a profile's model_provider as a dotted key, a form this command does not edit; change it by hand");
}

/** @param {string} line */
const isBlank = line => !line.trim();

/**
 * @param {string[]} lines
 * @param {string} eol
 */
function joinLines(lines, eol) {
  const out = [...lines];
  while (out.length && isBlank(out[out.length - 1])) out.pop();
  return out.length ? out.join(eol) + eol : '';
}

/**
 * `source` with our provider tables taken out, or with the first one swapped
 * for `replacement` in place. `tables` are ranges into `source`, so an edit
 * made before this must keep the line count.
 * @param {string[]} source
 * @param {{ start: number, end: number }[]} tables
 * @param {string[]|null} [replacement]
 */
function withoutOurTables(source, tables, replacement = null) {
  const lines = [...source];
  for (let n = tables.length - 1; n >= 0; n--) {
    const { start, end } = tables[n];
    if (n === 0 && replacement) { lines.splice(start, end - start, ...replacement); continue; }
    lines.splice(start, end - start);
    if (start > 0 && isBlank(lines[start - 1]) && (start >= lines.length || isBlank(lines[start]))) lines.splice(start - 1, 1);
  }
  return lines;
}

/**
 * The text of a provider line after a connect, keeping the operator's comment.
 * @param {ProviderLine} line
 * @param {string} value
 * @param {string|null} was  the value it replaced, to restore on disconnect
 */
function providerText(line, value, was) {
  const notes = [was != null ? `# teamclaude: was ${JSON.stringify(was)}` : '', line.comment].filter(Boolean).join(' ');
  return `${line.indent}model_provider = ${JSON.stringify(value)}${notes ? ` ${notes}` : ''}`;
}

// Cannot occur in a text file: TOML forbids a raw NUL.
const DELETED_LINE = '\u0000teamclaude: deleted line';

/** @param {string} target */
function ourTable(target) {
  return [`[model_providers.${PROVIDER_NAME}]`, `name = "${PROVIDER_NAME}"`, `base_url = ${JSON.stringify(target)}`, 'wire_api = "responses"'];
}

/** @type {Codec} */
export const codexCodec = {
  inspect(text, target) {
    const { provider, profile, tables, fields } = parseCodexConfig(text);
    if (fields.base_url && !sameAddress(fields.base_url, target)) return { state: 'elsewhere', current: fields.base_url };
    if (!provider) return { state: 'disconnected' };
    if (provider.value !== PROVIDER_NAME) {
      return { state: 'elsewhere', current: `${profile != null ? `profile "${profile}" ` : ''}model_provider "${provider.value}"` };
    }
    // model_provider names us but the table is missing or partial: Codex fails
    // on that as it stands, and connecting writes the table.
    if (!tables.length || !fields.base_url || fields.wire_api !== 'responses') return { state: 'disconnected' };
    return { state: 'connected' };
  },
  apply(text, target) {
    const doc = parseCodexConfig(text);
    const table = ourTable(target);
    // The provider line is rewritten while its index still holds, before any
    // table moves. A new root line goes in after: the root region sits above
    // every table, so moving them does not shift it.
    const edited = [...doc.lines];
    if (doc.provider && doc.provider.value !== PROVIDER_NAME) {
      edited[doc.provider.index] = providerText(doc.provider, PROVIDER_NAME, doc.provider.value);
    }
    const lines = withoutOurTables(edited, doc.tables, table);
    if (!doc.tables.length) {
      while (lines.length && isBlank(lines[lines.length - 1])) lines.pop();
      if (lines.length) lines.push('');
      lines.push(...table);
    }
    const ours = `model_provider = "${PROVIDER_NAME}"`;
    if (!doc.provider) {
      // Above any comment that introduces the first table.
      let k = doc.topEnd;
      while (k > 0 && /^\s*(#.*)?$/.test(lines[k - 1])) k--;
      lines.splice(k, 0, ours);
      if (k + 1 < lines.length && !isBlank(lines[k + 1])) lines.splice(k + 1, 0, '');
    }
    return joinLines(lines, doc.eol);
  },
  remove(text) {
    const doc = parseCodexConfig(text);
    const top = /** @type {ProviderLine} */ (doc.provider);
    // Edited in place and a deleted line marked, not spliced, so the table
    // ranges stay valid; the mark is found again once the tables are gone.
    const edited = [...doc.lines];
    edited[top.index] = top.was != null ? providerText(top, top.was, null) : DELETED_LINE;
    const lines = withoutOurTables(edited, doc.tables);
    const at = lines.indexOf(DELETED_LINE);
    if (at >= 0) {
      lines.splice(at, 1);
      if ((at === 0 || isBlank(lines[at - 1])) && at < lines.length && isBlank(lines[at])) lines.splice(at, 1);
    }
    return joinLines(lines, doc.eol);
  },
};

// ── Grok Build: GROK_CLI_CHAT_PROXY_BASE_URL ────────────────────────────────

const GROK_VAR = 'GROK_CLI_CHAT_PROXY_BASE_URL';
const GROK_MARKER = '# teamclaude grok';
const RC_ASSIGN_RE = new RegExp(`^\\s*(?:export\\s+)?${GROK_VAR}=(\\S+)|^\\s*set\\s+(?:-\\w+\\s+)*${GROK_VAR}\\s+(\\S+)`);

/** @param {string} raw */
const unquote = raw => raw.replace(/^'(.*)'$|^"(.*)"$/, '$1$2');

/**
 * The managed rc line: what it sets, as each shell family spells it.
 * @param {string} shell
 * @param {string} value  a URL this module built, so it holds no quote
 */
function grokRcLine(shell, value) {
  return shell === 'fish' ? `set -gx ${GROK_VAR} '${value}'` : `export ${GROK_VAR}='${value}'`;
}

/**
 * The variable in a shell rc file: a line under our marker, or someone
 * else's assignment, which reads as `elsewhere`.
 * @param {string} shell
 * @returns {Codec}
 */
export function grokRcCodec(shell) {
  /** @param {string} line */
  const valueOf = line => {
    const m = RC_ASSIGN_RE.exec(line);
    return m ? unquote(m[1] ?? m[2]) : null;
  };
  return {
    inspect(text, target) {
      const managed = text == null ? null : markedLine(text, GROK_MARKER);
      const value = managed != null ? valueOf(managed)
        : (text ?? '').split('\n').map(valueOf).filter(v => v != null).pop() ?? null;
      if (value == null) return { state: 'disconnected' };
      if (managed != null && sameAddress(value, target)) return { state: 'connected' };
      return { state: 'elsewhere', current: value };
    },
    apply: (text, target) => setMarkedLine(text ?? '', GROK_MARKER, grokRcLine(shell, target)),
    remove: text => removeMarkedLine(text ?? '', GROK_MARKER),
  };
}

/**
 * The variable's value in the Windows user environment.
 * @type {Codec}
 */
export const grokEnvCodec = {
  inspect(text, target) {
    if (!text) return { state: 'disconnected' };
    return sameAddress(text, target) ? { state: 'connected' } : { state: 'elsewhere', current: text };
  },
  apply: (_text, target) => target,
  remove: () => null,
};

// ── Stores ──────────────────────────────────────────────────────────────────

/**
 * @param {string} path
 * @returns {Store}
 */
function fileStore(path) {
  return {
    where: path,
    async read() {
      try { return await readFile(path, 'utf8'); } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
        throw err;
      }
    },
    async write(text) {
      await mkdir(dirname(path), { recursive: true });
      writeFileAtomic(path, text ?? '');
    },
  };
}

/**
 * The persistent user environment, through .NET: SetEnvironmentVariable with
 * the User target broadcasts WM_SETTINGCHANGE, so a terminal opened afterwards
 * sees the change without signing out.
 * @param {string} name
 * @param {PowerShellRunner} run
 * @returns {Store}
 */
function windowsUserEnvStore(name, run) {
  return {
    where: 'Windows user environment',
    async read() {
      const out = (await run(`[Environment]::GetEnvironmentVariable('${name}', 'User')`)).trim();
      return out || null;
    },
    async write(value) {
      if (value == null) await run(`[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`);
      else await run(`[Environment]::SetEnvironmentVariable('${name}', $env:TEAMCLAUDE_CONNECT_VALUE, 'User')`, { TEAMCLAUDE_CONNECT_VALUE: value });
    },
  };
}

/** @type {PowerShellRunner} */
function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`PowerShell failed: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout));
    });
  });
}

/** @returns {ConnectContext} */
export function defaultContext() {
  return { platform: process.platform, env: process.env, home: homedir(), runPowerShell };
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * @type {Record<ClientId, { label: string, suffix: string, note?: string, settings: (ctx: ConnectContext) => { store: Store, codec: Codec } }>}
 */
export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    suffix: '',
    settings: ctx => ({
      store: fileStore(join(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude'), 'settings.json')),
      codec: claudeCodec,
    }),
  },
  codex: {
    label: 'Codex CLI',
    suffix: PROVIDERS.codex.pathPrefix,
    settings: ctx => ({
      store: fileStore(join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'config.toml')),
      codec: codexCodec,
    }),
  },
  grok: {
    label: 'Grok Build',
    suffix: `${PROVIDERS.grok.pathPrefix}/v1`,
    note: 'Grok Build reads this when it starts, from a terminal opened after the change.',
    settings: ctx => {
      if (ctx.platform === 'win32') return { store: windowsUserEnvStore(GROK_VAR, ctx.runPowerShell), codec: grokEnvCodec };
      const shell = detectShell(ctx.env);
      return { store: fileStore(rcPathForShell(shell, ctx.home, ctx.env)), codec: grokRcCodec(shell) };
    },
  },
};

export const CLIENT_IDS = /** @type {ClientId[]} */ (Object.keys(CLIENTS));

/**
 * Client names as typed (`all`, or any of the ids), as a list of ids in
 * registry order. No names means all of them.
 * @param {unknown[]} names
 * @returns {ClientId[]}
 */
export function parseClientIds(names) {
  if (!names.length || names.includes('all')) return [...CLIENT_IDS];
  const unknown = names.filter(n => !CLIENT_IDS.includes(/** @type {ClientId} */ (n)));
  if (unknown.length) throw new ConnectError(`unknown client ${unknown.map(n => JSON.stringify(n)).join(', ')}: use all, ${CLIENT_IDS.join(', ')}`);
  return CLIENT_IDS.filter(id => names.includes(id));
}

/**
 * @param {ClientId} id
 * @param {string} origin
 * @param {ConnectContext} ctx
 */
function resolve(id, origin, ctx) {
  const entry = CLIENTS[id];
  const base = { id, label: entry.label, ...(entry.note ? { note: entry.note } : {}) };
  return { base, target: origin + entry.suffix, ...entry.settings(ctx) };
}

/**
 * Where one client's setting stands now.
 * @param {ClientId} id
 * @param {string} origin  loopbackOrigin's answer
 * @param {ConnectContext} [ctx]
 * @returns {Promise<ClientStatus>}
 */
export async function clientStatus(id, origin, ctx = defaultContext()) {
  const { base, target, store, codec } = resolve(id, origin, ctx);
  try {
    return { ...base, where: store.where, ...codec.inspect(await store.read(), target) };
  } catch (err) {
    return { ...base, where: store.where, state: 'unreadable', problem: /** @type {Error} */ (err).message };
  }
}

/**
 * Connect or disconnect one client. Reads the setting first and writes only
 * the difference, so running it twice is the same as once.
 * @param {ConnectAction} action
 * @param {ClientId} id
 * @param {string} origin
 * @param {{ replace?: boolean }} opts
 * @param {ConnectContext} ctx
 */
async function act(action, id, origin, { replace = false }, ctx) {
  const { target, store, codec } = resolve(id, origin, ctx);
  const text = await store.read();
  const seen = codec.inspect(text, target);
  if (action === 'connect') {
    if (seen.state === 'elsewhere' && !replace) {
      throw new ConnectError(`already set to ${seen.current}, left as it is.`, { replaceable: true });
    }
    if (seen.state !== 'connected') await store.write(codec.apply(text, target));
  } else if (seen.state === 'connected') {
    await store.write(codec.remove(text, target));
  }
}

/**
 * Run `action` on each client in turn. A client that fails does not stop the
 * others; its reason is in `errors` and its status says where it stands.
 * @param {ConnectAction} action
 * @param {ClientId[]} ids
 * @param {string} origin
 * @param {{ replace?: boolean }} [opts]
 * @param {ConnectContext} [ctx]
 * @returns {Promise<{ clients: ClientStatus[], errors: { id: ClientId, error: string, replaceable?: true }[] }>}
 */
export async function runClientAction(action, ids, origin, opts = {}, ctx = defaultContext()) {
  /** @type {{ id: ClientId, error: string, replaceable?: true }[]} */
  const errors = [];
  /** @type {ClientStatus[]} */
  const clients = [];
  for (const id of ids) {
    try {
      await act(action, id, origin, opts, ctx);
    } catch (err) {
      const replaceable = err instanceof ConnectError && err.replaceable;
      errors.push({ id, error: `${CLIENTS[id].label}: ${/** @type {Error} */ (err).message}`, ...(replaceable ? { replaceable: /** @type {const} */ (true) } : {}) });
    }
    clients.push(await clientStatus(id, origin, ctx));
  }
  return { clients, errors };
}
