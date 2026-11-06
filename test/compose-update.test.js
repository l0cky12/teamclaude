import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calendarFor, checkoutFromPlist, checkoutFromService, composeUpdateAgentPath, composeUpdateLogPath,
  composeUpdateServicePath, composeUpdateStatus, composeUpdateTimerPath, everyFromPlist, everyFromTimer,
  formatEvery, installComposeUpdate, parseEvery, parseNextElapse, randomizedDelay, renderComposeUpdate,
  runningInContainer, systemdUnquote, uninstallComposeUpdate, updaterPath, COMPOSE_UPDATE_LABEL,
  COMPOSE_UPDATE_SERVICE, COMPOSE_UPDATE_TIMER,
} from '../src/compose-update.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const indexPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('parseEvery accepts 15m through 30d and rejects the rest', () => {
  assert.equal(parseEvery('15m'), 15 * 60);
  assert.equal(parseEvery('12h'), 12 * 3600);
  assert.equal(parseEvery('1d'), 86400);
  assert.equal(parseEvery('24h'), 86400);
  assert.equal(parseEvery('30d'), 30 * 86400);
  assert.equal(parseEvery(' 1d '), 86400);
  for (const bad of ['', '1', '1w', '1.5h', '0d', '14m', '31d', 'daily', '-1h']) {
    assert.equal(parseEvery(bad), null, bad);
  }
});

test('calendar expressions cover the intervals that land on the clock', () => {
  assert.equal(calendarFor(86400), 'daily');
  assert.equal(calendarFor(3600), 'hourly');
  assert.equal(calendarFor(12 * 3600), '*-*-* 00/12:00:00');
  assert.equal(calendarFor(15 * 60), '*-*-* *:00/15:00');
  assert.equal(calendarFor(90 * 60), null);
  assert.equal(calendarFor(2 * 86400), null);
  assert.equal(formatEvery(86400), '1d');
  assert.equal(formatEvery(90 * 60), '90min');
  assert.equal(randomizedDelay(86400), '15min');
  assert.equal(randomizedDelay(15 * 60), '3min');
});

test('systemdUnquote reverses quoting and percent-doubling', () => {
  assert.equal(systemdUnquote('"/tmp/a b"'), '/tmp/a b');
  assert.equal(systemdUnquote('"/tmp/a%%h"'), '/tmp/a%h');
  assert.equal(systemdUnquote('"say \\"hi\\""'), 'say "hi"');
});

test('updaterPath keeps git and docker and does not repeat a directory', () => {
  assert.equal(updaterPath('/usr/bin/git', '/usr/bin/docker'), '/usr/bin:/usr/local/bin:/bin');
});

test('runningInContainer is the docker or podman marker, not a guess', () => {
  assert.equal(runningInContainer((p) => p === '/.dockerenv'), true);
  assert.equal(runningInContainer((p) => p === '/run/.containerenv'), true);
  assert.equal(runningInContainer(() => false), false);
});

test('parseNextElapse reads the timestamp systemctl show actually prints', () => {
  // `show --value` prints local time. The zone abbreviation is not parsed.
  const shown = 'Fri 2026-11-06 00:00:00 CST';
  assert.equal(parseNextElapse(shown), new Date(2026, 10, 6, 0, 0, 0).toISOString());
  assert.equal(parseNextElapse(`${shown}\n`), new Date(2026, 10, 6, 0, 0, 0).toISOString());
  // A bare integer is the D-Bus microsecond property, not what show --value prints.
  assert.equal(parseNextElapse('1700000000000000'), new Date(1700000000000).toISOString());
  assert.equal(parseNextElapse('n/a'), null);
  assert.equal(parseNextElapse(''), null);
  assert.equal(parseNextElapse('0'), null);
  assert.equal(parseNextElapse('5'), null);
  assert.equal(parseNextElapse('2w 31min ago'), null);
});

/**
 * A throwaway checkout plus a home directory the units can be written into.
 * `run` records systemctl and launchctl and never calls the real ones.
 */
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'tc-compose-update-'));
  const checkout = join(home, 'checkout');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await writeFile(join(checkout, 'scripts', 'redeploy.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(join(checkout, 'docker-compose.yml'), 'name: teamclaude\n');
  await writeFile(join(checkout, '.git'), 'gitdir: /nowhere\n');
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  const base = {
    root: checkout,
    home,
    xdgConfig: join(home, 'xdg'),
    kind: /** @type {'systemd'} */ ('systemd'),
    uid: 1000,
    inContainer: false,
    platform: 'linux',
    env: /** @type {NodeJS.ProcessEnv} */ ({}),
    lookup: (/** @type {string} */ name) => (name === 'git' ? '/usr/bin/git' : name === 'docker' ? '/usr/local/bin/docker' : null),
    run,
    log: () => {},
  };
  return {
    home,
    checkout,
    calls,
    base,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

test('install writes a timer that runs redeploy.sh and does not start the oneshot', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate(t.base);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.every, '1d');
    assert.equal(res.file, composeUpdateTimerPath(t.home, t.base.xdgConfig));
    const service = await readFile(composeUpdateServicePath(t.home, t.base.xdgConfig), 'utf8');
    const timer = await readFile(res.file, 'utf8');
    const script = join(t.checkout, 'scripts', 'redeploy.sh');
    assert.match(service, new RegExp(`ExecStart="${script}"`));
    assert.match(service, /TimeoutStartSec=infinity/);
    assert.doesNotMatch(service, /TimeoutStartSec=30min/);
    assert.match(service, /Type=oneshot/);
    assert.doesNotMatch(service, /\/bin\/sh|RemainAfterExit=yes|--force/);
    assert.match(service, /git pull, docker compose build, and docker compose up -d/);
    assert.equal(checkoutFromService(service), t.checkout);
    assert.match(timer, /OnCalendar=daily/);
    assert.match(timer, /Persistent=true/);
    assert.doesNotMatch(timer, /OnStartupSec=/);
    assert.equal(everyFromTimer(timer), '1d');
    assert.deepEqual(t.calls, [
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${COMPOSE_UPDATE_TIMER}`,
    ]);
  } finally {
    await t.cleanup();
  }
});

test('a 12h interval is a calendar and a 90m interval is monotonic', async () => {
  const t = await setup();
  try {
    const half = await renderComposeUpdate({ ...t.base, every: '12h' });
    assert.equal(half.ok, true);
    if (!half.ok) return;
    assert.match(half.text, /OnCalendar=\*-\*-\* 00\/12:00:00/);
    assert.match(half.text, /# teamclaude-compose-every=12h/);
    const odd = await renderComposeUpdate({ ...t.base, every: '90m' });
    assert.equal(odd.ok, true);
    if (!odd.ok) return;
    assert.match(odd.text, /OnStartupSec=90min/);
    assert.match(odd.text, /OnUnitActiveSec=90min/);
    assert.doesNotMatch(odd.text, /OnCalendar=/);
  } finally {
    await t.cleanup();
  }
});

test('WorkingDirectory is an unquoted path, and ExecStart stays quoted', async () => {
  const t = await setup();
  try {
    const spaced = join(t.home, 'a b');
    await mkdir(join(spaced, 'scripts'), { recursive: true });
    await writeFile(join(spaced, 'scripts', 'redeploy.sh'), '#!/bin/bash\n');
    await writeFile(join(spaced, 'docker-compose.yml'), 'x\n');
    await writeFile(join(spaced, '.git'), 'gitdir: x\n');
    const res = await renderComposeUpdate({ ...t.base, root: spaced });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.match(res.text, /^WorkingDirectory=\/.*\/a b$/m);
    assert.doesNotMatch(res.text, /^WorkingDirectory="/m);
    assert.match(res.text, /^ExecStart="\/.*\/a b\/scripts\/redeploy\.sh"$/m);
    assert.equal(checkoutFromService(res.text), spaced);

    const percent = join(t.home, 'a%b');
    await mkdir(join(percent, 'scripts'), { recursive: true });
    await writeFile(join(percent, 'scripts', 'redeploy.sh'), '#!/bin/bash\n');
    await writeFile(join(percent, 'docker-compose.yml'), 'x\n');
    await writeFile(join(percent, '.git'), 'gitdir: x\n');
    const again = await renderComposeUpdate({ ...t.base, root: percent });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.match(again.text, /^WorkingDirectory=\/.*\/a%%b$/m);
    assert.match(again.text, /^ExecStart="\/.*\/a%%b\/scripts\/redeploy\.sh"$/m);
    assert.equal(checkoutFromService(again.text), percent);
  } finally {
    await t.cleanup();
  }
});

test('a checkout path that would break the unit line is refused', async () => {
  const t = await setup();
  try {
    const res = await renderComposeUpdate({ ...t.base, root: '/tmp/checkout\\', exists: () => true });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /backslash/);
    assert.equal(t.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('a control character in the checkout path is refused and nothing is written', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({
      ...t.base,
      root: `/tmp/bad\npath`,
      exists: () => true,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /control character/);
    assert.equal(t.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('COMPOSE_FILE and TEAMROUTER_SERVICE are baked in, and the renamed variable wins', async () => {
  const t = await setup();
  try {
    const alt = join(t.checkout, 'docker', 'preview.yml');
    await mkdir(join(t.checkout, 'docker'), { recursive: true });
    await writeFile(alt, 'name: preview\n');
    const res = await renderComposeUpdate({
      ...t.base,
      env: { COMPOSE_FILE: 'docker/preview.yml:docker/missing.yml', TEAMCLAUDE_SERVICE: 'teamclaude', TEAMROUTER_SERVICE: 'preview' },
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.match(res.text, /COMPOSE_FILE=docker\/preview.yml:docker\/missing.yml/);
    assert.match(res.text, /TEAMCLAUDE_SERVICE=preview/);
    assert.doesNotMatch(res.text, /TEAMCLAUDE_SERVICE=teamclaude/);
  } finally {
    await t.cleanup();
  }
});

test('install is refused for root, a container, a missing tool, or a checkout that is not compose', async () => {
  const t = await setup();
  try {
    const cases = [
      [{ uid: 0 }, /root/],
      [{ inContainer: true }, /inside the container/],
      [{ lookup: () => null }, /git was not found/],
      [{ lookup: (/** @type {string} */ name) => (name === 'git' ? '/usr/bin/git' : null) }, /docker was not found/],
      [{ root: t.home }, /redeploy.sh/],
      [{ every: '1m' }, /15m and 30d/],
      [{ kind: null, platform: 'win32' }, /No timer integration/],
    ];
    for (const [extra, pattern] of cases) {
      const res = await installComposeUpdate({ ...t.base, ...extra });
      assert.equal(res.ok, false, JSON.stringify(extra));
      if (res.ok) continue;
      assert.match(res.error, pattern, JSON.stringify(extra));
    }
    assert.equal(t.calls.length, 0);
    await rm(join(t.checkout, 'docker-compose.yml'));
    const missing = await installComposeUpdate(t.base);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /No compose file/);
  } finally {
    await t.cleanup();
  }
});

test('a missing compose file named by COMPOSE_FILE is refused', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({ ...t.base, env: { COMPOSE_FILE: 'nope.yml' } });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /nope.yml/);
    assert.equal(t.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

test('a failed systemctl enable leaves the error and does not pretend the timer is armed', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({
      ...t.base,
      run: (cmd, args) => {
        t.calls.push([cmd, ...args].join(' '));
        if (args.includes('enable')) return { code: 1, stdout: '', stderr: 'enable failed' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /enable failed/);
  } finally {
    await t.cleanup();
  }
});

test('status reads the installed timer and uninstall removes both units', async () => {
  const t = await setup();
  try {
    assert.equal((await installComposeUpdate(t.base)).ok, true);
    const status = await composeUpdateStatus({
      ...t.base,
      run: (cmd, args) => {
        if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (args.includes('show')) return { code: 0, stdout: 'Fri 2026-11-06 00:00:00 CST\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(status.installed, true);
    assert.equal(status.active, true);
    assert.equal(status.every, '1d');
    assert.equal(status.checkout, t.checkout);
    assert.equal(status.next, new Date(2026, 10, 6, 0, 0, 0).toISOString());
    assert.match(status.logs || '', new RegExp(COMPOSE_UPDATE_SERVICE));

    t.calls.length = 0;
    const gone = await uninstallComposeUpdate(t.base);
    assert.equal(gone.ok, true);
    assert.deepEqual(t.calls, [
      `systemctl --user disable --now ${COMPOSE_UPDATE_TIMER}`,
      `systemctl --user clean ${COMPOSE_UPDATE_TIMER} --what=state`,
      'systemctl --user daemon-reload',
    ]);
    const after = await readFile(composeUpdateTimerPath(t.home, t.base.xdgConfig), 'utf8').catch((e) => e.code);
    assert.equal(after, 'ENOENT');
    const bare = await composeUpdateStatus({ ...t.base, run: () => ({ code: 3, stdout: 'inactive\n', stderr: '' }) });
    assert.equal(bare.installed, false);
    assert.equal(bare.detail, 'not installed');
  } finally {
    await t.cleanup();
  }
});

test('uninstall stops when systemctl cannot reach the user manager', async () => {
  const t = await setup();
  try {
    assert.equal((await installComposeUpdate(t.base)).ok, true);
    const timer = composeUpdateTimerPath(t.home, t.base.xdgConfig);
    t.calls.length = 0;
    const gone = await uninstallComposeUpdate({
      ...t.base,
      run: (cmd, args) => {
        t.calls.push([cmd, ...args].join(' '));
        if (args.includes('disable')) return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.match(gone.error, /Failed to connect to bus/);
    assert.deepEqual(t.calls, [`systemctl --user disable --now ${COMPOSE_UPDATE_TIMER}`]);
    assert.match(await readFile(timer, 'utf8'), /OnCalendar=daily/);

    t.calls.length = 0;
    const cleaned = await uninstallComposeUpdate({
      ...t.base,
      run: (cmd, args) => {
        t.calls.push([cmd, ...args].join(' '));
        if (args.includes('clean')) return { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(cleaned.ok, false);
    if (cleaned.ok) return;
    assert.match(cleaned.error, /Failed to connect to bus/);
    assert.deepEqual(t.calls, [
      `systemctl --user disable --now ${COMPOSE_UPDATE_TIMER}`,
      `systemctl --user clean ${COMPOSE_UPDATE_TIMER} --what=state`,
    ]);
    assert.match(await readFile(timer, 'utf8'), /OnCalendar=daily/);
  } finally {
    await t.cleanup();
  }
});

test('uninstall of a timer that is not loaded still removes the unit files', async () => {
  const t = await setup();
  try {
    assert.equal((await installComposeUpdate(t.base)).ok, true);
    const gone = await uninstallComposeUpdate({
      ...t.base,
      run: (cmd, args) => {
        t.calls.push([cmd, ...args].join(' '));
        if (args.includes('disable')) return { code: 1, stdout: '', stderr: `Failed to disable unit: Unit ${COMPOSE_UPDATE_TIMER} does not exist` };
        if (args.includes('clean')) return { code: 1, stdout: '', stderr: `Failed to add reference to unit ${COMPOSE_UPDATE_TIMER}: Unit ${COMPOSE_UPDATE_TIMER} not found.` };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(gone.ok, true);
    const after = await readFile(composeUpdateTimerPath(t.home, t.base.xdgConfig), 'utf8').catch((e) => e.code);
    assert.equal(after, 'ENOENT');
  } finally {
    await t.cleanup();
  }
});

test('a failed daemon-reload is not reported as a finished uninstall', async () => {
  const t = await setup();
  try {
    assert.equal((await installComposeUpdate(t.base)).ok, true);
    const gone = await uninstallComposeUpdate({
      ...t.base,
      run: (cmd, args) => {
        t.calls.push([cmd, ...args].join(' '));
        if (args.includes('daemon-reload')) return { code: 1, stdout: '', stderr: 'Failed to reload: Connection reset by peer' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.match(gone.error, /Connection reset/);
    const after = await readFile(composeUpdateTimerPath(t.home, t.base.xdgConfig), 'utf8').catch((e) => e.code);
    assert.equal(after, 'ENOENT');
  } finally {
    await t.cleanup();
  }
});

test('launchd installs one agent that waits out the interval and does not run at load', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({ ...t.base, kind: 'launchd', platform: 'darwin' });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const file = composeUpdateAgentPath(t.home);
    assert.equal(res.file, file);
    const plist = await readFile(file, 'utf8');
    assert.match(plist, new RegExp(`<string>${COMPOSE_UPDATE_LABEL}</string>`));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>86400<\/integer>/);
    assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
    assert.equal(checkoutFromPlist(plist), t.checkout);
    assert.equal(everyFromPlist(plist), '1d');
    assert.match(plist, /<string>\/usr\/bin:\/usr\/local\/bin:\/bin<\/string>/);
    assert.deepEqual(t.calls, [
      `launchctl bootout gui/1000/${COMPOSE_UPDATE_LABEL}`,
      `launchctl bootstrap gui/1000 ${file}`,
    ]);
    const status = await composeUpdateStatus({
      ...t.base,
      kind: 'launchd',
      platform: 'darwin',
      run: () => ({ code: 0, stdout: 'loaded', stderr: '' }),
    });
    assert.equal(status.active, true);
    assert.equal(status.logs, composeUpdateLogPath(t.home));
  } finally {
    await t.cleanup();
  }
});

test('uninstall on launchd reports a bootout failure and keeps the plist', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({ ...t.base, kind: 'launchd', platform: 'darwin' });
    assert.equal(res.ok, true);
    const file = composeUpdateAgentPath(t.home);
    const gone = await uninstallComposeUpdate({
      ...t.base,
      kind: 'launchd',
      platform: 'darwin',
      run: () => ({ code: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error' }),
    });
    assert.equal(gone.ok, false);
    if (gone.ok) return;
    assert.match(gone.error, /Input\/output error/);
    assert.match(await readFile(file, 'utf8'), new RegExp(COMPOSE_UPDATE_LABEL));
  } finally {
    await t.cleanup();
  }
});

test('uninstall on launchd removes a plist whose job is not loaded', async () => {
  const t = await setup();
  try {
    const res = await installComposeUpdate({ ...t.base, kind: 'launchd', platform: 'darwin' });
    assert.equal(res.ok, true);
    const file = composeUpdateAgentPath(t.home);
    const gone = await uninstallComposeUpdate({
      ...t.base,
      kind: 'launchd',
      platform: 'darwin',
      run: () => ({ code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' }),
    });
    assert.equal(gone.ok, true);
    const after = await readFile(file, 'utf8').catch((e) => e.code);
    assert.equal(after, 'ENOENT');
  } finally {
    await t.cleanup();
  }
});

test('systemd-analyze accepts the unit and rejects a quoted WorkingDirectory', async (t) => {
  const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('systemd-analyze is not installed');
    return;
  }
  const home = await setup();
  try {
    const root = join(home.home, 'a b%c');
    await mkdir(join(root, 'scripts'), { recursive: true });
    const script = join(root, 'scripts', 'redeploy.sh');
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o755);
    await writeFile(join(root, 'docker-compose.yml'), 'name: x\n');
    await writeFile(join(root, '.git'), 'gitdir: x\n');
    const res = await installComposeUpdate({ ...home.base, root });
    assert.equal(res.ok, true);
    const file = composeUpdateServicePath(home.home, home.base.xdgConfig);
    const text = await readFile(file, 'utf8');
    assert.match(text, /^WorkingDirectory=.*\/a b%%c$/m);
    assert.doesNotMatch(text, /^WorkingDirectory="/m);
    const ok = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
    const quoted = text.replace(/^(WorkingDirectory=)(.*)$/m, '$1"$2"');
    const bad = join(home.home, 'quoted.service');
    await writeFile(bad, quoted);
    const fail = spawnSync('systemd-analyze', ['verify', bad], { encoding: 'utf8' });
    assert.notEqual(fail.status, 0);
    assert.match(`${fail.stdout}\n${fail.stderr}`, /path is not absolute/);
  } finally {
    await home.cleanup();
  }
});

test('status and uninstall from inside a container do not call systemctl', async () => {
  const t = await setup();
  try {
    const status = await composeUpdateStatus({ ...t.base, inContainer: true });
    assert.equal(status.refused, true);
    const gone = await uninstallComposeUpdate({ ...t.base, inContainer: true });
    assert.equal(gone.ok, false);
    assert.equal(t.calls.length, 0);
  } finally {
    await t.cleanup();
  }
});

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function runCli(args, env = {}) {
  const child = spawn(process.execPath, [indexPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEAMROUTER_CONFIG: join(tmpdir(), 'tc-compose-update-unused.json'),
      TEAMCLAUDE_CONFIG: join(tmpdir(), 'tc-compose-update-unused.json'),
      TEAMCLAUDE_DISABLE_AUTOUPDATE: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}`)); }, 30_000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('an unknown compose subcommand prints usage and does not install anything', async () => {
  const r = await runCli(['update', 'compose', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage: teamclaude update compose/);
  assert.match(r.stderr, /git pull, docker compose build, docker compose up -d/);
});

test('update on this git checkout points at the compose timer and does not run npm', async () => {
  const r = await runCli(['update']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /npm will not update it/);
  assert.match(r.stdout, /update compose install/);
  assert.match(r.stdout, /git pull, docker compose build, docker compose up -d/);
  assert.doesNotMatch(r.stdout + r.stderr, /Updating|npm install/);
});

test('help mentions the compose timer', async () => {
  const r = await runCli(['help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /update compose/);
  assert.match(r.stdout, /git pull, docker compose build, docker compose up -d/);
});
