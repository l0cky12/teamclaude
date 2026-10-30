import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/redeploy.sh against a stand-in `docker` on PATH, so the tests check
// what the script asks Docker to do (tag, build, swap, roll back) without a
// Docker daemon. The stand-in keeps a tiny image model in files: which image
// :local and :previous point at and which one the container runs. The image
// called "new" (whatever the build produced) is unhealthy unless a test says
// otherwise. The script itself runs from a throwaway git checkout.

const scriptPath = fileURLToPath(new URL('../scripts/redeploy.sh', import.meta.url));

const fakeDocker = `#!/usr/bin/env bash
s=$STUB_DIR
echo "$*" >> "$s/calls"
get() { cat "$s/$1" 2>/dev/null; }
if [ "$1" = compose ]; then
  shift
  case "$1 $2" in
    "config --services") echo teamclaude ;;
    "config --images") echo teamclaude:local ;;
    "ps -q") [ -f "$s/running" ] && echo cid1 ;;
    "ps -aq") [ -f "$s/running" ] && echo cid1 ;;
    build*) [ -f "$s/build_fails" ] && exit 1; echo new > "$s/local" ;;
    up*) cp "$s/local" "$s/container"; touch "$s/running" ;;
    logs*) echo "fake log line" ;;
  esac
  exit 0
fi
case $1 in
  inspect)
    case $3 in
      *revision*) get revision ;;
      "{{.Image}}") get container ;;
      *State.Status*) echo running ;;
      *Healthcheck*) echo "true" ;;
    esac ;;
  image)
    # docker image inspect [-f FORMAT] REF: a bare image id is untagged.
    case \${!#} in
      teamclaude:local) get local ;;
      teamclaude:previous) get previous ;;
      *) echo 0 ;;
    esac ;;
  tag)
    src=$2
    [ "$src" = teamclaude:previous ] && src=$(get previous)
    case $3 in
      teamclaude:previous) echo "$src" > "$s/previous" ;;
      teamclaude:local) echo "$src" > "$s/local" ;;
    esac ;;
  exec) [ "$(get container)" != new ] || [ -f "$s/new_is_healthy" ] ;;
esac
`;

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();
}

/**
 * A checkout holding the script and a package.json, committed, plus the
 * stand-in docker. The container starts out running image "old", built from
 * some other commit.
 * @param {{ running?: boolean }} [opts]
 */
async function setup({ running = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tc-redeploy-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const stub = join(root, 'stub');
  await Promise.all([mkdir(join(repo, 'scripts'), { recursive: true }), mkdir(bin), mkdir(stub)]);
  await copyFile(scriptPath, join(repo, 'scripts', 'redeploy.sh'));
  await chmod(join(repo, 'scripts', 'redeploy.sh'), 0o755);
  await writeFile(join(repo, 'package.json'), '{\n  "name": "x",\n  "version": "9.8.7"\n}\n');
  git(repo, 'init', '-q', '-b', 'master');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  await writeFile(join(bin, 'docker'), fakeDocker);
  await chmod(join(bin, 'docker'), 0o755);
  await writeFile(join(stub, 'local'), 'old\n');
  await writeFile(join(stub, 'container'), 'old\n');
  await writeFile(join(stub, 'revision'), 'some-older-commit\n');
  if (running) await writeFile(join(stub, 'running'), '');

  return {
    root,
    repo,
    stub,
    /** @param {...string} args */
    run: (...args) => {
      const env = { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: stub, TEAMCLAUDE_REDEPLOY_TIMEOUT: '0' };
      for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'TEAMCLAUDE_SERVICE']) delete env[key];
      return spawnSync(join(repo, 'scripts', 'redeploy.sh'), args, { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    },
    calls: async () => (await readFile(join(stub, 'calls'), 'utf8')).trim().split('\n'),
    state: async (/** @type {string} */ name) => (await readFile(join(stub, name), 'utf8')).trim(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('builds while the old container runs, swaps, and stamps the build with the commit', async () => {
  const t = await setup();
  try {
    await writeFile(join(t.stub, 'new_is_healthy'), '');
    const r = t.run('--no-pull');
    assert.equal(r.status, 0, r.stderr);
    const calls = await t.calls();
    const tag = calls.indexOf('tag old teamclaude:previous');
    const build = calls.findIndex((c) => c.startsWith('compose build'));
    const up = calls.indexOf('compose up -d --no-build teamclaude');
    assert.ok(tag >= 0 && tag < build && build < up, calls.join('\n'));
    assert.match(calls[build], new RegExp(`VCS_REF=${git(t.repo, 'rev-parse', 'HEAD')}`));
    assert.match(calls[build], /VERSION=9\.8\.7/);
    assert.equal(await t.state('container'), 'new');
    assert.equal(await t.state('previous'), 'old');
    assert.match(r.stdout, /Done: teamclaude is healthy/);
  } finally {
    await t.cleanup();
  }
});

test('an unhealthy new container is rolled back to the previous image', async () => {
  const t = await setup();
  try {
    const r = t.run('--no-pull');
    assert.equal(r.status, 1);
    const calls = await t.calls();
    assert.ok(calls.includes('tag teamclaude:previous teamclaude:local'), calls.join('\n'));
    assert.equal(calls.filter((c) => c === 'compose up -d --no-build teamclaude').length, 2);
    assert.equal(await t.state('container'), 'old');
    assert.equal(await t.state('local'), 'old');
    assert.match(r.stderr, /fake log line/);
    assert.match(r.stderr, /rolled back/);
  } finally {
    await t.cleanup();
  }
});

test('a failed build leaves the running container alone', async () => {
  const t = await setup();
  try {
    await writeFile(join(t.stub, 'build_fails'), '');
    const r = t.run('--no-pull');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /build failed/);
    assert.ok(!(await t.calls()).some((c) => c.startsWith('compose up')));
    assert.equal(await t.state('container'), 'old');
  } finally {
    await t.cleanup();
  }
});

test('does nothing when the container already runs the checked-out commit, unless forced', async () => {
  const t = await setup();
  try {
    await writeFile(join(t.stub, 'revision'), git(t.repo, 'rev-parse', 'HEAD'));
    await writeFile(join(t.stub, 'new_is_healthy'), '');
    const idle = t.run('--no-pull');
    assert.equal(idle.status, 0, idle.stderr);
    assert.match(idle.stdout, /nothing to do/);
    assert.ok(!(await t.calls()).some((c) => c.startsWith('compose build')));

    const forced = t.run('--no-pull', '--force');
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok((await t.calls()).some((c) => c.startsWith('compose build')));
    assert.equal(await t.state('container'), 'new');
  } finally {
    await t.cleanup();
  }
});

test('a first deploy with no container or image has nothing to tag as previous', async () => {
  const t = await setup({ running: false });
  try {
    await rm(join(t.stub, 'local'));
    await writeFile(join(t.stub, 'new_is_healthy'), '');
    const r = t.run('--no-pull');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!(await t.calls()).some((c) => c.startsWith('tag')));
    assert.ok(!existsSync(join(t.stub, 'previous')));
  } finally {
    await t.cleanup();
  }
});

test('pulls new commits and finishes with the pulled version of the script', async () => {
  const t = await setup();
  try {
    await writeFile(join(t.stub, 'new_is_healthy'), '');
    // The deploy checkout is a clone; a second clone pushes a commit that
    // changes the script itself.
    const origin = join(t.root, 'origin.git');
    const deploy = join(t.root, 'deploy');
    const other = join(t.root, 'other');
    git(t.root, 'clone', '-q', '--bare', t.repo, origin);
    git(t.root, 'clone', '-q', origin, deploy);
    git(t.root, 'clone', '-q', origin, other);
    const script = join(other, 'scripts', 'redeploy.sh');
    const body = await readFile(script, 'utf8');
    await writeFile(script, body.replace(/\nmain "\$@"\n$/, '\necho pulled-script-ran >&2\nmain "$@"\n'));
    git(other, 'commit', '-q', '-am', 'change the script');
    git(other, 'push', '-q', 'origin', 'master');
    const pushed = git(other, 'rev-parse', 'HEAD');

    const env = { ...process.env, ...gitEnv, PATH: `${join(t.root, 'bin')}:${process.env.PATH}`, STUB_DIR: t.stub, TEAMCLAUDE_REDEPLOY_TIMEOUT: '0' };
    const r = spawnSync(join(deploy, 'scripts', 'redeploy.sh'), [], { cwd: t.root, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Updated [0-9a-f]+ -> [0-9a-f]+/);
    assert.match(r.stderr, /pulled-script-ran/);
    assert.equal(git(deploy, 'rev-parse', 'HEAD'), pushed);
    assert.ok((await t.calls()).some((c) => c.startsWith('compose build') && c.includes(`VCS_REF=${pushed}`)));
  } finally {
    await t.cleanup();
  }
});

test('refuses to run where there is no matching compose service', async () => {
  const t = await setup();
  try {
    const r = spawnSync(join(t.repo, 'scripts', 'redeploy.sh'), ['--no-pull'], {
      cwd: t.root,
      env: { ...process.env, PATH: `${join(t.root, 'bin')}:${process.env.PATH}`, STUB_DIR: t.stub, TEAMCLAUDE_SERVICE: 'nope' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no compose service named 'nope'/);
  } finally {
    await t.cleanup();
  }
});
