// The account event log behind the dashboard's Logs page: its bounds, what an
// entry may carry, and the account-manager decisions that record into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog, logsAfter, briefError, signInEvent, EVENT_LOG_PAGE } from '../src/event-log.js';
import { AccountManager } from '../src/account-manager.js';

const NOW = 1_000_000_000_000;

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

test('a token endpoint refusal is cut at its status; our own messages pass through', () => {
  assert.equal(briefError(new Error('Token exchange failed (400): {"error":"invalid_grant","detail":"x"}')), 'Token exchange failed (400)');
  assert.equal(briefError(new Error('That is not the whole code.')), 'That is not the whole code.');
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
