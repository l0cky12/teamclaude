import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConnectError, claudeCodec, codexCodec, grokRcCodec, loopbackOrigin, sameAddress,
  parseClientIds, runClientAction, clientStatus,
} from '../src/client-connect.js';

const ORIGIN = 'http://127.0.0.1:3456';
const CODEX_TARGET = `${ORIGIN}/backend-api/codex`;
const GROK_TARGET = `${ORIGIN}/grok/v1`;

const CODEX_BLOCK = `[model_providers.teamclaude]
name = "teamclaude"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
`;

// A home directory of its own per test: nothing here may touch the real
// ~/.claude, ~/.codex or shell rc files.
async function withHome(fn, { platform = 'linux', shell = '/bin/bash', runPowerShell } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'teamclaude-connect-'));
  const ctx = {
    platform,
    env: { SHELL: shell },
    home,
    runPowerShell: runPowerShell ?? (async () => { throw new Error('no PowerShell off Windows'); }),
  };
  try {
    await fn(home, ctx);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function put(path, text) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

test('the loopback origin follows the bind, and is absent without a loopback listener', () => {
  assert.equal(loopbackOrigin({}, undefined, 3456), ORIGIN);
  assert.equal(loopbackOrigin({}, '0.0.0.0', 3456), ORIGIN);
  assert.equal(loopbackOrigin({}, '[::1]', 3456), 'http://[::1]:3456');
  assert.equal(loopbackOrigin({}, '192.168.1.5', 3456), null);
  assert.equal(loopbackOrigin({ trustLoopback: false }, '127.0.0.1', 3456), null);
});

test('localhost and 127.0.0.1 are the same proxy; another port is not', () => {
  assert.ok(sameAddress('http://localhost:3456/', ORIGIN));
  assert.ok(!sameAddress('http://127.0.0.1:3457', ORIGIN));
  assert.ok(!sameAddress('http://10.0.0.2:3456', ORIGIN));
});

test('client names: none or "all" is every client, an unknown one is refused', () => {
  assert.deepEqual(parseClientIds([]), ['claude', 'codex', 'grok']);
  assert.deepEqual(parseClientIds(['grok', 'claude']), ['claude', 'grok']);
  assert.throws(() => parseClientIds(['cursor']), ConnectError);
});

// ── Claude Code ──

test('claude: a missing settings file is created with only the base URL', async () => {
  await withHome(async (home, ctx) => {
    const { clients, errors } = await runClientAction('connect', ['claude'], ORIGIN, {}, ctx);
    assert.deepEqual(errors, []);
    assert.equal(clients[0].state, 'connected');
    const path = join(home, '.claude', 'settings.json');
    assert.equal(clients[0].where, path);
    assert.equal(await readFile(path, 'utf8'), '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456"\n  }\n}\n');
  });
});

test('claude: other keys and the indentation survive, and disconnect takes out only ours', () => {
  const original = '{\n    "model": "opus",\n    "env": {\n        "FOO": "1"\n    }\n}\n';
  const connected = claudeCodec.apply(original, ORIGIN);
  assert.deepEqual(JSON.parse(connected), { model: 'opus', env: { FOO: '1', ANTHROPIC_BASE_URL: ORIGIN } });
  assert.match(connected, /^ {4}"model"/m, 'four-space indentation kept');
  assert.equal(claudeCodec.inspect(connected, ORIGIN).state, 'connected');
  assert.equal(claudeCodec.remove(connected, ORIGIN), original);
});

test('claude: no API key is ever written', () => {
  assert.doesNotMatch(claudeCodec.apply('{}', ORIGIN), /ANTHROPIC_API_KEY/);
});

test('claude: invalid JSON is refused and the file left as it was', async () => {
  await withHome(async (home, ctx) => {
    const path = join(home, '.claude', 'settings.json');
    await put(path, '{ "model": "opus", }');
    const { clients, errors } = await runClientAction('connect', ['claude'], ORIGIN, { replace: true }, ctx);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /^Claude Code: .*not valid JSON/);
    assert.equal(clients[0].state, 'unreadable');
    assert.equal(await readFile(path, 'utf8'), '{ "model": "opus", }');
  });
});

test('claude: another address is kept until replace is asked for, and disconnect leaves it', async () => {
  await withHome(async (home, ctx) => {
    const path = join(home, '.claude', 'settings.json');
    const foreign = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "http://10.0.0.2:3456"\n  }\n}\n';
    await put(path, foreign);

    let out = await runClientAction('connect', ['claude'], ORIGIN, {}, ctx);
    assert.deepEqual(out.clients[0], { id: 'claude', label: 'Claude Code', where: path, state: 'elsewhere', current: 'http://10.0.0.2:3456' });
    assert.equal(out.errors[0].replaceable, true);
    assert.equal(await readFile(path, 'utf8'), foreign);

    out = await runClientAction('disconnect', ['claude'], ORIGIN, {}, ctx);
    assert.deepEqual(out.errors, []);
    assert.equal(await readFile(path, 'utf8'), foreign);

    out = await runClientAction('connect', ['claude'], ORIGIN, { replace: true }, ctx);
    assert.equal(out.clients[0].state, 'connected');
  });
});

// ── Codex CLI ──

test('codex: an empty config gets the provider line and table, and disconnect empties it again', () => {
  const connected = codexCodec.apply(null, CODEX_TARGET);
  assert.equal(connected, `model_provider = "teamclaude"\n\n${CODEX_BLOCK}`);
  assert.equal(codexCodec.inspect(connected, CODEX_TARGET).state, 'connected');
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), '');
});

test('codex: other keys and tables are untouched, and connect then disconnect gives the file back', () => {
  const original = '# my settings\nmodel = "gpt-5"\napproval_policy = "never"\n\n# profiles\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[model_providers.other]\nname = "other"\n';
  const connected = codexCodec.apply(original, CODEX_TARGET);
  assert.equal(connected,
    '# my settings\nmodel = "gpt-5"\napproval_policy = "never"\nmodel_provider = "teamclaude"\n\n# profiles\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n'
    + `[model_providers.other]\nname = "other"\n\n${CODEX_BLOCK}`);
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), original);
});

test('codex: connecting twice writes the same file', async () => {
  await withHome(async (home, ctx) => {
    const path = join(home, '.codex', 'config.toml');
    await put(path, 'model = "gpt-5"\n');
    await runClientAction('connect', ['codex'], ORIGIN, {}, ctx);
    const once = await readFile(path, 'utf8');
    const again = await runClientAction('connect', ['codex'], ORIGIN, {}, ctx);
    assert.deepEqual(again.errors, []);
    assert.equal(await readFile(path, 'utf8'), once);
    // And disconnecting when not connected is a quiet no-op.
    await runClientAction('disconnect', ['codex'], ORIGIN, {}, ctx);
    const after = await runClientAction('disconnect', ['codex'], ORIGIN, {}, ctx);
    assert.deepEqual(after.errors, []);
    assert.equal(await readFile(path, 'utf8'), 'model = "gpt-5"\n');
  });
});

test('codex: the provider of the active profile is the one that counts, and a round trip restores it', () => {
  const original = 'profile = "work"\n\n[profiles.work]\nmodel_provider = "openai" # my work account\nmodel = "gpt-5"\n';
  assert.deepEqual(codexCodec.inspect(original, CODEX_TARGET), { state: 'elsewhere', current: 'profile "work" model_provider "openai"' });
  const connected = codexCodec.apply(original, CODEX_TARGET);
  assert.match(connected, /\[profiles\.work\]\nmodel_provider = "teamclaude" # teamclaude: was "openai" # my work account\n/);
  assert.doesNotMatch(connected.split('[')[0], /model_provider/, 'the root key, which the profile overrides, is not added');
  assert.equal(codexCodec.inspect(connected, CODEX_TARGET).state, 'connected');
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), original);
});

test('codex: a profile that is not selected does not count', () => {
  const original = 'model_provider = "openai"\n\n[profiles.other]\nmodel_provider = "azure"\n';
  assert.deepEqual(codexCodec.inspect(original, CODEX_TARGET), { state: 'elsewhere', current: 'model_provider "openai"' });
  assert.match(codexCodec.apply(original, CODEX_TARGET), /\[profiles\.other\]\nmodel_provider = "azure"\n/);
});

test('codex: our table naming another address is kept without replace, whatever its wire_api', async () => {
  for (const wire of ['', 'wire_api = "chat"\n']) {
    await withHome(async (home, ctx) => {
      const path = join(home, '.codex', 'config.toml');
      const foreign = `model_provider = "teamclaude"\n\n[model_providers.teamclaude]\nname = "teamclaude"\nbase_url = "http://10.0.0.2:3456/backend-api/codex"\n${wire}`;
      await put(path, foreign);
      const out = await runClientAction('connect', ['codex'], ORIGIN, {}, ctx);
      assert.equal(out.clients[0].state, 'elsewhere');
      assert.equal(out.errors[0].replaceable, true);
      assert.equal(await readFile(path, 'utf8'), foreign);
    });
  }
});

test('codex: a file that sets model_provider twice is refused, not half-edited', () => {
  assert.throws(() => codexCodec.inspect('model_provider = "a"\nmodel_provider = "b"\n', CODEX_TARGET), /more than once/);
});

test('codex: a table header inside a multi-line string is string content', () => {
  const original = 'notes = """\nhello\n[model_providers.teamclaude]\n"""\nmodel = "gpt-5"\n';
  assert.equal(codexCodec.inspect(original, CODEX_TARGET).state, 'disconnected');
  const connected = codexCodec.apply(original, CODEX_TARGET);
  assert.ok(connected.startsWith(original.replace('model = "gpt-5"\n', 'model = "gpt-5"\nmodel_provider = "teamclaude"\n')), connected);
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), original);
});

test('codex: the table hand-added from the docs is recognised, and replaced rather than duplicated', () => {
  const handAdded = 'model_provider = "teamclaude"\n\n[model_providers.teamclaude]\nname = "teamclaude"\nbase_url = "http://127.0.0.1:4000/backend-api/codex"\nwire_api = "responses"\nhttp_headers = { "x-api-key" = "k" }\n\n[profiles.x]\nmodel = "m"\n';
  assert.equal(codexCodec.inspect(handAdded, `http://127.0.0.1:4000/backend-api/codex`).state, 'connected');
  assert.deepEqual(codexCodec.inspect(handAdded, CODEX_TARGET), { state: 'elsewhere', current: 'http://127.0.0.1:4000/backend-api/codex' });

  const replaced = codexCodec.apply(handAdded, CODEX_TARGET);
  assert.equal(replaced.match(/\[model_providers\.teamclaude\]/g).length, 1);
  assert.equal(replaced, `model_provider = "teamclaude"\n\n${CODEX_BLOCK}\n[profiles.x]\nmodel = "m"\n`);
});

test('codex: another model_provider is elsewhere, replace keeps it, and disconnect restores it', async () => {
  await withHome(async (home, ctx) => {
    const path = join(home, '.codex', 'config.toml');
    const original = 'model_provider = "openai"\nmodel = "gpt-5"\n';
    await put(path, original);

    let out = await runClientAction('connect', ['codex'], ORIGIN, {}, ctx);
    assert.equal(out.clients[0].state, 'elsewhere');
    assert.equal(out.clients[0].current, 'model_provider "openai"');
    assert.equal(await readFile(path, 'utf8'), original);

    out = await runClientAction('connect', ['codex'], ORIGIN, { replace: true }, ctx);
    assert.equal(out.clients[0].state, 'connected');
    const text = await readFile(path, 'utf8');
    assert.match(text, /^model_provider = "teamclaude" # teamclaude: was "openai"$/m);

    await runClientAction('disconnect', ['codex'], ORIGIN, {}, ctx);
    assert.equal(await readFile(path, 'utf8'), original);
  });
});

test('codex: CRLF line endings are kept', () => {
  const connected = codexCodec.apply('model = "gpt-5"\r\n', CODEX_TARGET);
  assert.doesNotMatch(connected.replace(/\r\n/g, ''), /\n/);
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), 'model = "gpt-5"\r\n');
});

test('codex: a provider written as a dotted key is not edited', () => {
  assert.throws(() => codexCodec.inspect('model_providers.teamclaude.name = "x"\n', CODEX_TARGET), ConnectError);
  assert.throws(() => codexCodec.inspect('[model_providers]\nteamclaude = { name = "x" }\n', CODEX_TARGET), ConnectError);
});

// ── Grok Build ──

test('grok: on Linux a managed export line goes in the shell rc, and a new terminal is called for', async () => {
  await withHome(async (home, ctx) => {
    const rc = join(home, '.zshrc');
    await put(rc, 'export PATH="$HOME/bin:$PATH"\n');
    const { clients, errors } = await runClientAction('connect', ['grok'], ORIGIN, {}, ctx);
    assert.deepEqual(errors, []);
    assert.equal(clients[0].where, rc);
    assert.equal(clients[0].state, 'connected');
    assert.match(clients[0].note, /terminal/);
    assert.equal(await readFile(rc, 'utf8'), `export PATH="$HOME/bin:$PATH"\n# teamclaude grok\nexport GROK_CLI_CHAT_PROXY_BASE_URL='${GROK_TARGET}'\n`);

    await runClientAction('disconnect', ['grok'], ORIGIN, {}, ctx);
    assert.equal(await readFile(rc, 'utf8'), 'export PATH="$HOME/bin:$PATH"\n');
  }, { shell: '/usr/bin/zsh' });
});

test('grok: an export of its own in the rc is another address', () => {
  const codec = grokRcCodec('bash');
  assert.deepEqual(codec.inspect('export GROK_CLI_CHAT_PROXY_BASE_URL=http://10.0.0.2:3456/grok/v1\n', GROK_TARGET),
    { state: 'elsewhere', current: 'http://10.0.0.2:3456/grok/v1' });
});

test('grok: fish gets set -gx', () => {
  assert.match(grokRcCodec('fish').apply('', GROK_TARGET), /^set -gx GROK_CLI_CHAT_PROXY_BASE_URL 'http:\/\/127\.0\.0\.1:3456\/grok\/v1'$/m);
});

test('grok: on Windows the user environment is set through PowerShell, the value passed in the environment', async () => {
  let stored = null;
  const calls = [];
  const runPowerShell = async (script, env = {}) => {
    calls.push({ script, env });
    if (script.includes('GetEnvironmentVariable')) return stored == null ? '\r\n' : `${stored}\r\n`;
    stored = script.includes('$null') ? null : env.TEAMCLAUDE_CONNECT_VALUE;
    return '';
  };
  await withHome(async (_home, ctx) => {
    const { clients } = await runClientAction('connect', ['grok'], ORIGIN, {}, ctx);
    assert.deepEqual(clients[0], {
      id: 'grok', label: 'Grok Build', note: clients[0].note, where: 'Windows user environment', state: 'connected',
    });
    const set = calls.find(c => c.script.includes('SetEnvironmentVariable'));
    assert.equal(set.script, "[Environment]::SetEnvironmentVariable('GROK_CLI_CHAT_PROXY_BASE_URL', $env:TEAMCLAUDE_CONNECT_VALUE, 'User')");
    assert.deepEqual(set.env, { TEAMCLAUDE_CONNECT_VALUE: GROK_TARGET });
    assert.ok(calls.every(c => !c.script.includes(GROK_TARGET)), 'the address never appears in a script');

    await runClientAction('disconnect', ['grok'], ORIGIN, {}, ctx);
    assert.equal(stored, null);
    assert.equal(calls.at(-2).script, "[Environment]::SetEnvironmentVariable('GROK_CLI_CHAT_PROXY_BASE_URL', $null, 'User')");
    assert.equal((await clientStatus('grok', ORIGIN, ctx)).state, 'disconnected');
  }, { platform: 'win32', runPowerShell });
});

test('grok: a PowerShell failure reads as unreadable rather than throwing', async () => {
  await withHome(async (_home, ctx) => {
    const status = await clientStatus('grok', ORIGIN, ctx);
    assert.equal(status.state, 'unreadable');
    assert.match(status.problem, /PowerShell/);
  }, { platform: 'win32', runPowerShell: async () => { throw new Error('PowerShell failed: not found'); } });
});

test('codex: the active profile is edited in place whichever comes first, its table or ours', () => {
  const ourFirst = 'profile = "work"\n\n[model_providers.teamclaude]\nname = "teamclaude"\nbase_url = "http://127.0.0.1:3456/backend-api/codex"\nwire_api = "chat"\nhttp_headers = { "x" = "y" }\nrequest_max_retries = 2\n\n[profiles.work]\nmodel_provider = "openai"\nmodel = "gpt-5"\n';
  const connected = codexCodec.apply(ourFirst, CODEX_TARGET);
  assert.equal(connected,
    `profile = "work"\n\n${CODEX_BLOCK}\n[profiles.work]\nmodel_provider = "teamclaude" # teamclaude: was "openai"\nmodel = "gpt-5"\n`);
  assert.equal(codexCodec.inspect(connected, CODEX_TARGET).state, 'connected');
  assert.equal(codexCodec.remove(connected, CODEX_TARGET), 'profile = "work"\n\n[profiles.work]\nmodel_provider = "openai"\nmodel = "gpt-5"\n');
});

test('codex: a hand-written provider line with no note is removed on disconnect, with our table before it', () => {
  const handWritten = `profile = "work"\n\n${CODEX_BLOCK}\n[profiles.work]\nmodel_provider = "teamclaude"\nmodel = "gpt-5"\n`;
  assert.equal(codexCodec.inspect(handWritten, CODEX_TARGET).state, 'connected');
  assert.equal(codexCodec.remove(handWritten, CODEX_TARGET), 'profile = "work"\n\n[profiles.work]\nmodel = "gpt-5"\n');
});

test('codex: triple quotes inside a comment or a one-line string open no multi-line string', () => {
  for (const noise of ['# see the """ example', "# don't use ''' here", 'title = "say \\"\\"\\" here"']) {
    const original = `${noise}\nmodel_provider = "openai"\n`;
    assert.deepEqual(codexCodec.inspect(original, CODEX_TARGET), { state: 'elsewhere', current: 'model_provider "openai"' }, noise);
  }
  const commentedHeader = 'model_provider = "teamclaude"\n\n[model_providers.teamclaude] # docs use """\nname = "teamclaude"\nbase_url = "http://10.0.0.2:9999/backend-api/codex"\n';
  assert.deepEqual(codexCodec.inspect(commentedHeader, CODEX_TARGET), { state: 'elsewhere', current: 'http://10.0.0.2:9999/backend-api/codex' });
});

test('codex: a profile model_provider written as a dotted key is refused, not shadowed', () => {
  assert.throws(() => codexCodec.inspect('profile = "work"\nprofiles.work.model_provider = "openai"\n', CODEX_TARGET), /dotted key/);
  assert.throws(() => codexCodec.inspect('profile = "work"\n\n[profiles]\nwork.model_provider = "openai"\n', CODEX_TARGET), /dotted key/);
});

test('the IPv6 loopback and 127.0.0.1 are the same machine', () => {
  assert.ok(sameAddress('http://[::1]:3456', ORIGIN));
});
