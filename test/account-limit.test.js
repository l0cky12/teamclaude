import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ACCOUNTS_PER_PROVIDER, accountLimitGroup, accountLimitReached, assertAccountLimit, AccountLimitError,
} from '../src/account-limit.js';
import { mergeImportedAccounts } from '../src/account-transfer.js';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { resolveAccounts } from '../src/resolve-accounts.js';
import { ensureAccountIds } from '../src/account-id.js';
import { closedPort } from '../test-helpers/spawn-server.js';

// The pool takes at most MAX_ACCOUNTS_PER_PROVIDER accounts of each kind:
// Claude, Codex, Anthropic API keys, and each third-party backend by host.
// Every add path asks account-limit.js; these pin the rule and the paths that
// can be driven without a browser sign-in.

const claude = (i) => ({ name: `c${i}@example.com`, type: 'oauth', accountUuid: `uc${i}`, orgUuid: `oc${i}`, accessToken: `at-c${i}`, refreshToken: `rt-c${i}`, expiresAt: 1_000 + i });
const codex = (i) => ({ name: `x${i}@example.com`, type: 'oauth', provider: 'codex', accountId: `ax${i}`, userId: `ux${i}`, accessToken: `at-x${i}`, refreshToken: `rt-x${i}`, expiresAt: 1_000 + i });
const apikey = (i) => ({ name: `api-${i}`, type: 'apikey', apiKey: `sk-demo-${i}` });
const backend = (i, upstream = 'https://api.deepseek.com/anthropic') => ({ name: `ds-${i}`, type: 'apikey', apiKey: `sk-ds-${i}`, upstream });
const many = (make, n, from = 0) => Array.from({ length: n }, (_, i) => make(from + i));

test('the cap is twenty', () => {
  assert.equal(MAX_ACCOUNTS_PER_PROVIDER, 20);
});

test('accounts are counted by kind: Claude, Codex, API key, and each backend host', () => {
  assert.equal(accountLimitGroup(claude(1)).key, 'claude');
  assert.equal(accountLimitGroup({ name: 'legacy', type: 'oauth' }).key, 'claude', 'no provider field is Claude');
  assert.equal(accountLimitGroup(codex(1)).key, 'codex');
  assert.equal(accountLimitGroup(apikey(1)).key, 'apikey');
  assert.equal(accountLimitGroup(backend(1)).key, 'backend:api.deepseek.com');
  assert.equal(accountLimitGroup(backend(1, 'HTTPS://API.DeepSeek.com/')).key, 'backend:api.deepseek.com', 'case and path do not split a host');
  assert.notEqual(accountLimitGroup(backend(1, 'https://api.z.ai/api/anthropic')).key, accountLimitGroup(backend(1)).key);
});

test('the twentieth of a kind is taken, the twenty-first is refused', () => {
  assert.equal(accountLimitReached(many(claude, 19), claude(99)), null);
  const reached = accountLimitReached(many(claude, 20), claude(99));
  assert.ok(reached);
  assert.equal(reached.count, 20);
  assert.equal(reached.limit, 20);
  assert.match(reached.message, /20 Claude accounts already \(at most 20\)/);
  assert.throws(() => assertAccountLimit(many(codex, 20), codex(99)), AccountLimitError);
});

test('a full kind does not hold back another kind', () => {
  const full = [...many(claude, 20), ...many(codex, 20), ...many(backend, 20)];
  assert.equal(accountLimitReached(full, apikey(1)), null, 'API keys count apart from Claude logins');
  assert.equal(accountLimitReached(full, backend(1, 'https://api.z.ai/api/anthropic')), null, 'another backend host counts apart');
  assert.ok(accountLimitReached(full, codex(99)));
  assert.ok(accountLimitReached(full, backend(99)));
});

test('a transfer import adds up to the cap and skips the rest, while updates still apply', () => {
  const config = { accounts: many(claude, 18) };
  const incoming = [...many(claude, 4, 18), { ...claude(0), accessToken: 'at-c0-newer', expiresAt: 9_999 }];
  const result = mergeImportedAccounts(config, incoming);
  assert.deepEqual(result.added, ['c18@example.com', 'c19@example.com']);
  assert.deepEqual(result.updated, ['c0@example.com'], 'an account already here is updated at the cap');
  assert.deepEqual(result.skipped.map((s) => s.name), ['c20@example.com', 'c21@example.com']);
  assert.match(result.skipped[0].reason, /Account limit reached/);
  assert.equal(config.accounts.length, 20);
});

async function makeTUI(configAccounts) {
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  const config = { proxy: { port: 1 }, accounts: configAccounts, routes: [] };
  const logs = [];
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
  });
  tui.render = () => {};
  const addLog = tui._addLog.bind(tui);
  tui._addLog = (line) => { logs.push(line); addLog(line); };
  return { tui, am, config, logs };
}

test('the TUI refuses a twenty-first API key and leaves both lists alone', async () => {
  const { tui, am, config, logs } = await makeTUI(many(apikey, 20));
  await tui._doAddKey('sk-demo-extra');
  assert.equal(config.accounts.length, 20);
  assert.equal(am.accounts.length, 20);
  assert.ok(logs.some((l) => /API key not added: Account limit reached/.test(l)), logs.join('\n'));
});

test('the TUI adds a key below the cap', async () => {
  const { tui, config } = await makeTUI(many(apikey, 19));
  await tui._doAddKey('sk-demo-extra');
  assert.equal(config.accounts.length, 20);
});

test('the TUI refuses importing a twenty-first Claude login, but re-imports one it has', async () => {
  const { tui, config, logs } = await makeTUI(many(claude, 20));
  tui._readCredentials = async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: 5_000 });
  tui._readProfile = async () => ({ accountUuid: 'u-new', orgUuid: 'o-new', email: 'new@example.com' });
  await tui._doImport();
  assert.equal(config.accounts.length, 20);
  assert.ok(logs.some((l) => /Import refused: Account limit reached/.test(l)), logs.join('\n'));

  tui._readCredentials = async () => ({ accessToken: 'at-c3-fresh', refreshToken: 'rt-c3-fresh', expiresAt: 6_000 });
  tui._readProfile = async () => ({ accountUuid: 'uc3', orgUuid: 'oc3', email: 'c3@example.com' });
  await tui._doImport();
  assert.equal(config.accounts.length, 20);
  assert.equal(config.accounts[3].accessToken, 'at-c3-fresh', 'an update is not an add');
});

// The CLI, end to end: `login --api` refuses before asking for the key and
// writes nothing.
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('login --api refuses at the cap before prompting, and leaves the file alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-limit-'));
  const configPath = join(dir, 'config.json');
  const port = await closedPort();
  const before = JSON.stringify({ proxy: { port, apiKey: 'tc-test' }, upstreamProxy: false, autoUpdate: false, accounts: many(apikey, 20).map((a, i) => ({ id: `id-${i}`, ...a })) });
  await writeFile(configPath, before);
  const env = { ...process.env, TEAMCLAUDE_CONFIG: configPath, TEAMROUTER_CONFIG: configPath, TEAMCLAUDE_DISABLE_AUTOUPDATE: '1' };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const child = spawn(process.execPath, [cliPath, 'login', '--api', '--name', 'api-extra'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.resume();
  child.stdin.end('sk-demo-extra\n');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit\n${stderr}`)); }, 20_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 1, stderr);
  assert.match(stderr, /Account limit reached: 20 Anthropic API key accounts already/);
  assert.doesNotMatch(stderr, /Anthropic API key:/, 'refused before the prompt');
  assert.equal(await readFile(configPath, 'utf8'), before);
});
