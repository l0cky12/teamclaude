import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `accounts export` on one throwaway config, `accounts import` into another:
// the real CLI end to end. Port 3 has no listener, so the reload notification
// is a no-op, and nothing here reaches the network.

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

/**
 * @param {Array<Record<string, any>>} accounts
 * @param {number} [port]
 */
async function writeConfig(accounts, port = 3) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-transfer-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    upstreamProxy: false,
    autoUpdate: false,
    accounts,
  }));
  return { dir, path };
}

/**
 * @param {string} configPath
 * @param {string[]} cliArgs
 * @param {Record<string, string>} [extraEnv]
 */
function runCli(configPath, cliArgs, extraEnv = {}) {
  /** @type {Record<string, string|undefined>} */
  const env = { ...process.env };
  // TEAMROUTER_* wins over TEAMCLAUDE_*: an inherited one would point at a real
  // config. And an operator's own export passphrase must not reach a test that
  // checks what happens without one.
  for (const k of Object.keys(env)) if (k.startsWith('TEAMROUTER_')) delete env[k];
  for (const k of [...PROXY_ENV, 'TEAMCLAUDE_EXPORT_PASSPHRASE', 'TEAMCLAUDE_HOST']) delete env[k];
  Object.assign(env, { TEAMCLAUDE_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' }, extraEnv);
  const child = spawn(process.execPath, [cliPath, ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 30_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Expiry is irrelevant to the transfer; any value in the future will do.
const LATER = Date.now() + 86_400_000;
const SOURCE_ACCOUNTS = [
  { id: 'src-1', name: 'demo-a@example.com', type: 'oauth', accountUuid: 'uuid-a', orgUuid: 'org-a', accessToken: 'at-a', refreshToken: 'rt-a', expiresAt: LATER, routing: 'http://proxy.example:3128' },
  { id: 'src-2', name: 'demo-b@example.com', type: 'oauth', provider: 'codex', accountId: 'acct-b', userId: 'user-b', accessToken: 'cx-at', refreshToken: 'cx-rt', expiresAt: LATER },
];
const PASS = { TEAMCLAUDE_EXPORT_PASSPHRASE: 'demo passphrase' };

test('export then import moves every account to a fresh machine', async () => {
  const source = await writeConfig(SOURCE_ACCOUNTS);
  const target = await writeConfig([]);
  const file = join(source.dir, 'accounts.tcx');

  const out = await runCli(source.path, ['accounts', 'export', file], PASS);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Exported 2 accounts \(1 Claude, 1 Codex\)/);
  assert.match(out.stderr, /signs the other out/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes('rt-a'), false, 'the refresh token is not readable in the file');

  const inn = await runCli(target.path, ['accounts', 'import', file], PASS);
  assert.equal(inn.code, 0, inn.stderr);
  assert.match(inn.stdout, /2 added, 0 updated, 0 skipped/);
  const imported = JSON.parse(await readFile(target.path, 'utf8')).accounts;
  assert.deepEqual(imported.map((/** @type {any} */ a) => a.refreshToken), ['rt-a', 'cx-rt']);
  assert.equal('routing' in imported[0], false);

  const again = await runCli(target.path, ['accounts', 'import', file], PASS);
  assert.match(again.stdout, /0 added, 0 updated, 2 skipped/);
});

test('import with the wrong passphrase changes nothing', async () => {
  const source = await writeConfig(SOURCE_ACCOUNTS);
  const target = await writeConfig([]);
  const file = join(source.dir, 'accounts.tcx');
  assert.equal((await runCli(source.path, ['accounts', 'export', file], PASS)).code, 0);
  const res = await runCli(target.path, ['accounts', 'import', file], { TEAMCLAUDE_EXPORT_PASSPHRASE: 'not it at all' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Wrong passphrase/);
  assert.deepEqual(JSON.parse(await readFile(target.path, 'utf8')).accounts, []);
});

test('export refuses to overwrite a file, and a short passphrase', async () => {
  const source = await writeConfig(SOURCE_ACCOUNTS);
  const file = join(source.dir, 'accounts.tcx');
  await writeFile(file, 'keep me');
  const res = await runCli(source.path, ['accounts', 'export', file], PASS);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'keep me');

  const short = await runCli(source.path, ['accounts', 'export', join(source.dir, 'other.tcx')], { TEAMCLAUDE_EXPORT_PASSPHRASE: 'short' });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 8 characters/);
});

test('export with no passphrase source and no terminal asks for one instead of writing', async () => {
  const source = await writeConfig(SOURCE_ACCOUNTS);
  const res = await runCli(source.path, ['accounts', 'export', join(source.dir, 'accounts.tcx')]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /TEAMCLAUDE_EXPORT_PASSPHRASE/);
});

test('--disable-source disables the exported accounts here; --plain writes readable JSON', async () => {
  const source = await writeConfig(SOURCE_ACCOUNTS);
  const file = join(source.dir, 'accounts.json');
  const res = await runCli(source.path, ['accounts', 'export', file, '--plain', '--disable-source']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /NOT encrypted/);
  assert.match(res.stdout, /Disabled 2 accounts/);
  const after = JSON.parse(await readFile(source.path, 'utf8')).accounts;
  assert.deepEqual(after.map((/** @type {any} */ a) => a.disabled), [true, true]);
  const bundle = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(bundle.encryption, null);
  assert.equal(bundle.accounts[0].disabled, undefined, 'the export carries the state from before it disabled them');
});

test('--disable-source is refused while a server listens on the proxy port', async () => {
  // Any listener on the port reads as a running server; nothing is sent to it
  // beyond the connect.
  const listener = net.createServer(sock => sock.destroy());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (listener.address()).port;
    const source = await writeConfig(SOURCE_ACCOUNTS, port);
    const file = join(source.dir, 'accounts.tcx');
    const res = await runCli(source.path, ['accounts', 'export', file, '--disable-source'], PASS);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /server is running/);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    const after = JSON.parse(await readFile(source.path, 'utf8')).accounts;
    assert.deepEqual(after.map((/** @type {any} */ a) => a.disabled), [undefined, undefined]);
  } finally {
    await new Promise(resolve => listener.close(() => resolve(undefined)));
  }
});

for (const [label, broken, why] of [
  ['a malformed credential', { name: 'broken', type: 'apikey', apiKey: { nested: true } }, /"broken": no API key/],
  ['a malformed setting', { name: 'broken', type: 'apikey', apiKey: 'sk-demo-1', models: { bad: true } }, /"broken": models has the wrong shape/],
]) {
  test(`a file with ${label} leaves the destination unchanged`, async () => {
    const target = await writeConfig([]);
    const file = join(target.dir, 'bad.json');
    await writeFile(file, JSON.stringify({
      format: 'teamrouter-accounts', v: 1, exportedAt: 'x', count: 2, encryption: null,
      accounts: [SOURCE_ACCOUNTS[0], broken],
    }));
    const res = await runCli(target.path, ['accounts', 'import', file]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, why);
    assert.deepEqual(JSON.parse(await readFile(target.path, 'utf8')).accounts, []);
  });
}

test('--disable-source finds a server bound to a configured host, not just 127.0.0.1', async (t) => {
  const listener = net.createServer(sock => sock.destroy());
  try {
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.2', () => resolve(undefined));
    });
  } catch {
    t.skip('127.0.0.2 is not a local address here');
    return;
  }
  try {
    const port = /** @type {import('node:net').AddressInfo} */ (listener.address()).port;
    const source = await writeConfig(SOURCE_ACCOUNTS, port);
    const config = JSON.parse(await readFile(source.path, 'utf8'));
    config.proxy.host = '127.0.0.2';
    await writeFile(source.path, JSON.stringify(config));
    const file = join(source.dir, 'accounts.tcx');
    const res = await runCli(source.path, ['accounts', 'export', file, '--disable-source'], PASS);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /server is running/);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  } finally {
    await new Promise(resolve => listener.close(() => resolve(undefined)));
  }
});
