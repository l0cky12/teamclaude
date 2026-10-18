// The dashboard's sign-in (web-login.js): the open sign-ins the server keeps,
// the steps of one, and the guard its save runs under the config lock. The
// flows are the real paste-only ones with the token endpoint stubbed, so what
// a paste must look like is the providers' own parsing, not a test double's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebLogins, startWebFlow, signInGuard, WebLoginError, WEB_LOGIN_TIMEOUT_MS, WEB_LOGIN_MAX_PENDING, operatorError } from '../src/web-login.js';
import { startCodexLogin } from '../src/codex-auth.js';
import { EventLog } from '../src/event-log.js';
import { findUpsertTarget } from '../src/identity.js';
import { checkNewAccountName, freeNumberedName, ConfigOpError } from '../src/config-ops.js';

const START = 1_000_000_000_000;

// Obviously fake values throughout: no test carries anything shaped like a
// real token or an email.
const CLAUDE_TOKENS = { accessToken: 'fake-claude-access', refreshToken: 'fake-claude-refresh', expiresAt: 0 };
const CODEX_TOKENS = { accessToken: 'fake-codex-access', refreshToken: 'fake-codex-refresh', expiresAt: 0, accountId: 'chatgpt-acct-1', userId: 'user-1' };

/**
 * The real paste-only flows with the token endpoint stubbed. `exchanges`
 * records what each exchange was given (the PKCE verifier among it), and
 * `hold` makes the next exchanges wait until released.
 */
function stubFlows({ fail = null } = {}) {
  /** @type {{ provider: string, args: any[] }[]} */
  const exchanges = [];
  /** @type {AbortSignal[]} */
  const signals = [];
  let release = () => {};
  /** @type {Promise<void>|null} */
  let held = null;
  const startFlow = (/** @type {any} */ provider, /** @type {any} */ opts) => {
    signals.push(opts.signal);
    return startWebFlow(provider, {
      ...opts,
      exchange: async (/** @type {any[]} */ ...args) => {
        exchanges.push({ provider, args });
        if (held) await held;
        if (fail) throw fail;
        return provider === 'codex' ? { ...CODEX_TOKENS } : { ...CLAUDE_TOKENS };
      },
    });
  };
  return {
    startFlow, exchanges, signals,
    hold() { held = new Promise(resolve => { release = resolve; }); },
    release: () => release(),
  };
}

/** What the browser is left holding for a sign-in started at `url`. */
function pasteFor(provider, url, code = 'test-code') {
  const state = new URL(url).searchParams.get('state');
  return provider === 'codex'
    ? `http://localhost:1455/auth/callback?code=${code}&state=${state}`
    : `${code}#${state}`;
}

/**
 * A WebLogins over a fake clock, stubbed flows and recording hooks.
 * @param {{ accounts?: any[], configAccounts?: any[], save?: Function, flows?: ReturnType<typeof stubFlows>, maxPending?: number }} [opts]
 */
function setup({ accounts = [], configAccounts = accounts, save, flows = stubFlows(), maxPending } = {}) {
  const clock = { now: START };
  const events = new EventLog({ now: () => clock.now });
  /** @type {any[]} */
  const saved = [];
  let reloads = 0;
  const hooks = {
    saveWebSignIn: save ?? (async (/** @type {any} */ signIn) => {
      saved.push(signIn);
      return { action: 'added', name: signIn.name ?? 'account-1' };
    }),
    reload: async () => { reloads++; },
  };
  const logins = new WebLogins({
    hooks, events, accounts: () => accounts, configAccounts: () => configAccounts,
    now: () => clock.now, startFlow: flows.startFlow, timer: false,
    ...(maxPending ? { maxPending } : {}),
  });
  return { logins, clock, events, saved, flows, hooks, reloads: () => reloads, types: () => events.since(0).events.map(e => e.type) };
}

test('start hands back a sign-in link for each provider, and records the start', async () => {
  const { logins, events } = setup();
  const claude = await logins.start({ provider: 'claude' });
  assert.equal(claude.status, 200);
  assert.deepEqual(Object.keys(claude.body).sort(), ['expiresAt', 'id', 'ok', 'provider', 'url']);
  assert.equal(claude.body.provider, 'claude');
  assert.equal(claude.body.expiresAt, START + WEB_LOGIN_TIMEOUT_MS);
  const claudeUrl = new URL(claude.body.url);
  assert.equal(`${claudeUrl.origin}${claudeUrl.pathname}`, 'https://claude.ai/oauth/authorize');
  // The code page, not a loopback listener: the browser is on another machine.
  assert.equal(claudeUrl.searchParams.get('redirect_uri'), 'https://console.anthropic.com/oauth/code/callback');

  const codex = await logins.start({ provider: 'codex' });
  assert.equal(codex.status, 200);
  const codexUrl = new URL(codex.body.url);
  assert.equal(`${codexUrl.origin}${codexUrl.pathname}`, 'https://auth.openai.com/oauth/authorize');
  assert.notEqual(codex.body.id, claude.body.id);
  // Unguessable: a random UUID, not a counter.
  assert.match(claude.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const started = events.since(0).events;
  assert.deepEqual(started.map(e => [e.type, e.provider, e.account]), [['signin_started', 'anthropic', null], ['signin_started', 'codex', null]]);
  assert.match(started[0].message, /\(dashboard\)/);
  logins.close();
});

test('the Codex web flow binds no port', async () => {
  // A port this test holds: a flow that tried to listen on it would report
  // the collision, so its absence shows nothing was tried.
  const holder = net.createServer();
  await new Promise(resolve => holder.listen(0, '127.0.0.1', () => resolve(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (holder.address()).port;
  const controller = new AbortController();
  try {
    const quiet = await startCodexLogin({ listen: false, port, timeoutMs: 0, signal: controller.signal });
    assert.equal(quiet.listening, false);
    assert.equal(quiet.listenError, null);
    // The same call left to listen does collide, so the check above can fail.
    const listening = await startCodexLogin({ port, timeoutMs: 0, signal: controller.signal });
    assert.equal(listening.listening, false);
    assert.match(String(listening.listenError?.message), new RegExp(`Port ${port} is in use`));

    const web = await startWebFlow('codex', { signal: controller.signal });
    assert.equal(web.listening, false);
  } finally {
    controller.abort();
    await new Promise(resolve => holder.close(() => resolve(undefined)));
  }
});

test('a paste that cannot be used answers 400 with retry, and the sign-in stays open', async () => {
  for (const provider of /** @type {const} */ (['claude', 'codex'])) {
    const { logins, saved, flows, types } = setup();
    const { body: { id, url } } = await logins.start({ provider });

    const wrongState = provider === 'codex'
      ? 'http://localhost:1455/auth/callback?code=test-code&state=another-attempt'
      : 'test-code#another-attempt';
    const bad = await logins.finish({ id, input: wrongState });
    assert.equal(bad.status, 400, provider);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.retry, true);
    assert.match(bad.body.error, /different sign-in attempt/);

    // The link itself, pasted back by mistake.
    const link = await logins.finish({ id, input: url });
    assert.equal(link.status, 400);
    assert.match(link.body.error, /sign-in link itself/);

    // Nothing pasted, and a body without input.
    assert.equal((await logins.finish({ id, input: '   ' })).status, 400);
    const missing = await logins.finish({ id });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.retry, true);

    // Still open, nothing exchanged or saved, and no failure on the event log:
    // the sign-in has not ended.
    assert.equal(logins.pending.has(id), true);
    assert.equal(flows.exchanges.length, 0);
    assert.equal(saved.length, 0);
    assert.deepEqual(types(), ['signin_started']);

    const good = await logins.finish({ id, input: pasteFor(provider, url) });
    assert.equal(good.status, 200, provider);
  }
});

test('a finished sign-in is saved through the hook and reloaded, and returns no secret', async () => {
  for (const provider of /** @type {const} */ (['claude', 'codex'])) {
    const { logins, saved, flows, events, reloads } = setup();
    const start = await logins.start({ provider, name: 'laptop' });
    const { id, url } = start.body;
    const finish = await logins.finish({ id, input: pasteFor(provider, url, 'one-time-code') });
    assert.equal(finish.status, 200, provider);
    assert.deepEqual(finish.body, { ok: true, account: 'laptop', action: 'added' });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].provider, provider);
    assert.equal(saved[0].name, 'laptop');
    assert.equal(saved[0].target, null);
    assert.deepEqual(saved[0].credentials, provider === 'codex' ? CODEX_TOKENS : CLAUDE_TOKENS);
    assert.equal(reloads(), 1);

    const last = events.since(0).events.at(-1);
    assert.equal(last?.type, 'signin_succeeded');
    assert.equal(last?.account, 'laptop');
    // The log names providers the way every other entry does (provider.js ids).
    assert.equal(last?.provider, provider === 'claude' ? 'anthropic' : provider);

    // The id is spent.
    assert.equal(logins.pending.has(id), false);
    assert.equal((await logins.finish({ id, input: pasteFor(provider, url) })).status, 404);

    // What was exchanged never leaves: not the code, not the PKCE verifier,
    // not a token. The state rides in the sign-in link (the provider needs it
    // there) and nowhere else.
    const [exchange] = flows.exchanges;
    const verifier = provider === 'codex' ? exchange.args[0].codeVerifier : exchange.args[2];
    const code = provider === 'codex' ? exchange.args[0].code : exchange.args[0];
    assert.equal(code, 'one-time-code');
    const state = new URL(url).searchParams.get('state');
    const out = JSON.stringify([finish.body, events.since(0)]);
    for (const secret of [verifier, code, state, 'fake-claude-access', 'fake-codex-refresh']) {
      assert.equal(out.includes(String(secret)), false, `${provider}: ${secret}`);
    }
    assert.equal(JSON.stringify({ ...start.body, url: null }).includes(String(state)), false);
  }
});

test('an expired sign-in is swept by the clock: aborted, logged as a timeout, and gone', async () => {
  const { logins, clock, flows, types } = setup();
  const { body: { id, url } } = await logins.start({ provider: 'claude' });

  clock.now = START + WEB_LOGIN_TIMEOUT_MS - 1;
  assert.equal(logins.sweep(), 0);
  assert.equal(logins.pending.has(id), true);

  clock.now = START + WEB_LOGIN_TIMEOUT_MS;
  assert.equal(logins.sweep(), 1);
  assert.equal(logins.pending.has(id), false);
  assert.deepEqual(types(), ['signin_started', 'signin_timeout']);
  // The flow itself was ended, so its paste can no longer complete anything.
  assert.equal(flows.signals[0].aborted, true);
  assert.match(String(flows.signals[0].reason?.message), /timed out/);

  const late = await logins.finish({ id, input: pasteFor('claude', url) });
  assert.equal(late.status, 404);
  assert.equal(flows.exchanges.length, 0);
});

test('finish and cancel sweep first, so an expired id is a 404 rather than a late success', async () => {
  const { logins, clock, types } = setup();
  const { body: { id, url } } = await logins.start({ provider: 'codex' });
  clock.now = START + WEB_LOGIN_TIMEOUT_MS + 1;
  assert.equal((await logins.finish({ id, input: pasteFor('codex', url) })).status, 404);
  assert.deepEqual(types(), ['signin_started', 'signin_timeout']);
});

test('cancel ends the flow and records signin_cancelled', async () => {
  const { logins, flows, events } = setup();
  const { body: { id } } = await logins.start({ provider: 'claude' });
  const cancelled = logins.cancel({ id });
  assert.deepEqual(cancelled, { status: 200, body: { ok: true } });
  assert.equal(flows.signals[0].aborted, true);
  assert.equal(logins.pending.has(id), false);
  const last = events.since(0).events.at(-1);
  assert.equal(last?.type, 'signin_cancelled');
  // A second cancel, or one for an id never handed out, says there was nothing.
  assert.equal(logins.cancel({ id }).status, 404);
  assert.equal(logins.cancel({ id: 'not-an-id' }).status, 404);
  assert.equal(logins.cancel({}).status, 404);
});

test('a fifth open sign-in is refused with 429 until one ends', async () => {
  const { logins } = setup();
  /** @type {string[]} */
  const ids = [];
  for (let i = 0; i < WEB_LOGIN_MAX_PENDING; i++) {
    const r = await logins.start({ provider: i % 2 ? 'codex' : 'claude' });
    assert.equal(r.status, 200);
    ids.push(r.body.id);
  }
  const fifth = await logins.start({ provider: 'claude' });
  assert.equal(fifth.status, 429);
  assert.match(fifth.body.error, /already open/);
  logins.cancel({ id: ids[0] });
  assert.equal((await logins.start({ provider: 'claude' })).status, 200);
  logins.close();
});

test('a failed token exchange ends the sign-in with 502 and records signin_failed', async () => {
  const fail = new Error('Token exchange failed (400): {"error":"invalid_grant","detail":"upstream text"}');
  const { logins, saved, events } = setup({ flows: stubFlows({ fail }) });
  const { body: { id, url } } = await logins.start({ provider: 'claude' });
  const r = await logins.finish({ id, input: pasteFor('claude', url) });
  assert.equal(r.status, 502);
  assert.equal(r.body.retry, undefined);
  // The upstream's body is cut off; only its status stays.
  assert.match(r.body.error, /the provider answered HTTP 400/);
  assert.equal(r.body.error.includes('upstream text'), false);
  assert.equal(saved.length, 0);
  assert.equal(logins.pending.has(id), false);
  const last = events.since(0).events.at(-1);
  assert.equal(last?.type, 'signin_failed');
  assert.equal(last?.message.includes('upstream text'), false);
});

/** Run fn with console.error and console.log captured; returns what they printed. */
async function captureConsole(/** @type {() => Promise<void>} */ fn) {
  const lines = /** @type {string[]} */ ([]);
  const { error, log } = console;
  console.error = (...a) => { lines.push(a.join(' ')); };
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.error = error; console.log = log; }
  return lines.join('\n');
}

// The save hook is index.js's upsert, which throws this shape when the
// signed-in account's profile cannot be read: the provider's body quoted in
// full. None of it may reach the reply, the event log or the server's output.
test('a profile lookup the provider refused is reported without its body anywhere', async () => {
  const body = '{"error":{"message":"denied for someone@example.com","org":"org-secret"}}';
  const { logins, events } = setup({
    save: async () => { throw new Error(`Could not identify OAuth account — HTTP 403: ${body}. Retry with valid credentials, or pass --name to add the account without profile detection.`); },
  });
  let r;
  const printed = await captureConsole(async () => {
    const { body: { id, url } } = await logins.start({ provider: 'claude' });
    r = await logins.finish({ id, input: pasteFor('claude', url) });
  });
  assert.equal(r.status, 500);
  const logged = JSON.stringify(events.since(0).events);
  for (const where of [r.body.error, logged, printed]) {
    assert.equal(where.includes('someone@example.com'), false, where);
    assert.equal(where.includes('org-secret'), false, where);
  }
  assert.match(r.body.error, /profile could not be read/);
  assert.match(printed, /profile could not be read/);
});

test('our own errors stay readable: a guard refusal on the log, a failed save in the server output', async () => {
  const guarded = setup({ save: async () => { throw new WebLoginError(409, 'Signed in as "b", not "a"'); } });
  let r;
  await captureConsole(async () => {
    const { body: { id, url } } = await guarded.logins.start({ provider: 'claude' });
    r = await guarded.logins.finish({ id, input: pasteFor('claude', url) });
  });
  assert.equal(r.status, 409);
  assert.match(guarded.events.since(0).events.at(-1)?.message ?? '', /Signed in as "b", not "a"/);

  const broken = setup({ save: async () => { throw new Error("EACCES: permission denied, open '/data/teamclaude.json'"); } });
  const printed = await captureConsole(async () => {
    const { body: { id, url } } = await broken.logins.start({ provider: 'claude' });
    await broken.logins.finish({ id, input: pasteFor('claude', url) });
  });
  assert.match(printed, /EACCES: permission denied/);
});

test('operatorError cuts only the shapes that carry a provider\'s text', () => {
  assert.equal(operatorError(new Error('Codex token exchange failed (401): <html>x</html>')), 'the provider answered HTTP 401');
  assert.equal(operatorError(new Error('The sign-in was refused: access_denied (you said no)')), 'the provider refused the sign-in (access_denied)');
  assert.equal(operatorError(new Error('reload failed: config is not valid JSON')), 'reload failed: config is not valid JSON');
});

test('while a paste is being exchanged, a second finish or a cancel is refused, and the sweep leaves it alone', async () => {
  const flows = stubFlows();
  const { logins, clock, types } = setup({ flows });
  const { body: { id, url } } = await logins.start({ provider: 'codex' });
  flows.hold();
  const first = logins.finish({ id, input: pasteFor('codex', url) });
  // The exchange is waiting on the hold; let the finish reach it.
  while (flows.exchanges.length === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await logins.finish({ id, input: pasteFor('codex', url) })).status, 409);
  assert.equal(logins.cancel({ id }).status, 409);
  clock.now = START + WEB_LOGIN_TIMEOUT_MS * 2;
  assert.equal(logins.sweep(), 0);
  flows.release();
  assert.equal((await first).status, 200);
  assert.deepEqual(types(), ['signin_started', 'signin_succeeded']);
});

test('start checks what it is asked to sign in', async () => {
  const configAccounts = [
    { id: 'e-work', name: 'work', type: 'oauth', accountUuid: 'uuid-work' },
    { id: 'e-gpt', name: 'gpt', type: 'oauth', provider: 'codex', accountId: 'acct-gpt' },
    { id: 'e-file', name: 'from-file', type: 'oauth', importFrom: '/nonexistent/credentials.json' },
    { id: 'e-key', name: 'metered', type: 'apikey' },
  ];
  const accounts = [
    { id: 'e-work', name: 'work', type: 'oauth', provider: 'anthropic', routing: null },
    { id: 'e-gpt', name: 'gpt', type: 'oauth', provider: 'codex', routing: null },
    { id: 'e-file', name: 'from-file', type: 'oauth', provider: 'anthropic' },
    { id: 'e-key', name: 'metered', type: 'apikey', provider: 'anthropic' },
    // Admitted to the pool but in no config row: nowhere to save its tokens.
    { id: 'e-gone', name: 'detached', type: 'oauth', provider: 'anthropic' },
  ];
  const { logins, saved, events } = setup({ accounts, configAccounts });
  /** @type {[any, number, RegExp][]} */
  const cases = [
    [{}, 400, /provider must be/],
    [{ provider: 'gemini' }, 400, /provider must be/],
    [{ provider: 'claude', account: 'nobody' }, 404, /No account is named "nobody"/],
    [{ provider: 'codex', account: 'work' }, 400, /not a Codex account/],
    [{ provider: 'claude', account: 'metered' }, 400, /not an OAuth account/],
    [{ provider: 'claude', account: 'from-file' }, 409, /importFrom/],
    [{ provider: 'claude', account: 'detached' }, 409, /not in this server's config file/],
    [{ provider: 'claude', account: 'work', name: 'renamed' }, 400, /name is for a new account/],
    [{ provider: 'claude', account: 42 }, 400, /account must be/],
    [{ provider: 'claude', name: 'work' }, 400, /already names another account/],
    [{ provider: 'claude', name: '1234' }, 400, /all digits/],
    [{ provider: 'claude', name: 'bad\x1bname' }, 400, /control characters/],
    [{ provider: 'claude', name: 7 }, 400, /name must be a string/],
  ];
  for (const [body, status, message] of cases) {
    const r = await logins.start(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match(r.body.error, message, JSON.stringify(body));
  }
  assert.equal(logins.pending.size, 0);
  assert.equal(events.since(0).events.length, 0, 'a refused start records nothing');

  // A blank name is automatic naming; a re-login carries its target.
  const auto = await logins.start({ provider: 'claude', name: '  ' });
  assert.equal(auto.status, 200);
  const relogin = await logins.start({ provider: 'codex', account: 'gpt', name: '' });
  assert.equal(relogin.status, 200);
  await logins.finish({ id: relogin.body.id, input: pasteFor('codex', relogin.body.url) });
  assert.deepEqual(saved[0].target, { name: 'gpt', id: 'e-gpt', routing: null });
  assert.equal(saved[0].name, null);
  assert.equal(events.since(0).events.find(e => e.type === 'signin_started' && e.provider === 'codex')?.account, 'gpt');
  logins.close();
});

test('a save the guard refuses ends the sign-in with its status and nothing written', async () => {
  // A stand-in for the upsert: find the row the way it does, ask the guard,
  // and only then write. The re-login below signs in as another account.
  const rows = [
    { id: 'e-work', name: 'work', type: 'oauth', accountUuid: 'uuid-work', orgUuid: 'org-1' },
    { id: 'e-home', name: 'home', type: 'oauth', accountUuid: 'uuid-home', orgUuid: 'org-1' },
  ];
  const before = JSON.stringify(rows);
  const save = async (/** @type {any} */ signIn) => {
    const incoming = { name: 'account-3', type: 'oauth', accountUuid: 'uuid-home', orgUuid: 'org-1', accessToken: signIn.credentials.accessToken };
    const idx = findUpsertTarget(rows, incoming);
    signInGuard(signIn)(rows, idx, incoming);
    rows[idx] = { ...rows[idx], accessToken: incoming.accessToken };
    return { action: 'updated', name: rows[idx].name };
  };
  const accounts = rows.map(r => ({ ...r, provider: 'anthropic', routing: null }));
  const { logins, events, reloads } = setup({ accounts, configAccounts: rows, save });
  const { body: { id, url } } = await logins.start({ provider: 'claude', account: 'work' });
  const r = await logins.finish({ id, input: pasteFor('claude', url) });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { ok: false, error: 'Signed in as "home", not "work"' });
  assert.equal(JSON.stringify(rows), before);
  assert.equal(reloads(), 0);
  assert.equal(logins.pending.has(id), false);
  const last = events.since(0).events.at(-1);
  assert.equal(last?.type, 'signin_failed');
  assert.equal(last?.account, 'work');
  assert.match(String(last?.message), /Signed in as "home", not "work"/);
});

test('a reload that fails after the save is reported as such', async () => {
  const { logins, hooks, events } = setup();
  hooks.reload = async () => { throw new Error('disk on fire'); };
  const { body: { id, url } } = await logins.start({ provider: 'claude' });
  const r = await logins.finish({ id, input: pasteFor('claude', url) });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /saved to the config file, but the reload failed/);
  // The sign-in itself succeeded and is on disk.
  assert.equal(events.since(0).events.at(-1)?.type, 'signin_succeeded');
});

test('available needs both the save hook and reload', () => {
  const make = (/** @type {any} */ hooks) => new WebLogins({ hooks, accounts: () => [], configAccounts: () => [], timer: false });
  assert.equal(make({}).available, false);
  assert.equal(make({ reload: async () => {} }).available, false);
  assert.equal(make({ saveWebSignIn: async () => ({ action: 'added', name: 'x' }), reload: async () => {} }).available, true);
});

// The guard on its own, against rows as findUpsertTarget would pick them.
test('signInGuard: a re-login must land on its own row', () => {
  const rows = [
    { id: 'e-work', name: 'work', accountUuid: 'uuid-work', orgUuid: 'org-1' },
    { id: 'e-home', name: 'home', accountUuid: 'uuid-home', orgUuid: 'org-1' },
    { id: 'e-legacy', name: 'legacy' },
  ];
  const target = (/** @type {string} */ name, /** @type {string} */ id) => ({ target: { name, id, routing: null }, name: null });
  const incoming = (/** @type {string} */ uuid) => ({ name: 'account-9', accountUuid: uuid, orgUuid: 'org-1' });
  const run = (/** @type {any} */ signIn, /** @type {any} */ inc) => signInGuard(signIn)(rows, findUpsertTarget(rows, inc), inc);

  assert.doesNotThrow(() => run(target('work', 'e-work'), incoming('uuid-work')));
  assert.throws(() => run(target('work', 'e-work'), incoming('uuid-home')), (/** @type {any} */ err) => (
    err instanceof WebLoginError && err.status === 409 && err.message === 'Signed in as "home", not "work"'));
  // An identity nobody in the pool has: named neutrally, never by what the
  // provider reported.
  assert.throws(() => run(target('work', 'e-work'), incoming('uuid-stranger')), /Signed in as a different account, not "work"/);
  // A row with no stored identity cannot be confirmed either way.
  assert.throws(() => run(target('legacy', 'e-legacy'), incoming('uuid-stranger')), /Could not confirm this sign-in is "legacy"/);
  // Nor can a sign-in the provider did not identify.
  assert.throws(() => run(target('work', 'e-work'), { name: 'account-9' }), /Could not confirm/);
  // A row removed while the sign-in was open.
  assert.throws(() => run(target('gone', 'e-gone'), incoming('uuid-work')), /no longer in the config file/);
});

test('signInGuard: a new account updates only a row its identity proves', () => {
  const rows = [
    { id: 'e-work', name: 'work', accountUuid: 'uuid-work', orgUuid: 'org-1' },
    { id: 'e-handmade', name: 'laptop' },
  ];
  const run = (/** @type {any} */ signIn, /** @type {any} */ inc) => signInGuard(signIn)(rows, findUpsertTarget(rows, inc), inc);
  // Already in the pool: the upsert's own dedupe, allowed.
  assert.doesNotThrow(() => run({ target: null, name: null }, { name: 'account-3', accountUuid: 'uuid-work', orgUuid: 'org-1' }));
  // A brand-new account.
  assert.doesNotThrow(() => run({ target: null, name: null }, { name: 'account-3', accountUuid: 'uuid-new', orgUuid: 'org-1' }));
  // A chosen name another row holds, matched by name alone: refused.
  assert.throws(() => run({ target: null, name: 'laptop' }, { name: 'laptop', accountUuid: 'uuid-new', orgUuid: 'org-1' }), /"laptop" already names another account/);
  // The same for Codex, whose upsert matches a name outright.
  const codexRows = [{ id: 'e-gpt', name: 'gpt', provider: 'codex', accountId: 'acct-a' }];
  const incoming = { name: 'gpt', provider: 'codex', accountId: 'acct-b' };
  assert.throws(() => signInGuard({ target: null, name: 'gpt' })(codexRows, 0, incoming), /"gpt" already names another account/);
  assert.doesNotThrow(() => signInGuard({ target: null, name: null })(codexRows, 0, { ...incoming, accountId: 'acct-a' }));
});

test('checkNewAccountName and freeNumberedName', () => {
  const accounts = [{ name: 'account-1' }, { name: 'account-3' }, { name: 'account-2 (Org)' }, { name: 'work' }];
  assert.equal(checkNewAccountName(accounts, '  laptop  '), 'laptop');
  assert.throws(() => checkNewAccountName(accounts, 'work'), ConfigOpError);
  assert.throws(() => checkNewAccountName(accounts, ''), /name the new account name/);
  // The CLI's count-based name would be account-4 here (three rows carry the
  // prefix); a free one is found from wherever the count starts.
  assert.equal(freeNumberedName(accounts, 'account-', 1), 'account-4');
  assert.equal(freeNumberedName(accounts, 'account-', 3), 'account-4');
  assert.equal(freeNumberedName([], 'codex-', 1), 'codex-1');
  assert.equal(freeNumberedName([{ name: 'codex-2' }], 'codex-', 2), 'codex-3');
});
