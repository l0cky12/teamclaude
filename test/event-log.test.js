// The account event log behind the dashboard's Logs page: its bounds, what an
// entry may carry, and the account-manager decisions that record into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, logsAfter, briefError, signInEvent, clientAgent, requestPrompt, EVENT_LOG_PAGE, PROMPT_MAX } from '../src/event-log.js';
import { AccountManager } from '../src/account-manager.js';

const NOW = 1_000_000_000_000;

test('each log names its generation, so a reader can tell a restart from new events', () => {
  const a = new EventLog();
  const b = new EventLog();
  assert.equal(typeof a.since(0).generation, 'string');
  assert.equal(a.since(0).generation, a.since(5).generation);
  assert.notEqual(a.since(0).generation, b.since(0).generation);
});

test('ids increase and since() returns only what is newer', () => {
  const log = new EventLog({ now: () => NOW });
  const a = log.add({ kind: 'usage', type: 'request', message: 'one' });
  const b = log.add({ kind: 'usage', type: 'request', message: 'two' });
  assert.equal(a?.id, 1);
  assert.equal(b?.id, 2);
  assert.equal(a?.at, new Date(NOW).toISOString());
  assert.deepEqual(log.since(1).events.map(e => e.message), ['two']);
  assert.deepEqual(log.since(2).events, []);
  assert.equal(log.since(0).lastId, 2);
});

test('the oldest entries are dropped past capacity, and a reader far behind skips to what is kept', () => {
  const log = new EventLog({ capacity: 3 });
  for (let i = 1; i <= 5; i++) log.add({ kind: 'rotation', type: 'switch', message: `m${i}` });
  assert.deepEqual(log.since(0).events.map(e => e.id), [3, 4, 5]);
  // An `after` older than anything kept starts from the oldest one kept.
  assert.deepEqual(log.since(1).events.map(e => e.id), [3, 4, 5]);
  assert.deepEqual(log.since(4).events.map(e => e.id), [5]);
});

test('one read is capped at a page, newest kept', () => {
  const log = new EventLog({ capacity: EVENT_LOG_PAGE + 10 });
  for (let i = 0; i < EVENT_LOG_PAGE + 10; i++) log.add({ kind: 'usage', type: 'request', message: String(i) });
  const page = log.since(0, 10_000);
  assert.equal(page.events.length, EVENT_LOG_PAGE);
  assert.equal(page.events.at(-1)?.id, EVENT_LOG_PAGE + 10);
  assert.equal(log.since(0, 2).events.length, 2);
});

test('an unknown kind is refused, and an entry keeps only its known fields', () => {
  const log = new EventLog();
  assert.equal(log.add(/** @type {any} */ ({ kind: 'secret', type: 'x', message: 'no' })), null);
  const entry = log.add(/** @type {any} */ ({
    kind: 'usage', type: 'request', message: 'POST /v1/messages\nforged line',
    account: 'work', provider: 'claude', status: 200, inputTokens: 12.4, outputTokens: -3, ms: 'slow',
    model: 'claude-fable-5-1', accessToken: 'tok', email: 'someone@example.com',
  }));
  assert.ok(entry);
  assert.equal(entry.message.includes('\n'), false);
  assert.equal(entry.inputTokens, 12);
  assert.equal(entry.outputTokens, null);
  assert.equal(entry.ms, null);
  assert.equal(entry.model, 'claude-fable-5-1');
  assert.equal('accessToken' in entry, false);
  assert.equal('email' in entry, false);
});

test('logsAfter reads a non-negative integer and nothing else', () => {
  assert.equal(logsAfter('/teamclaude/logs?after=42'), 42);
  assert.equal(logsAfter('/teamclaude/logs'), 0);
  assert.equal(logsAfter('/teamclaude/logs?after=-1'), 0);
  assert.equal(logsAfter('/teamclaude/logs?after=1e9'), 0);
  assert.equal(logsAfter(undefined), 0);
});

test('a sign-in failure is a fixed phrase: no upstream text survives into the log', () => {
  const said = (/** @type {unknown} */ e) => briefError(e);
  // A token endpoint's body, a profile lookup's body, an OAuth error_description:
  // each keeps only its status or error code.
  assert.equal(said(new Error('Token exchange failed (400): {"error":"invalid_grant","detail":"secret-ish"}')), 'the provider answered HTTP 400');
  assert.equal(said(new Error('Codex token exchange failed (401): <html>upstream page</html>')), 'the provider answered HTTP 401');
  const profile = said(new Error('Could not identify OAuth account — HTTP 403: {"email":"someone@example.com"}'));
  assert.equal(profile, "the signed-in account's profile could not be read");
  assert.equal(said(new Error('The sign-in was refused: access_denied (The user said no to app <b>x</b>)')), 'the provider refused the sign-in (access_denied)');
  // An error "code" that is not one is not kept either.
  assert.equal(said(new Error('OpenAI refused the sign-in: Not A Code (whatever)')), "the full reason is in the server's output");
  assert.equal(said(new Error('That is not the whole code. Paste all of what the page shows')), 'the pasted code or address could not be used');
  assert.equal(said(new Error('something nobody planned for: token=abc')), "the full reason is in the server's output");
  assert.equal(said('a bare string'), "the full reason is in the server's output");
  // A message the thrower wrote for people and marked public passes through.
  assert.equal(said(Object.assign(new Error('internal'), { publicMessage: 'Signed in as "b", not "a"' })), 'Signed in as "b", not "a"');
});

test('signInEvent tells a cancel and a timeout apart from a failure', () => {
  const info = { provider: 'claude', account: 'work', via: 'dashboard' };
  assert.equal(signInEvent('started', info).type, 'signin_started');
  assert.equal(signInEvent('succeeded', info).type, 'signin_succeeded');
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(signInEvent('failed', { ...info, error: abort }).type, 'signin_cancelled');
  assert.equal(signInEvent('failed', { ...info, error: new Error('Login timed out after 5 minutes') }).type, 'signin_timeout');
  const failed = signInEvent('failed', { ...info, error: new Error('Token exchange failed (401): body') });
  assert.equal(failed.type, 'signin_failed');
  assert.equal(failed.message.includes('body'), false);
});

/** @param {Record<string, any>} extra */
function oauthAccount(extra = {}) {
  return { name: 'work', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, ...extra };
}

test('an OAuth account losing its credentials is one signed_out entry, not one per request', () => {
  const am = new AccountManager([oauthAccount()], 0.98);
  am.markCredentialRejected(0, 'upstream answered 401');
  am.markCredentialRejected(0, 'upstream answered 401');
  const signedOut = am.events.since(0).events.filter(e => e.type === 'signed_out');
  assert.equal(signedOut.length, 1);
  assert.equal(signedOut[0].kind, 'auth');
  assert.equal(signedOut[0].account, 'work');
  assert.equal(signedOut[0].provider, 'anthropic');
  assert.equal(signedOut[0].reason, 'credential_rejected');
});

test('an API key held out after a 401 is an auth entry', () => {
  const am = new AccountManager([{ name: 'key', type: 'apikey', apiKey: 'sk' }], 0.98);
  am.markCredentialRejected(0, 'upstream answered 401');
  const [entry] = am.events.since(0).events;
  assert.equal(entry.type, 'credential_rejected');
  assert.equal(entry.kind, 'auth');
});

test('a rate limit is a rotation entry', () => {
  const am = new AccountManager([oauthAccount()], 0.98);
  am.markRateLimited(0, 30);
  const [entry] = am.events.since(0).events;
  assert.equal(entry.kind, 'rotation');
  assert.equal(entry.type, 'rate_limited');
  assert.match(entry.message, /30s/);
});

test('a manager given an event log records into that one', () => {
  const events = new EventLog();
  const am = new AccountManager([oauthAccount()], 0.98, { events });
  assert.equal(am.events, events);
});

test('requestPrompt reads the last user text of a Messages or Responses body', () => {
  const body = (/** @type {any} */ b) => Buffer.from(JSON.stringify(b));
  assert.equal(requestPrompt(body({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }] })), 'second');
  // A tool result carries no prompt; a reminder block is not one either.
  assert.equal(requestPrompt(body({ messages: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'fix it' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'out' }] },
  ] })), 'fix it');
  // Codex Responses: a plain string, or input items with input_text blocks.
  assert.equal(requestPrompt(body({ input: 'hello codex' })), 'hello codex');
  assert.equal(requestPrompt(body({ input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a test' }] },
    { type: 'function_call_output', call_id: 'c', output: 'done' },
  ] })), 'add a test');
  assert.equal(requestPrompt(Buffer.from('not json')), null);
  assert.equal(requestPrompt(body({ messages: [{ role: 'user', content: [{ type: 'image' }] }] })), null);
});

test('an entry keeps a prompt as one bounded line, and the client as the User-Agent product', () => {
  const log = new EventLog({ now: () => NOW });
  const e = log.add({ kind: 'usage', type: 'request', message: 'POST /v1/messages', prompt: 'line one\nline two ' + 'x'.repeat(PROMPT_MAX), agent: clientAgent('codex_cli_rs/0.46.0 (Ubuntu 24.04; x86_64) xterm') });
  assert.ok(e);
  assert.equal(e.prompt?.length, PROMPT_MAX);
  assert.ok(e.prompt?.startsWith('line one line two'));
  assert.equal(e.agent, 'codex_cli_rs/0.46.0');
  assert.equal(clientAgent(undefined), null);
  assert.equal(clientAgent('  '), null);
});
