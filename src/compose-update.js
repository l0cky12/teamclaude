// A host timer that keeps a docker compose checkout up to date.
//
// The proxy inside the image cannot do this. The image has no git checkout,
// no Docker socket and no npm, and it sets TEAMCLAUDE_DISABLE_AUTOUPDATE, so
// the npm self-update in updater.js never runs there and must not grow a
// docker-socket escape hatch. The operator runs this on the host, from the
// checkout `docker compose` builds. The timer runs scripts/redeploy.sh, which
// is `git pull --ff-only`, `docker compose build` while the old container
// keeps serving, and `docker compose up -d`, and which puts the previous
// image back when the new container does not come up healthy.
//
// Nothing is scheduled until `teamclaude update compose install`. The npm
// auto-update stays what it is: a global install, never a git checkout.
// The unit keeps the Docker and Compose settings captured at install. A
// user timer does not see the shell, and launchd bootout is refused while
// a redeploy is still running: that signal would kill the script with no
// chance to finish putting the previous image back.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from './brand.js';
import { serviceKind, systemdQuote } from './service.js';

export const COMPOSE_UPDATE_LABEL = 'com.karpeleslab.teamclaude.compose-update';
export const COMPOSE_UPDATE_SERVICE = 'teamclaude-compose-update.service';
export const COMPOSE_UPDATE_TIMER = 'teamclaude-compose-update.timer';

const MIN_SECONDS = 15 * 60;
const MAX_SECONDS = 30 * 24 * 60 * 60;
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export const COMPOSE_UPDATE_USAGE = `Usage: teamclaude update compose <install|uninstall|status|print> [--every 1d] [--env KEY=VALUE]

Installs a per-user timer that runs scripts/redeploy.sh in this checkout:
git pull, docker compose build, docker compose up -d. The running proxy stays
up during the build, and an unhealthy new container is rolled back. Nothing
runs until you install it. The interval is 15m to 30d; the default is 1d.

The timer does not see your shell. Docker and Compose settings that choose
the daemon or the project are copied in when they are set at install, and a
variable the compose file requires (for example TAILSCALE_IP) must be set
then too. Pass --env KEY=VALUE, or export it in the shell you install from.
A project .env file is left for Compose to read.

Run this on the host, from the git checkout docker compose builds. The copy
inside the container cannot see that checkout or the Docker socket, and the
command refuses to install from there.`;

/**
 * @typedef {Object} CommandResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} ComposeUpdateOpts
 * @property {string} [every]
 * @property {string} [root]
 * @property {'systemd' | 'launchd' | null} [kind]
 * @property {string} [home]
 * @property {string | null} [xdgConfig]
 * @property {number | undefined} [uid]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {boolean} [inContainer]
 * @property {string} [platform]
 * @property {(name: string) => string | null} [lookup]
 * @property {(cmd: string, args: string[]) => CommandResult} [run]
 * @property {(path: string) => boolean} [exists]
 * @property {(line: string) => void} [log]
 */

/**
 * @typedef {Object} ComposeContext
 * @property {string} every
 * @property {string} root
 * @property {'systemd' | 'launchd' | null} kind
 * @property {string} home
 * @property {string | null} xdgConfig
 * @property {number | undefined} uid
 * @property {NodeJS.ProcessEnv} env
 * @property {boolean} inContainer
 * @property {string} platform
 * @property {(name: string) => string | null} lookup
 * @property {(cmd: string, args: string[]) => CommandResult} run
 * @property {(path: string) => boolean} exists
 * @property {(line: string) => void} log
 */

/** Package root = one directory above this file's src/ directory. */
function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {CommandResult}
 */
function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/**
 * `command -v` for the two binaries the timer needs. The name is a fixed
 * argument, not interpolated into the shell.
 * @param {string} name
 * @returns {string | null}
 */
function defaultLookup(name) {
  if (name !== 'git' && name !== 'docker') return null;
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'lookup', name], { encoding: 'utf8' });
  const line = String(r.stdout || '').trim().split('\n')[0];
  return r.status === 0 && line ? line : null;
}

/**
 * @param {ComposeUpdateOpts} [opts]
 * @returns {ComposeContext}
 */
function context(opts = {}) {
  return {
    every: opts.every ?? '1d',
    root: opts.root ?? packageRoot(),
    kind: opts.kind === undefined ? serviceKind() : opts.kind,
    home: opts.home ?? homedir(),
    xdgConfig: opts.xdgConfig === undefined ? process.env.XDG_CONFIG_HOME ?? null : opts.xdgConfig,
    uid: opts.uid === undefined ? process.getuid?.() : opts.uid,
    env: opts.env ?? process.env,
    inContainer: opts.inContainer ?? runningInContainer(),
    platform: opts.platform ?? process.platform,
    lookup: opts.lookup ?? defaultLookup,
    run: opts.run ?? defaultRun,
    exists: opts.exists ?? existsSync,
    log: opts.log ?? console.log,
  };
}

/**
 * The image and Podman both mark themselves. A timer installed in there
 * would schedule work the container cannot do.
 * @param {(path: string) => boolean} [exists]
 */
export function runningInContainer(exists = existsSync) {
  return exists('/.dockerenv') || exists('/run/.containerenv');
}

/**
 * @param {string | null | undefined} value
 * @returns {number | null} seconds, or null when the value is not 15m..30d
 */
export function parseEvery(value) {
  const m = /^(\d+)(m|h|d)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  const unit = m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 86400;
  const seconds = n * unit;
  if (seconds < MIN_SECONDS || seconds > MAX_SECONDS) return null;
  return seconds;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatEvery(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}min`;
  return `${seconds}s`;
}

/**
 * A wall-clock expression for intervals that land on the clock, so a missed
 * day is caught up. Null for intervals that do not (90 minutes, 2 days):
 * those use a monotonic timer instead.
 * @param {number} seconds
 * @returns {string | null}
 */
export function calendarFor(seconds) {
  if (seconds === 86400) return 'daily';
  if (seconds === 3600) return 'hourly';
  if (seconds % 3600 === 0 && 86400 % seconds === 0) return `*-*-* 00/${seconds / 3600}:00:00`;
  if (seconds < 3600 && seconds % 60 === 0 && 3600 % seconds === 0) {
    const mins = String(seconds / 60).padStart(2, '0');
    return `*-*-* *:00/${mins}:00`;
  }
  return null;
}

/**
 * Spread a fleet of checkouts, and keep a 15-minute timer from all firing
 * at the same second. Never more than a quarter of the interval.
 * @param {number} seconds
 * @returns {string | null}
 */
export function randomizedDelay(seconds) {
  const minutes = Math.floor(Math.min(15 * 60, Math.floor(seconds / 4)) / 60);
  return minutes >= 1 ? `${minutes}min` : null;
}

/**
 * Directories the timer's PATH has to carry: wherever git and docker
 * actually are, plus the usual system locations. A user timer does not
 * inherit the shell's PATH.
 * @param {string} gitBin
 * @param {string} dockerBin
 */
export function updaterPath(gitBin, dockerBin) {
  const dirs = [dirname(gitBin), dirname(dockerBin), '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs.filter(Boolean))].join(':');
}

/**
 * Specifier expansion still runs inside quotes (`%h` would become the home
 * directory). `%%` is a literal percent. This is the right escaping for
 * ExecStart= and Environment=, which are command lines and do strip quotes.
 * @param {string} value
 */
function systemdField(value) {
  return systemdQuote(value.replaceAll('%', '%%'));
}

/**
 * WorkingDirectory= is not a command line. systemd-analyze verify keeps a
 * surrounding quote as part of the path (`path is not absolute: "/home/..."`),
 * so the value is the rest of the line, spaces included. A backslash is
 * literal here too: doubling it looks for a different directory. `%` is still
 * a specifier, so a literal percent is `%%`. Control characters are refused,
 * as in systemdQuote. A trailing backslash would glue on the next line, and
 * the parser strips trailing whitespace, so those paths are refused rather
 * than written wrong.
 * @param {string} value
 */
function systemdPath(value) {
  const s = String(value);
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new Error(`Cannot write a systemd unit with a control character in ${JSON.stringify(s)}`);
  }
  if (/[ \t\\]$/.test(s)) {
    throw new Error(`Cannot write a systemd path that ends with whitespace or a backslash: ${JSON.stringify(s)}`);
  }
  return s.replaceAll('%', '%%');
}

/**
 * disable/bootout of a job that was never loaded is success for uninstall.
 * Any other failure means the scheduler may still be running it, and deleting
 * the unit file would hide that.
 * @param {CommandResult} result
 */
function schedulerMissed(result) {
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  return /does not exist|not found|not-found|No such process|Could not find specified service|service is not loaded/i.test(text);
}

/**
 * @param {CommandResult} result
 * @param {string} fallback
 * @returns {string | null}
 */
function stopFailure(result, fallback) {
  if (result.code === 0 || schedulerMissed(result)) return null;
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

// A running redeploy has a pid. An idle timer is only waiting for the
// interval, and bootout of that one does not interrupt a container swap.
const REDEPLOY_BUSY = 'A compose update is still running. Wait for it to finish, then try again. Unloading it now would stop the script after the old container may already be gone.';

/**
 * @param {string} stdout
 */
function launchdIsRunning(stdout) {
  return /\bpid = [1-9]\d*\b/.test(stdout) || /\bstate = running\b/.test(stdout);
}

/**
 * @param {ComposeContext} c
 * @returns {string | null}
 */
function launchdBusyError(c) {
  const printed = c.run('launchctl', ['print', `gui/${c.uid ?? 0}/${COMPOSE_UPDATE_LABEL}`]);
  if (printed.code === 0 && launchdIsRunning(printed.stdout)) return REDEPLOY_BUSY;
  return null;
}

// Copied into the unit when set. These choose which daemon, context, or
// project `docker compose` talks to. The timer would otherwise use the
// user manager's empty environment and hit a different Docker.
const TARGETING_ENV = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'COMPOSE_PROJECT_DIRECTORY',
  'COMPOSE_PATH_SEPARATOR',
  'COMPOSE_ENV_FILES',
  'TEAMCLAUDE_REDEPLOY_TIMEOUT',
];

const RESERVED_ENV = new Set(['PATH', 'COMPOSE_FILE', 'TEAMCLAUDE_SERVICE', 'TEAMROUTER_SERVICE']);

/**
 * `--env KEY=VALUE` assignments. The value may itself contain `=`.
 * @param {string[]} items
 * @returns {{ ok: true, values: Record<string, string> } | { ok: false, error: string }}
 */
export function envAssignments(items) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const item of items) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(item);
    if (!m) return { ok: false, error: `--env ${JSON.stringify(item)} is not KEY=VALUE` };
    values[m[1]] = m[2];
  }
  return { ok: true, values };
}

/**
 * Variables a compose file interpolates, in the order they appear.
 * `${NAME:?message}` and `${NAME?message}` are required: Compose refuses
 * to start without them. A default (`${NAME:-value}`) is not required.
 * A bare `${NAME}` becomes empty when unset, which is Compose's own rule,
 * so it is not required either; a value that is set is still kept.
 * `$$` is a literal dollar.
 * @param {string} text
 * @returns {{ name: string, required: boolean }[]}
 */
export function composeInterpolations(text) {
  /** @type {Map<string, boolean>} */
  const found = new Map();
  const note = (/** @type {string} */ name, /** @type {boolean} */ required) => {
    const prev = found.get(name);
    if (prev === undefined) found.set(name, required);
    else if (required) found.set(name, true);
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$') continue;
    if (text[i + 1] === '$') { i += 1; continue; }
    if (text[i + 1] === '{') {
      const end = text.indexOf('}', i + 2);
      if (end < 0) continue;
      const body = text.slice(i + 2, end);
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(body);
      i = end;
      if (!m) continue;
      const op = m[2];
      const hasDefault = op.startsWith(':-') || op.startsWith('-') || op.startsWith(':+') || op.startsWith('+');
      const required = !hasDefault && (op.startsWith(':?') || op.startsWith('?'));
      note(m[1], required);
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + 1));
    if (!m) continue;
    note(m[1], false);
    i += m[1].length;
  }
  return [...found.entries()].map(([name, required]) => ({ name, required }));
}

/**
 * KEY=VALUE lines from a Compose env file. Quotes around the value are
 * removed; nothing in the value is executed.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function envFileValues(text) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(body);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

/**
 * @param {string} path
 * @returns {Map<string, string>}
 */
function readEnvFile(path) {
  try {
    return envFileValues(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return new Map();
    throw err;
  }
}

const xmlEscape = (/** @type {string} */ s) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * @param {string} value
 */
function xmlUnescape(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * @param {string} value a systemd assignment or word, quoted or not
 */
export function systemdUnquote(value) {
  let v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return v.replaceAll('%%', '%');
}

/**
 * @param {string} home
 * @param {string | null} xdgConfig
 */
export function composeUpdateServicePath(home, xdgConfig) {
  return join(xdgConfig || join(home, '.config'), 'systemd', 'user', COMPOSE_UPDATE_SERVICE);
}

/**
 * @param {string} home
 * @param {string | null} xdgConfig
 */
export function composeUpdateTimerPath(home, xdgConfig) {
  return join(xdgConfig || join(home, '.config'), 'systemd', 'user', COMPOSE_UPDATE_TIMER);
}

/** @param {string} home */
export function composeUpdateAgentPath(home) {
  return join(home, 'Library', 'LaunchAgents', `${COMPOSE_UPDATE_LABEL}.plist`);
}

/** @param {string} home */
export function composeUpdateLogPath(home) {
  return join(home, 'Library', 'Logs', 'teamclaude-compose-update.log');
}

/**
 * @typedef {Object} ComposePlan
 * @property {number} seconds
 * @property {string} everyLabel
 * @property {string} checkout
 * @property {string} script
 * @property {string} pathEnv
 * @property {string | null} composeFileEnv
 * @property {string | null} serviceName
 * @property {[string, string][]} deploymentEnv
 */

/**
 * @param {ComposeContext} c
 * @returns {{ ok: false, error: string } | ({ ok: true } & ComposePlan)}
 */
function inspect(c) {
  if (!c.kind) return { ok: false, error: `No timer integration for ${c.platform}.` };
  if (c.inContainer) {
    return { ok: false, error: 'Refusing to install from inside the container. Run this on the host, in the checkout that has your docker-compose.yml.' };
  }
  if (c.uid === 0) return { ok: false, error: 'Refusing to install a timer as root. Run it as the user who owns the checkout.' };
  const seconds = parseEvery(c.every);
  if (seconds == null) {
    return { ok: false, error: `--every ${JSON.stringify(c.every)} is not an interval between 15m and 30d (for example 15m, 12h, 1d).` };
  }
  const script = join(c.root, 'scripts', 'redeploy.sh');
  if (!c.exists(script)) {
    return { ok: false, error: `No scripts/redeploy.sh in ${c.root}. Run this from the git checkout docker compose builds: node src/index.js update compose install` };
  }
  if (!c.exists(join(c.root, '.git'))) {
    return { ok: false, error: `No .git in ${c.root}. scripts/redeploy.sh updates a git checkout.` };
  }
  const compose = composeFile(c);
  if (compose.error) return { ok: false, error: compose.error };
  const gitBin = c.lookup('git');
  if (!gitBin) return { ok: false, error: 'git was not found on PATH. The timer cannot pull without it.' };
  const dockerBin = c.lookup('docker');
  if (!dockerBin) return { ok: false, error: 'docker was not found on PATH. The timer cannot build without it.' };
  const named = envVar('SERVICE', c.env);
  const deployed = deploymentEnvironment(c, compose.files ?? []);
  if (deployed.ok === false) return { ok: false, error: deployed.error };
  return {
    ok: true,
    seconds,
    everyLabel: formatEvery(seconds),
    checkout: c.root,
    script,
    pathEnv: updaterPath(gitBin, dockerBin),
    composeFileEnv: compose.env ?? null,
    serviceName: named ? named : null,
    deploymentEnv: deployed.pairs,
  };
}

/**
 * @param {ComposeContext} c
 * @returns {{ env: string | null, files: string[], error?: undefined } | { env?: undefined, files?: undefined, error: string }}
 */
function composeFile(c) {
  const raw = c.env.COMPOSE_FILE;
  if (raw) {
    const parts = c.platform === 'win32' ? [raw] : raw.split(':');
    /** @type {string[]} */
    const files = [];
    for (const part of parts) {
      if (!part) return { error: 'COMPOSE_FILE is empty.' };
      const path = isAbsolute(part) ? part : join(c.root, part);
      // Only the first file has to exist. Compose accepts a later path that
      // is absent on this machine, and the raw value is what the timer runs.
      if (!files.length && !c.exists(path)) return { error: `COMPOSE_FILE names ${path}, which does not exist.` };
      if (c.exists(path)) files.push(path);
    }
    if (!files.length) return { error: 'COMPOSE_FILE is empty.' };
    return { env: raw, files };
  }
  for (const name of COMPOSE_NAMES) {
    const path = join(c.root, name);
    if (!c.exists(path)) continue;
    const files = [path];
    const override = path.replace(/(\.ya?ml)$/, '.override$1');
    if (override !== path && c.exists(override)) files.push(override);
    return { env: null, files };
  }
  return { error: `No compose file in ${c.root} (looked for ${COMPOSE_NAMES.join(', ')}). Set COMPOSE_FILE if it lives elsewhere.` };
}

/**
 * The project directory Compose uses: the first compose file's directory,
 * or the checkout when the default filename is discovered there. An explicit
 * COMPOSE_PROJECT_DIRECTORY wins, the same way the compose CLI does.
 * @param {ComposeContext} c
 * @param {string[]} files
 */
function projectDirectory(c, files) {
  const named = c.env.COMPOSE_PROJECT_DIRECTORY;
  if (named) return isAbsolute(named) ? named : join(c.root, named);
  if (c.env.COMPOSE_FILE && files[0]) return dirname(files[0]);
  return c.root;
}

/**
 * Values Compose will see from `.env` and COMPOSE_ENV_FILES. The shell is
 * not included; the caller already has that.
 * @param {ComposeContext} c
 * @param {string[]} files
 * @returns {Map<string, string>}
 */
function composeFileEnvironment(c, files) {
  const dir = projectDirectory(c, files);
  /** @type {Map<string, string>} */
  const merged = new Map();
  const paths = [join(dir, '.env')];
  const listed = c.env.COMPOSE_ENV_FILES;
  if (listed) {
    const parts = c.platform === 'win32' ? [listed] : listed.split(':');
    for (const part of parts) {
      if (!part) continue;
      paths.push(isAbsolute(part) ? part : join(dir, part));
    }
  }
  for (const path of paths) {
    for (const [key, value] of readEnvFile(path)) merged.set(key, value);
  }
  return merged;
}

/**
 * Environment written into the unit, beyond PATH, COMPOSE_FILE, and the
 * service name. Targeting variables are copied when the install environment
 * set them. Interpolation variables are copied the same way, and a required
 * one that is in neither the environment nor the project env file is an error.
 * @param {ComposeContext} c
 * @param {string[]} files
 * @returns {{ ok: true, pairs: [string, string][] } | { ok: false, error: string }}
 */
function deploymentEnvironment(c, files) {
  /** @type {Map<string, string>} */
  const pairs = new Map();
  /** @type {string[]} */
  const missing = [];
  let fileEnv = new Map();
  try {
    fileEnv = composeFileEnvironment(c, files);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue;
      return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const item of composeInterpolations(text)) {
      if (RESERVED_ENV.has(item.name)) continue;
      const fromShell = c.env[item.name];
      if (typeof fromShell === 'string' && fromShell !== '') {
        pairs.set(item.name, fromShell);
        continue;
      }
      const fromFile = fileEnv.get(item.name);
      if (typeof fromFile === 'string' && fromFile !== '') continue;
      if (item.required) missing.push(item.name);
    }
  }
  if (missing.length) {
    const names = [...new Set(missing)];
    return {
      ok: false,
      error: `The compose file requires ${names.join(', ')}. The timer does not see your shell. Export it before installing, or pass --env ${names[0]}=... A value in the project .env file counts, and is left there for Compose to read.`,
    };
  }
  for (const key of TARGETING_ENV) {
    if (RESERVED_ENV.has(key) || pairs.has(key)) continue;
    const value = c.env[key];
    if (typeof value === 'string' && value !== '') pairs.set(key, value);
  }
  return { ok: true, pairs: [...pairs.entries()] };
}

/**
 * @param {ComposeContext} c
 * @param {ComposePlan} plan
 * @returns {{ ok: false, error: string } | { ok: true, serviceText: string, timerText: string | null, servicePath: string, timerPath: string | null, logFile: string | null }}
 */
function renderUnits(c, plan) {
  try {
    if (c.kind === 'launchd') {
      const logFile = composeUpdateLogPath(c.home);
      return {
        ok: true,
        serviceText: renderPlist(plan, logFile),
        timerText: null,
        servicePath: composeUpdateAgentPath(c.home),
        timerPath: null,
        logFile,
      };
    }
    return {
      ok: true,
      serviceText: renderSystemdService(plan),
      timerText: renderTimer(plan),
      servicePath: composeUpdateServicePath(c.home, c.xdgConfig),
      timerPath: composeUpdateTimerPath(c.home, c.xdgConfig),
      logFile: null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {ComposePlan} plan
 * @returns {string[]}
 */
function environmentAssignments(plan) {
  /** @type {string[]} */
  const assignments = [`PATH=${plan.pathEnv}`];
  if (plan.composeFileEnv) assignments.push(`COMPOSE_FILE=${plan.composeFileEnv}`);
  if (plan.serviceName) assignments.push(`TEAMCLAUDE_SERVICE=${plan.serviceName}`);
  for (const [key, value] of plan.deploymentEnv) assignments.push(`${key}=${value}`);
  return assignments;
}

/** @param {ComposePlan} plan */
function renderSystemdService(plan) {
  const env = environmentAssignments(plan).map((assignment) => `Environment=${systemdField(assignment)}`);
  // ExecStart is the script and nothing else. A shell here would be a place
  // for the checkout path or a service name to be parsed as code. The script
  // is the pull, the build and the restart.
  return `[Unit]
Description=Update TeamClaude with git pull, docker compose build, and docker compose up -d
Documentation=https://github.com/KarpelesLab/teamclaude

[Service]
Type=oneshot
# teamclaude-compose-checkout=${plan.checkout}
# teamclaude-compose-every=${plan.everyLabel}
# scripts/redeploy.sh pulls --ff-only, builds while the old container serves,
# restarts, and puts the previous image back if the new one is not healthy.
WorkingDirectory=${systemdPath(plan.checkout)}
ExecStart=${systemdField(plan.script)}
# No finite start timeout. The manager default is about 90s, and any deadline
# can SIGTERM the script after the old container is gone and before the
# rollback finishes. The script has no handler for that, so it has to be
# allowed to exit on its own.
TimeoutStartSec=infinity
${env.join('\n')}
`;
}

/** @param {ComposePlan} plan */
function renderTimer(plan) {
  const calendar = calendarFor(plan.seconds);
  // OnStartupSec alone is in the past for a login that is already older
  // than the interval, and the man page says that elapses immediately.
  // Pairing it with OnUnitActiveSec is what makes the later runs repeat.
  // Calendar intervals use Persistent= instead, which only catches a run
  // that was missed while the timer was inactive.
  const when = calendar
    ? `OnCalendar=${calendar}\nPersistent=true`
    : `OnStartupSec=${plan.everyLabel}\nOnUnitActiveSec=${plan.everyLabel}`;
  const delay = randomizedDelay(plan.seconds);
  const delayLine = delay ? `\nRandomizedDelaySec=${delay}` : '';
  return `[Unit]
Description=Update TeamClaude with git pull, docker compose build, and docker compose up -d
Documentation=https://github.com/KarpelesLab/teamclaude

[Timer]
# teamclaude-compose-every=${plan.everyLabel}
${when}
AccuracySec=1min${delayLine}

[Install]
WantedBy=timers.target
`;
}

/**
 * @param {ComposePlan} plan
 * @param {string} logFile
 */
function renderPlist(plan, logFile) {
  const env = environmentAssignments(plan).map((assignment) => {
    const eq = assignment.indexOf('=');
    const key = assignment.slice(0, eq);
    const value = assignment.slice(eq + 1);
    return `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${COMPOSE_UPDATE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(plan.script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.checkout)}</string>
  <key>StartInterval</key>
  <integer>${plan.seconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
</dict>
</plist>
`;
}

/**
 * @param {{ servicePath: string, timerPath: string | null, serviceText: string, timerText: string | null }} units
 */
function formatForPrint(units) {
  const parts = [`# ${units.servicePath}`, units.serviceText];
  if (units.timerPath && units.timerText) parts.push(`# ${units.timerPath}`, units.timerText);
  const text = parts.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * The units, without writing them. Same checks as install.
 * Fresh `{ ok: false }` objects, not the inner result: this file is checked
 * with strictNullChecks off, and a boolean `ok` on a returned union does not
 * narrow there, so handing the inner result back fails the outer return type.
 * @param {ComposeUpdateOpts} [opts]
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function renderComposeUpdate(opts = {}) {
  const c = context(opts);
  const plan = inspect(c);
  if (plan.ok === false) return { ok: false, error: plan.error };
  const units = renderUnits(c, plan);
  if (units.ok === false) return { ok: false, error: units.error };
  return { ok: true, text: formatForPrint(units) };
}

/**
 * @param {ComposeUpdateOpts} [opts]
 * @returns {Promise<{ ok: true, file: string, checkout: string, every: string } | { ok: false, error: string }>}
 */
export async function installComposeUpdate(opts = {}) {
  const c = context(opts);
  const plan = inspect(c);
  if (plan.ok === false) return { ok: false, error: plan.error };
  const units = renderUnits(c, plan);
  if (units.ok === false) return { ok: false, error: units.error };

  // Before the plist is replaced. bootout of a running job kills redeploy.sh,
  // and the script cannot finish a rollback after that.
  if (c.kind === 'launchd') {
    const busy = launchdBusyError(c);
    if (busy) return { ok: false, error: busy };
  }

  await mkdir(dirname(units.servicePath), { recursive: true });
  await writeFile(units.servicePath, units.serviceText, { mode: 0o644 });
  if (units.timerPath && units.timerText) await writeFile(units.timerPath, units.timerText, { mode: 0o644 });

  const captured = plan.deploymentEnv.map(([key]) => key);
  if (c.kind === 'launchd') {
    if (units.logFile) await mkdir(dirname(units.logFile), { recursive: true });
    const domain = `gui/${c.uid ?? 0}`;
    // bootstrap fails when the label is already loaded. Unload first, the
    // same way the proxy service does, so a reinstall replaces the plist.
    // The running check above is what keeps this from killing a redeploy.
    c.run('launchctl', ['bootout', `${domain}/${COMPOSE_UPDATE_LABEL}`]);
    const boot = c.run('launchctl', ['bootstrap', domain, units.servicePath]);
    if (boot.code !== 0) return { ok: false, error: boot.stderr.trim() || `launchctl bootstrap exited ${boot.code}` };
    c.log(`[TeamClaude] Compose auto-update installed: ${units.servicePath}`);
    c.log(`[TeamClaude] Every ${plan.everyLabel}: git pull, docker compose build, docker compose up -d (${plan.script}).`);
    c.log(`[TeamClaude] Checkout: ${plan.checkout}`);
    if (captured.length) c.log(`[TeamClaude] Deployment environment: ${captured.join(', ')}`);
    c.log(`[TeamClaude] Logs: ${units.logFile}`);
    return { ok: true, file: units.servicePath, checkout: plan.checkout, every: plan.everyLabel };
  }

  // A oneshot that has already started keeps running across daemon-reload.
  // Stopping the service would signal it mid-rollback, so this path never does.
  const reloaded = c.run('systemctl', ['--user', 'daemon-reload']);
  if (reloaded.code !== 0) return { ok: false, error: reloaded.stderr.trim() || `systemctl daemon-reload exited ${reloaded.code}` };
  // --now starts the timer, not the oneshot. The oneshot runs when the
  // timer elapses. enable of the service would not schedule anything.
  const enabled = c.run('systemctl', ['--user', 'enable', '--now', COMPOSE_UPDATE_TIMER]);
  if (enabled.code !== 0) return { ok: false, error: enabled.stderr.trim() || `systemctl enable exited ${enabled.code}` };
  c.log(`[TeamClaude] Compose auto-update installed: ${units.timerPath}`);
  c.log(`[TeamClaude] Every ${plan.everyLabel}: git pull, docker compose build, docker compose up -d (${plan.script}).`);
  c.log(`[TeamClaude] Checkout: ${plan.checkout}`);
  if (captured.length) c.log(`[TeamClaude] Deployment environment: ${captured.join(', ')}`);
  c.log(`[TeamClaude] Logs: journalctl --user --unit ${COMPOSE_UPDATE_SERVICE}`);
  c.log('[TeamClaude] To keep the timer with no session open: loginctl enable-linger $USER');
  return { ok: true, file: units.timerPath || units.servicePath, checkout: plan.checkout, every: plan.everyLabel };
}

/**
 * @param {ComposeUpdateOpts} [opts]
 * @returns {Promise<{ ok: true, file: string } | { ok: false, error: string }>}
 */
export async function uninstallComposeUpdate(opts = {}) {
  const c = context(opts);
  if (!c.kind) return { ok: false, error: `No timer integration for ${c.platform}.` };
  if (c.inContainer) return { ok: false, error: 'Refusing to change a timer from inside the container. Run this on the host.' };
  if (c.uid === 0) return { ok: false, error: 'Refusing to change a timer as root. Run it as the user who owns the checkout.' };
  if (c.kind === 'launchd') {
    const file = composeUpdateAgentPath(c.home);
    const busy = launchdBusyError(c);
    if (busy) return { ok: false, error: busy };
    const out = c.run('launchctl', ['bootout', `gui/${c.uid ?? 0}/${COMPOSE_UPDATE_LABEL}`]);
    const failed = stopFailure(out, `launchctl bootout exited ${out.code}`);
    if (failed) return { ok: false, error: failed };
    await rm(file, { force: true });
    c.log(`[TeamClaude] Compose auto-update removed: ${file}`);
    return { ok: true, file };
  }
  const service = composeUpdateServicePath(c.home, c.xdgConfig);
  const timer = composeUpdateTimerPath(c.home, c.xdgConfig);
  // disable --now of the timer leaves a oneshot that has already started.
  // `systemctl stop` on the service would kill it mid-rollback, so that is not done.
  const disabled = c.run('systemctl', ['--user', 'disable', '--now', COMPOSE_UPDATE_TIMER]);
  const disableFailed = stopFailure(disabled, `systemctl disable exited ${disabled.code}`);
  if (disableFailed) return { ok: false, error: disableFailed };
  // Drops the Persistent= stamp. A timer that was never loaded is not an error.
  const cleaned = c.run('systemctl', ['--user', 'clean', COMPOSE_UPDATE_TIMER, '--what=state']);
  const cleanFailed = stopFailure(cleaned, `systemctl clean exited ${cleaned.code}`);
  if (cleanFailed) return { ok: false, error: cleanFailed };
  await rm(service, { force: true });
  await rm(timer, { force: true });
  const reloaded = c.run('systemctl', ['--user', 'daemon-reload']);
  if (reloaded.code !== 0) return { ok: false, error: reloaded.stderr.trim() || reloaded.stdout.trim() || `systemctl daemon-reload exited ${reloaded.code}` };
  c.log(`[TeamClaude] Compose auto-update removed: ${timer}`);
  return { ok: true, file: timer };
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function checkoutFromService(text) {
  const marked = /^# teamclaude-compose-checkout=(.*)$/m.exec(text);
  if (marked) return marked[1];
  const wd = /^WorkingDirectory=(.*)$/m.exec(text);
  return wd ? systemdUnquote(wd[1]) : null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function everyFromTimer(text) {
  const marked = /^# teamclaude-compose-every=(\S+)/m.exec(text);
  if (marked) return marked[1];
  const span = /^OnUnitActiveSec=(.*)$/m.exec(text);
  if (span) return span[1].trim();
  if (/^OnCalendar=daily$/m.test(text)) return '1d';
  if (/^OnCalendar=hourly$/m.test(text)) return '1h';
  return null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function checkoutFromPlist(text) {
  const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return m ? xmlUnescape(m[1]) : null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function everyFromPlist(text) {
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
  if (!m) return null;
  return formatEvery(Number(m[1]));
}

/**
 * The next run, as an ISO timestamp.
 *
 * `systemctl show --property=NextElapseUSecRealtime --value` prints a local
 * clock time (`Fri 2026-11-06 00:00:00 CST`), not the microsecond count the
 * same property has on D-Bus. The clock time is read as local and the
 * timezone abbreviation is ignored: `CST` is not a unique zone, and this is
 * the form show prints by default. A bare integer is that microsecond count,
 * which is what the D-Bus property is and what some builds print instead.
 * Empty, `0` and `n/a` mean there is no realtime elapse (a monotonic timer
 * leaves this property unset).
 * @param {string} value
 * @returns {string | null}
 */
export function parseNextElapse(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'n/a' || raw === '0') return null;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) / 1000;
    if (!Number.isFinite(ms) || ms < 1_000_000_000_000) return null;
    return new Date(ms).toISOString();
  }
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * @param {ComposeUpdateOpts} [opts]
 * @returns {Promise<{ supported: boolean, refused: boolean, installed: boolean, active: boolean, detail: string, file: string | null, checkout: string | null, every: string | null, next: string | null, logs: string | null }>}
 */
export async function composeUpdateStatus(opts = {}) {
  const c = context(opts);
  const empty = {
    supported: false,
    refused: false,
    installed: false,
    active: false,
    detail: `No timer integration for ${c.platform}.`,
    file: /** @type {string | null} */ (null),
    checkout: /** @type {string | null} */ (null),
    every: /** @type {string | null} */ (null),
    next: /** @type {string | null} */ (null),
    logs: /** @type {string | null} */ (null),
  };
  if (c.inContainer) {
    return { ...empty, refused: true, detail: 'Refusing to look for a timer from inside the container. Run this on the host.' };
  }
  if (!c.kind) return empty;
  if (c.kind === 'launchd') {
    const file = composeUpdateAgentPath(c.home);
    const text = await readFile(file, 'utf8').catch(() => null);
    const printed = c.run('launchctl', ['print', `gui/${c.uid ?? 0}/${COMPOSE_UPDATE_LABEL}`]);
    return {
      supported: true,
      refused: false,
      installed: text != null,
      active: printed.code === 0,
      detail: text == null ? 'not installed' : (printed.code === 0 ? 'loaded' : 'not loaded'),
      file,
      checkout: text ? checkoutFromPlist(text) : null,
      every: text ? everyFromPlist(text) : null,
      next: null,
      logs: composeUpdateLogPath(c.home),
    };
  }
  const file = composeUpdateTimerPath(c.home, c.xdgConfig);
  const service = composeUpdateServicePath(c.home, c.xdgConfig);
  const timerText = await readFile(file, 'utf8').catch(() => null);
  const serviceText = await readFile(service, 'utf8').catch(() => null);
  const active = c.run('systemctl', ['--user', 'is-active', COMPOSE_UPDATE_TIMER]);
  const next = c.run('systemctl', ['--user', 'show', COMPOSE_UPDATE_TIMER, '--property=NextElapseUSecRealtime', '--value']);
  const state = active.stdout.trim();
  return {
    supported: true,
    refused: false,
    installed: timerText != null,
    active: state === 'active',
    detail: timerText == null ? 'not installed' : (state || 'unknown'),
    file,
    checkout: serviceText ? checkoutFromService(serviceText) : null,
    every: timerText ? everyFromTimer(timerText) : null,
    next: next.code === 0 ? parseNextElapse(next.stdout) : null,
    logs: `journalctl --user --unit ${COMPOSE_UPDATE_SERVICE}`,
  };
}
