import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSignIns, WebSignInError } from '../src/web-login.js';

// The dashboard's sign-in tracker: one flow at a time, started by one request,
// fed a paste by another and read by a third. The flow itself is stubbed here;
// what is under test is how its steps reach the page.

/**
 * A sign-in stub the test drives by hand: it hands the tracker a prompt at
 * once, takes pastes through `parse`, and ends when the test settles it.
 */
function stubFlow({ parse = text => (text === 'good' ? true : text ? (() => { throw new Error('That code is from another sign-in. Open this link again'); })() : false), prompt = {} } = {}) {
  const runs = [];
  const signIn = (provider, { signal, onPrompt }) => {
    let settle;
    const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const run = { provider, signal, settle };
    runs.push(run);
    signal.addEventListener('abort', () => {
      const err = new Error('Login cancelled');
      err.name = 'AbortError';
      settle.reject(err);
    });
    onPrompt({
      provider, url: `https://${provider}.example/authorize`, browserUrl: 'http://localhost:4242/authorize',
      remote: false, listening: true, note: null, submit: parse, ...prompt,
    });
    return done;
  };
  return { signIn, runs };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a started sign-in hands back its links, and Claude alone carries the loopback one', async () => {
  const { signIn } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const claude = await signIns.start('claude');
  assert.match(claude.id, /^[0-9a-f]{32}$/);
  assert.equal(claude.url, 'https://claude.example/authorize');
  assert.equal(claude.browserUrl, 'http://localhost:4242/authorize');
  assert.equal(claude.listening, true);
  assert.deepEqual(signIns.status(claude.id), { state: 'waiting', provider: 'claude', account: null, action: null, error: null });

  const codex = await signIns.start('codex');
  assert.equal(codex.browserUrl, null, 'Codex has one link; its redirect is fixed to localhost:1455');
});

test('an accepted paste moves the sign-in on, and the outcome names the account', async () => {
  const { signIn, runs } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const { id } = await signIns.start('codex');
  assert.deepEqual(signIns.submit(id, 'good'), { accepted: true });
  assert.equal(signIns.status(id).state, 'finishing');

  runs[0].settle.resolve({ name: 'me@example.com', action: 'added' });
  await tick();
  assert.deepEqual(signIns.status(id), { state: 'succeeded', provider: 'codex', account: 'me@example.com', action: 'added', error: null });
  assert.throws(() => signIns.submit(id, 'good'), WebSignInError, 'a finished sign-in takes no more pastes');
});

test('a paste the flow cannot use is refused with its reason, and the sign-in keeps waiting', async () => {
  const { signIn } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const { id } = await signIns.start('claude');
  assert.throws(() => signIns.submit(id, 'stale'), err => err instanceof WebSignInError && /another sign-in/.test(err.message));
  assert.deepEqual(signIns.submit(id, ''), { accepted: false }, 'nothing pasted is not an error');
  assert.equal(signIns.status(id).state, 'waiting');
});

test('a failure reaches the page as a fixed phrase, not the provider\'s reply', async () => {
  const { signIn, runs } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const { id } = await signIns.start('claude');
  runs[0].settle.reject(new Error('Token exchange failed (400): {"error":"invalid_grant","secret":"sk-ant-oat01-abc"}'));
  await tick();
  const st = signIns.status(id);
  assert.equal(st.state, 'failed');
  assert.equal(st.error, 'the provider answered HTTP 400');
});

test('starting a second sign-in cancels the first, whose id is then unknown', async () => {
  const { signIn, runs } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const first = await signIns.start('codex');
  const second = await signIns.start('claude');
  assert.equal(runs[0].signal.aborted, true, 'the first flow\'s listener is closed');
  assert.equal(runs[1].signal.aborted, false);
  assert.deepEqual(signIns.status(first.id), { state: 'unknown' });
  assert.equal(signIns.status(second.id).state, 'waiting');
});

test('cancel ends a waiting sign-in, and is a no-op for anything else', async () => {
  const { signIn } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const { id } = await signIns.start('claude');
  assert.equal(signIns.cancel('not-this-one'), false);
  assert.equal(signIns.cancel(id), true);
  await tick();
  assert.equal(signIns.status(id).state, 'cancelled');
  assert.equal(signIns.status(id).error, null, 'a cancel is not a failure');
  assert.equal(signIns.cancel(id), false);
});

test('a code already accepted is past cancelling', async () => {
  const { signIn, runs } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  const { id } = await signIns.start('claude');
  signIns.submit(id, 'good');
  assert.equal(signIns.cancel(id), false);
  assert.equal(runs[0].signal.aborted, false, 'the exchange is left to finish');
});

test('a flow that fails before it asks for the browser fails the start itself', async () => {
  const signIns = new WebSignIns({ signIn: async () => { throw new Error('EMFILE'); } });
  await assert.rejects(signIns.start('claude'), /EMFILE/);
});

test('only Claude and Codex can be started', async () => {
  const { signIn, runs } = stubFlow();
  const signIns = new WebSignIns({ signIn });
  for (const provider of ['openai', '', undefined, '__proto__']) {
    await assert.rejects(signIns.start(/** @type {any} */ (provider)), WebSignInError);
  }
  assert.equal(runs.length, 0);
});

test('a listener note reaches the page on one line', async () => {
  const { signIn } = stubFlow({ prompt: { listening: false, note: 'Port 1455 is in use\n(a running `codex login` holds it)' } });
  const signIns = new WebSignIns({ signIn });
  const start = await signIns.start('codex');
  assert.equal(start.listening, false);
  assert.ok(!/\n/.test(start.note), start.note);
  assert.match(start.note, /^Port 1455 is in use/);
});
