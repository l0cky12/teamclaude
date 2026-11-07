// `teamclaude desktop`: start the proxy in the background if it is not
// running, then open the dashboard. It is what the Windows installer's
// TeamClaude.exe runs, so one double-click gives a person with no terminal a
// running proxy and the page to set it up from. It works the same on macOS and
// Linux.
//
// Running it again while the proxy is up only opens the page. A second copy
// started at the same moment loses the port to the first, and this then opens
// the page of whichever one won.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './login-flow.js';

const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * @typedef {object} StartedServer
 * @property {number|undefined} pid
 * @property {() => string|null} exited  why the child is gone, or null while it runs
 */

/**
 * The pid a TeamClaude server on `host:port` reports, or null when nothing
 * answers there, the answer is not a status reply, or it takes over 2 s.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} [apiKey]
 * @returns {Promise<number|null>}
 */
export async function probeServer(host, port, apiKey) {
  try {
    const res = await fetch(`http://${urlHost(host)}:${port}/teamclaude/status`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) { await res.arrayBuffer(); return null; }
    const pid = (await res.json())?.server?.pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `server --headless` as a detached child with no window, writing to
 * `logFile`, that keeps running after this process exits.
 *
 * @param {string} logFile
 * @returns {StartedServer}
 */
export function startDetachedServer(logFile) {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  /** @type {string|null} */
  let gone = null;
  try {
    const child = spawn(process.execPath, [ENTRY, 'server', '--headless'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.once('exit', (code, signal) => { gone = signal ? `signal ${signal}` : `exit code ${code}`; });
    child.once('error', err => { gone = err.message; });
    child.unref();
    return { pid: child.pid, exited: () => gone };
  } finally {
    closeSync(fd);
  }
}

/**
 * Make sure a server is up on `host:port`, starting one if not, and open its
 * dashboard unless `open` is false.
 *
 * Readiness after a start is a status reply carrying the started child's own
 * pid. Another server answering means a second launch won the port; once the
 * child has exited on that, the other server is the one to open.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} [opts.apiKey]
 * @param {string} opts.logFile
 * @param {boolean} [opts.open]
 * @param {number} [opts.timeoutMs]
 * @param {() => Promise<number|null>} [opts.probe]
 * @param {(logFile: string) => StartedServer} [opts.start]
 * @param {(url: string, opts?: { wait?: boolean }) => Promise<void>} [opts.openUrl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @returns {Promise<{ url: string, pid: number, started: boolean }>}
 */
export async function launchDesktop({
  host, port, apiKey, logFile, open = true, timeoutMs = 20_000,
  probe = () => probeServer(host, port, apiKey),
  start = startDetachedServer,
  openUrl = openBrowser,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const url = `http://${urlHost(host)}:${port}/teamclaude/dashboard`;
  let pid = await probe();
  let started = false;
  if (pid == null) {
    const child = start(logFile);
    pid = await waitForServer(child, { probe, sleep, now, timeoutMs, logFile });
    started = pid === child.pid;
  }
  if (open) await openUrl(url, { wait: true });
  return { url, pid, started };
}

/**
 * @param {StartedServer} child
 * @param {{ probe: () => Promise<number|null>, sleep: (ms: number) => Promise<void>, now: () => number, timeoutMs: number, logFile: string }} opts
 * @returns {Promise<number>}
 */
async function waitForServer(child, { probe, sleep, now, timeoutMs, logFile }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    // Read before the probe: a pid that answers after the child has gone is
    // the other launch's server, and a match before then is the child itself.
    const gone = child.exited();
    const pid = await probe();
    if (pid != null && (pid === child.pid || gone)) return pid;
    if (gone) throw new Error(`The proxy stopped while starting (${gone}). See the log: ${logFile}`);
    if (now() >= deadline) throw new Error(`The proxy did not answer within ${Math.round(timeoutMs / 1000)} s of starting. See the log: ${logFile}`);
    await sleep(250);
  }
}

/** @param {string} host */
function urlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}
