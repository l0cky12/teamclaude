import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigOpError, addPeer, peerAddress, removePeer, setInstanceAddress, setInstanceName } from '../src/config-ops.js';
import { configuredPeers } from '../src/peers.js';

// The rules behind the dashboard's Linked instances card: what an entry of
// `peers` may look like when it is written from the page rather than by hand.

test('peerAddress stores an http(s) address without a trailing slash, and takes a bare host:port as http', () => {
  assert.equal(peerAddress('http://100.64.0.2:3456/'), 'http://100.64.0.2:3456');
  assert.equal(peerAddress('  100.64.0.2:3456 '), 'http://100.64.0.2:3456');
  assert.equal(peerAddress('desktop.tail1234.ts.net:3456'), 'http://desktop.tail1234.ts.net:3456');
  assert.equal(peerAddress('https://proxy.example.com/tc/'), 'https://proxy.example.com/tc');
  assert.equal(peerAddress('HTTP://Host.Example:80'), 'http://host.example');
});

test('peerAddress refuses what the relay could not use or would show in the clear', () => {
  for (const [raw, why] of [
    ['', /enter the address/],
    [undefined, /enter the address/],
    ['ftp://host:21', /http:\/\/ or https:\/\//],
    ['http://user:secret@host:1', /key field/],
    ['http://host:1/?x=1', /\? or #/],
    ['http://host:1/#frag', /\? or #/],
    ['http://exa mple:1', /not an address/],
  ]) {
    assert.throws(() => peerAddress(raw), (err) => err instanceof ConfigOpError && why.test(err.message), String(raw));
  }
});

test('addPeer appends an entry the relay accepts as written', () => {
  const config = { peers: [{ name: 'old', url: 'http://h:1', apiKey: 'k0' }] };
  assert.deepEqual(addPeer(config, { name: ' desktop ', url: '100.64.0.2:3456', apiKey: ' tc-abc ' }), { name: 'desktop', url: 'http://100.64.0.2:3456' });
  assert.deepEqual(config.peers.at(-1), { name: 'desktop', url: 'http://100.64.0.2:3456', apiKey: 'tc-abc' });
  assert.deepEqual(configuredPeers(config).map(p => p.name), ['old', 'desktop']);
});

test('addPeer starts a list on a config without one', () => {
  const config = {};
  addPeer(config, { name: 'server', url: 'http://h:1', apiKey: 'k' });
  assert.equal(config.peers.length, 1);
});

test('addPeer refuses a taken name, a name the relay path cannot carry, and a missing or odd key', () => {
  const config = { peers: [{ name: 'server', url: 'not even a url', apiKey: '' }] };
  const before = JSON.stringify(config);
  for (const [spec, why] of [
    // Taken even by an entry the relay skips: the remove would take both.
    [{ name: 'server', url: 'http://h:1', apiKey: 'k' }, /already linked/],
    [{ name: '', url: 'http://h:1', apiKey: 'k' }, /name the linked instance/],
    [{ name: '..', url: 'http://h:1', apiKey: 'k' }, /letters, digits/],
    [{ name: 'my box', url: 'http://h:1', apiKey: 'k' }, /letters, digits/],
    [{ name: 'a/b', url: 'http://h:1', apiKey: 'k' }, /letters, digits/],
    [{ name: 'x'.repeat(65), url: 'http://h:1', apiKey: 'k' }, /letters, digits/],
    [{ name: 'ok', url: 'http://h:1', apiKey: '' }, /proxy key/],
    [{ name: 'ok', url: 'http://h:1', apiKey: 'tc a' }, /spaces or control/],
    [{ name: 'ok', url: 'http://h:1', apiKey: 'k'.repeat(513) }, /spaces or control/],
  ]) {
    assert.throws(() => addPeer(config, spec), (err) => err instanceof ConfigOpError && why.test(err.message), JSON.stringify(spec).slice(0, 80));
  }
  assert.equal(JSON.stringify(config), before, 'a refused add leaves the config as it was');
});

test('removePeer drops every entry under the name and refuses one that is not there', () => {
  const config = { peers: [{ name: 'a', url: 'http://h:1', apiKey: 'k' }, { name: 'b', url: 'http://h:2', apiKey: 'k' }, { name: ' a', url: 'bad', apiKey: 'k' }] };
  assert.deepEqual(removePeer(config, 'a'), { name: 'a', removed: 2 });
  assert.deepEqual(config.peers.map(p => p.name), ['b']);
  assert.throws(() => removePeer(config, 'a'), /no linked instance is named "a"/);
  assert.throws(() => removePeer(config, ''), /name the linked instance/);
  assert.throws(() => removePeer({}, 'a'), ConfigOpError);
});

test('setInstanceName stores a trimmed name, and an empty one drops the key', () => {
  const config = {};
  assert.equal(setInstanceName(config, '  hermes '), 'hermes');
  assert.equal(config.instanceName, 'hermes');
  assert.equal(setInstanceName(config, ''), '');
  assert.equal('instanceName' in config, false, 'cleared, so the host name is used again');
});

test('setInstanceName refuses a name a link could not store, and anything but text', () => {
  for (const bad of ['my laptop', '.hidden', '-x', 'a'.repeat(65), 'a/b']) {
    const config = { instanceName: 'kept' };
    assert.throws(() => setInstanceName(config, bad), ConfigOpError, bad);
    assert.equal(config.instanceName, 'kept');
  }
  for (const bad of [undefined, null, 5, {}]) {
    assert.throws(() => setInstanceName({}, bad), /must be text/);
  }
});

test('setInstanceAddress stores an address as a link stores one, and an empty one drops the key', () => {
  const config = {};
  assert.equal(setInstanceAddress(config, ' 100.64.0.9:3456/ '), 'http://100.64.0.9:3456');
  assert.equal(config.instanceAddress, 'http://100.64.0.9:3456');
  assert.equal(setInstanceAddress(config, '  '), '');
  assert.equal('instanceAddress' in config, false, 'cleared, so the guess is used again');
});

test('setInstanceAddress refuses what a link could not use, and anything but text', () => {
  for (const bad of ['ftp://host:21', 'http://user:pw@host:1', 'http://host:1/?x=1', 'http://exa mple:1']) {
    const config = { instanceAddress: 'http://kept:1' };
    assert.throws(() => setInstanceAddress(config, bad), ConfigOpError, bad);
    assert.equal(config.instanceAddress, 'http://kept:1');
  }
  for (const bad of [undefined, null, 5, {}]) {
    assert.throws(() => setInstanceAddress({}, bad), /must be text/);
  }
});
