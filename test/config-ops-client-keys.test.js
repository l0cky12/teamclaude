import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigOpError, addClientKey, clientKeyNames, generateClientKey, revokeClientKey } from '../src/config-ops.js';

// The add and revoke steps behind the dashboard's Client keys card, as changes
// to a config object. The endpoint wraps them in the config lock and a reload
// (server-client-keys.test.js); here it is only what they write and refuse.

const refused = (fn, pattern) => assert.throws(fn, err => err instanceof ConfigOpError && pattern.test(err.message));

test('a generated key has the proxy key shape and is not repeated', () => {
  const a = generateClientKey();
  const b = generateClientKey();
  assert.match(a, /^tc-[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, b);
});

test('adding a key appends a { name, key } entry and answers with both', () => {
  const config = { proxy: { apiKey: 'tc-shared', clientKeys: [{ name: 'laptop', key: 'tc-1' }] } };
  const out = addClientKey(config, '  ci-agent ', 'tc-2');
  assert.deepEqual(out, { name: 'ci-agent', key: 'tc-2', firstKey: false });
  assert.deepEqual(config.proxy.clientKeys, [{ name: 'laptop', key: 'tc-1' }, { name: 'ci-agent', key: 'tc-2' }]);
});

test('a key is generated when none is given', () => {
  const config = { proxy: { apiKey: 'tc-shared' } };
  const out = addClientKey(config, 'laptop');
  assert.match(out.key, /^tc-/);
  assert.deepEqual(config.proxy.clientKeys, [{ name: 'laptop', key: out.key }]);
});

test('the first key of a proxy with no key at all says so', () => {
  const config = {};
  assert.equal(addClientKey(config, 'laptop', 'tc-1').firstKey, true);
  assert.deepEqual(config.proxy, { clientKeys: [{ name: 'laptop', key: 'tc-1' }] });
  assert.equal(addClientKey(config, 'desktop', 'tc-2').firstKey, false);
  // An entry the auth gate ignores (no key) does not close the gate either.
  assert.equal(addClientKey({ proxy: { clientKeys: [{ name: 'half' }] } }, 'laptop', 'tc-1').firstKey, true);
});

test('a name already in use is refused, and nothing is added', () => {
  const config = { proxy: { clientKeys: [{ name: 'laptop', key: 'tc-1' }] } };
  refused(() => addClientKey(config, ' laptop', 'tc-2'), /already exists/);
  assert.equal(config.proxy.clientKeys.length, 1);
});

test('names are kept to characters that read the same in every view', () => {
  const config = { proxy: {} };
  refused(() => addClientKey(config, '', 'k'), /name the client key/);
  refused(() => addClientKey(config, '   ', 'k'), /name the client key/);
  refused(() => addClientKey(config, 42, 'k'), /name the client key/);
  refused(() => addClientKey(config, 'line\nbreak', 'k'), /up to 64/);
  refused(() => addClientKey(config, '(other)', 'k'), /up to 64/);
  refused(() => addClientKey(config, '-dash-first', 'k'), /up to 64/);
  refused(() => addClientKey(config, 'x'.repeat(65), 'k'), /up to 64/);
  assert.equal(config.proxy.clientKeys, undefined, 'a refusal writes nothing');
  for (const ok of ['laptop', 'CI agent 2', 'me@desktop', 'build_box.local', 'x'.repeat(64)]) {
    assert.equal(addClientKey(config, ok, 'k-' + ok).name, ok);
  }
});

test('revoking drops every entry under the name and keeps the rest', () => {
  const config = { proxy: { clientKeys: [
    { name: 'laptop', key: 'tc-1' }, { name: 'ci', key: 'tc-2' }, { name: 'laptop ', key: 'tc-3' },
  ] } };
  assert.deepEqual(revokeClientKey(config, 'laptop'), { name: 'laptop', removed: 2 });
  assert.deepEqual(config.proxy.clientKeys, [{ name: 'ci', key: 'tc-2' }]);
});

test('revoking a name that is not there is refused', () => {
  const config = { proxy: { clientKeys: [{ name: 'ci', key: 'tc-2' }] } };
  refused(() => revokeClientKey(config, 'laptop'), /no client key is named "laptop"/);
  refused(() => revokeClientKey(config, ''), /name the client key/);
  refused(() => revokeClientKey({}, 'laptop'), /no client key/);
  assert.equal(config.proxy.clientKeys.length, 1);
});

test('the listed names are the usable entries, once each, and never a key', () => {
  const proxy = { clientKeys: [
    { name: 'laptop', key: 'tc-1' }, { name: ' laptop', key: 'tc-9' }, { name: 'nokey' }, { key: 'tc-noname' }, null, { name: 'ci', key: 'tc-2' },
  ] };
  assert.deepEqual(clientKeyNames(proxy), ['laptop', 'ci']);
  assert.deepEqual(clientKeyNames(undefined), []);
  assert.deepEqual(clientKeyNames({ clientKeys: 'nope' }), []);
});

test('the last key of a proxy without a shared key cannot be revoked', () => {
  // With no key left the gate admits everybody: the revoke would open the
  // proxy rather than shut one client out.
  const config = { proxy: { clientKeys: [{ name: 'laptop', key: 'tc-1' }, { name: 'laptop', key: 'tc-2' }] } };
  refused(() => revokeClientKey(config, 'laptop'), /last key.*proxy\.apiKey/);
  assert.equal(config.proxy.clientKeys.length, 2, 'nothing is removed');

  // An entry the gate ignores (no key) does not count as a remaining key.
  const halves = { proxy: { clientKeys: [{ name: 'laptop', key: 'tc-1' }, { name: 'half' }] } };
  refused(() => revokeClientKey(halves, 'laptop'), /last key/);

  // Another usable key, or the shared key, keeps the gate closed.
  const two = { proxy: { clientKeys: [{ name: 'laptop', key: 'tc-1' }, { name: 'ci', key: 'tc-2' }] } };
  assert.equal(revokeClientKey(two, 'laptop').removed, 1);
  refused(() => revokeClientKey(two, 'ci'), /last key/);
  const shared = { proxy: { apiKey: 'tc-shared', clientKeys: [{ name: 'laptop', key: 'tc-1' }] } };
  assert.equal(revokeClientKey(shared, 'laptop').removed, 1);
  assert.deepEqual(shared.proxy.clientKeys, []);
});
