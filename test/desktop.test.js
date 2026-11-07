import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchDesktop } from '../src/desktop.js';
import { closedPort } from '../test-helpers/spawn-server.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const pexec = promisify(execFile);

/** A probe that answers each call with the next value, then the last one forever. */
function answers(...values) {
  let calls = 0;
  const probe = async () => values[Math.min(calls++, values.length - 1)];
  return { probe, calls: () => calls };
}

function fakes() {
  const opened = [];
  const openOpts = [];
  const starts = [];
  let clock = 0;
  return {
    opened, openOpts, starts,
    openUrl: async (url, opts) => { opened.push(url); openOpts.push(opts); },
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
}

const base = { host: '127.0.0.1', port: 4100, logFile: '/logs/teamclaude.log' };

test('a proxy that is already up is not started again; its dashboard is opened', async () => {
  const f = fakes();
  const { probe } = answers(111);
  const res = await launchDesktop({ ...base, probe, start: () => { f.starts.push(1); return { pid: 1, exited: () => null }; }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 111, started: false });
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.opened, ['http://127.0.0.1:4100/teamclaude/dashboard']);
  // desktop exits right after, so the opener must be waited for (on Windows
  // an un-waited `start` is killed with this process).
  assert.deepEqual(f.openOpts, [{ wait: true }]);
});

test('a stopped proxy is started, waited for until it answers with its own pid, then opened', async () => {
  const f = fakes();
  const { probe } = answers(null, null, null, 222);
  const res = await launchDesktop({ ...base, probe, start: logFile => { f.starts.push(logFile); return { pid: 222, exited: () => null }; }, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 222, started: true });
  assert.deepEqual(f.starts, ['/logs/teamclaude.log']);
  assert.equal(f.opened.length, 1);
});

test('--no-open starts the proxy without opening anything', async () => {
  const f = fakes();
  const { probe } = answers(null, 333);
  const res = await launchDesktop({ ...base, open: false, probe, start: () => ({ pid: 333, exited: () => null }), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.started, true);
  assert.deepEqual(f.opened, []);
});

test('another server answering while the child still runs is not taken for it', async () => {
  const f = fakes();
  // A second launch's server comes up first; ours then loses the port and
  // exits, and only after that is the other one the server to open.
  let probes = 0;
  const probe = async () => (probes++ === 0 ? null : 999);
  const exited = () => (probes >= 3 ? 'exit code 1' : null);
  const res = await launchDesktop({ ...base, probe, start: () => ({ pid: 444, exited }), openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.deepEqual(res, { url: 'http://127.0.0.1:4100/teamclaude/dashboard', pid: 999, started: false });
  assert.equal(probes, 4, 'kept waiting while the child was alive');
  assert.equal(f.opened.length, 1);
});

test('a child that exits before answering fails at once, naming the log', async () => {
  const f = fakes();
  const { probe } = answers(null);
  await assert.rejects(
    launchDesktop({ ...base, probe, start: () => ({ pid: 555, exited: () => 'exit code 1' }), openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /stopped while starting \(exit code 1\)\. See the log: \/logs\/teamclaude\.log/,
  );
  assert.equal(f.now(), 0, 'did not wait for the deadline');
  assert.deepEqual(f.opened, []);
});

test('a child that never answers fails once the wait runs out, naming the log', async () => {
  const f = fakes();
  const { probe } = answers(null);
  await assert.rejects(
    launchDesktop({ ...base, timeoutMs: 20_000, probe, start: () => ({ pid: 666, exited: () => null }), openUrl: f.openUrl, sleep: f.sleep, now: f.now }),
    /did not answer within 20 s of starting\. See the log: \/logs\/teamclaude\.log/,
  );
  assert.equal(f.now(), 20_000);
  assert.deepEqual(f.opened, []);
});

test('an IPv6 bind is bracketed in the dashboard address', async () => {
  const f = fakes();
  const res = await launchDesktop({ ...base, host: '::1', probe: async () => 1, openUrl: f.openUrl, sleep: f.sleep, now: f.now });
  assert.equal(res.url, 'http://[::1]:4100/teamclaude/dashboard');
});

/** `teamclaude desktop --no-open` as a person runs it, against a throwaway home. */
function runDesktop(dir, configPath) {
  const env = {
    ...process.env,
    HOME: dir, XDG_STATE_HOME: join(dir, 'state'),
    TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
  };
  // The detached server inherits this environment too: see test/README.md.
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  return pexec(process.execPath, [cliPath, 'desktop', '--no-open'], { env, encoding: 'utf8' });
}

test('desktop starts a real detached server once and finds it the second time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-desktop-'));
  const configPath = join(dir, 'config.json');
  /** @type {number|null} */
  let serverPid = null;
  try {
    let first;
    // A port this test picked can be taken by a neighbouring test's server
    // before the child binds it; that server then reads as "already running".
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = await closedPort();
      await writeFile(configPath, JSON.stringify({ proxy: { port }, upstreamProxy: false, autoUpdate: false }));
      first = await runDesktop(dir, configPath);
      if (/^Started the proxy/m.test(first.stdout)) break;
    }
    const started = /^Started the proxy \(pid (\d+)\)/m.exec(first.stdout);
    assert.ok(started, `desktop did not start a server:\n${first.stdout}${first.stderr}`);
    serverPid = Number(started[1]);

    const log = await readFile(join(dir, 'state', 'teamclaude.log'), 'utf8');
    assert.match(log, /No accounts configured yet/, 'the server wrote its output to the log');

    const second = await runDesktop(dir, configPath);
    assert.match(second.stdout, new RegExp(`^The proxy is already running \\(pid ${serverPid}\\)`, 'm'));
  } finally {
    if (serverPid) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
