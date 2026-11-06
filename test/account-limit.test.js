import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ACCOUNTS_PER_PROVIDER, accountLimitGroup, accountLimitReached, assertAccountLimit, AccountLimitError, admitUnderCap,
} from '../src/account-limit.js';
import { atomicConfigUpdate } from '../src/config.js';
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

test('an upstream naming the provider\'s own host, or a subscription\'s upstream, does not make a backend', () => {
  assert.equal(accountLimitGroup({ ...codex(1), upstream: 'https://chatgpt.com' }).key, 'codex');
  assert.equal(accountLimitGroup({ ...apikey(1), upstream: 'https://API.anthropic.com/' }).key, 'apikey');
  assert.equal(accountLimitGroup({ ...claude(1), upstream: 'https://relay.example.com' }).key, 'claude', 'an OAuth login is a subscription wherever it is sent');
  assert.equal(accountLimitGroup({ ...codex(1), upstream: 'https://relay.example.com' }).key, 'codex');
  // Twenty Codex logins spelled with an explicit upstream still fill Codex.
  const spelled = many(codex, 20).map((a) => ({ ...a, upstream: 'https://chatgpt.com' }));
  assert.ok(accountLimitReached(spelled, codex(99)));
  const config = { accounts: spelled };
  const result = mergeImportedAccounts(config, [codex(99)]);
  assert.deepEqual(result.added, []);
  assert.equal(config.accounts.length, 20);
});

test('the twentieth of a kind is taken, the twenty-first is refused', () => {
  assert.equal(accountLimitReached(many(claude, 19), claude(99)), null);
  const reached = accountLimitReached(many(claude, 20), claude(99));
  assert.ok(reached);
  assert.equal(reached.count, 20);
  assert.equal(reached.limit, 20);
  assert.match(reached.message, /Account limit reached: 20\/20 Claude accounts\. Remove one to add another\./);
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

// A running server's count can be stale: another process (`teamclaude login`
// in a second terminal) may have saved the twentieth account before this one
// reloaded. admitUnderCap checks and writes under the config lock against a
// fresh read of the file, so the stale count cannot let a twenty-first in.
async function withConfigFile(accounts, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-admit-'));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ proxy: { port: 1 }, upstreamProxy: false, accounts }));
  const saved = { TEAMCLAUDE_CONFIG: process.env.TEAMCLAUDE_CONFIG, TEAMROUTER_CONFIG: process.env.TEAMROUTER_CONFIG };
  process.env.TEAMCLAUDE_CONFIG = path;
  process.env.TEAMROUTER_CONFIG = path;
  try {
    return await fn(path);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const withIds = (accounts) => accounts.map((a, i) => ({ id: `id-${a.name}-${i}`, ...a }));

test('a stale running count does not let a twenty-first in: the file is checked under its lock', async () => {
  const running = withIds(many(apikey, 19));
  // The file also holds the twentieth, saved by another process.
  const onDisk = [...running, { id: 'id-other', ...apikey(19) }];
  await withConfigFile(onDisk, async (path) => {
    const before = await readFile(path, 'utf8');
    const config = { accounts: [...running] };
    const am = new AccountManager(await resolveAccounts({ accounts: running }), 0.98);
    const res = await admitUnderCap({ entry: apikey(50), config, accountManager: am, update: atomicConfigUpdate });
    assert.equal(res.idx, null);
    assert.match(res.reason, /20\/20 Anthropic API key accounts/);
    assert.equal(await readFile(path, 'utf8'), before, 'a refusal writes nothing');
    assert.equal(config.accounts.length, 19);
    assert.equal(am.accounts.length, 19);
  });
});

test('below the cap the row is written first, then joins the running lists', async () => {
  const running = withIds(many(apikey, 18));
  await withConfigFile(running, async (path) => {
    const config = { accounts: [...running] };
    const am = new AccountManager(await resolveAccounts({ accounts: running }), 0.98);
    const entry = apikey(50);
    const res = await admitUnderCap({ entry, config, accountManager: am, update: atomicConfigUpdate });
    assert.equal(res.added, true);
    assert.equal(res.idx, 18);
    assert.equal(am.accounts[18].id, entry.id);
    assert.equal(config.accounts.at(-1), entry);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(disk.accounts.some((a) => a.id === entry.id && a.apiKey === entry.apiKey));
  });
});

test('an add not yet saved counts, and two adds racing for the last place take one between them', async () => {
  const running = withIds(many(apikey, 19));
  await withConfigFile(running, async (path) => {
    const config = { accounts: [...running] };
    const am = new AccountManager(await resolveAccounts({ accounts: running }), 0.98);
    const results = await Promise.all([apikey(50), apikey(51)].map((entry) => admitUnderCap({ entry, config, accountManager: am, update: atomicConfigUpdate })));
    assert.equal(results.filter((r) => r.added).length, 1);
    assert.equal(results.filter((r) => r.reason).length, 1);
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(disk.accounts.length, 20);
    assert.equal(am.accounts.length, 20);
  });

  // An account this process runs but has not saved yet counts too.
  const unsaved = { id: 'id-unsaved', ...apikey(40) };
  await withConfigFile(withIds(many(apikey, 19)), async (path) => {
    const config = { accounts: [...withIds(many(apikey, 19)), unsaved] };
    const am = new AccountManager(await resolveAccounts({ accounts: config.accounts }), 0.98);
    const res = await admitUnderCap({ entry: apikey(50), config, accountManager: am, update: atomicConfigUpdate });
    assert.ok(res.reason);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).accounts.length, 19);
  });
});

test('an account already in the pool is not added again, and is not called a refusal', async () => {
  const running = withIds(many(apikey, 3));
  await withConfigFile(running, async () => {
    const config = { accounts: [...running] };
    const am = new AccountManager(await resolveAccounts({ accounts: running }), 0.98);
    const res = await admitUnderCap({ entry: apikey(1), config, accountManager: am, update: atomicConfigUpdate });
    assert.deepEqual(res, { added: false, idx: null, reason: null });
  });
});

async function makeTUI(configAccounts, extra = {}) {
  ensureAccountIds(configAccounts);
  const am = new AccountManager(await resolveAccounts({ accounts: configAccounts }), 0.98);
  const config = { proxy: { port: 1 }, accounts: configAccounts, routes: [] };
  const logs = [];
  const tui = new TUI({
    accountManager: am, config, sx: null,
    saveConfig: async () => {},
    syncAccounts: async () => 0,
    onQuit: () => {},
    ...extra,
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

test('the TUI on a server checks the file, not its own stale list', async () => {
  const running = withIds(many(apikey, 19));
  await withConfigFile([...running, { id: 'id-other', ...apikey(19) }], async (path) => {
    const before = await readFile(path, 'utf8');
    let tuiState;
    const admitAccount = (entry) => admitUnderCap({ entry, config: tuiState.config, accountManager: tuiState.am, update: atomicConfigUpdate });
    tuiState = await makeTUI(running, { admitAccount });
    await tuiState.tui._doAddKey('sk-demo-extra');
    assert.equal(tuiState.config.accounts.length, 19);
    assert.equal(tuiState.am.accounts.length, 19);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.ok(tuiState.logs.some((l) => /API key not added: Account limit reached/.test(l)), tuiState.logs.join('\n'));
  });
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
  assert.match(stderr, /Account limit reached: 20\/20 Anthropic API key accounts/);
  assert.doesNotMatch(stderr, /Anthropic API key:/, 'refused before the prompt');
  assert.equal(await readFile(configPath, 'utf8'), before);
});
