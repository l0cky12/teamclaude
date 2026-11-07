import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRequest, connectRowView, connectOutcome, renderDashboardHtml } from '../src/dashboard.js';

// The Connect your tools card's pure logic. It is serialized into the page,
// so these are the functions the browser runs.

const where = '/home/me/.codex/config.toml';

test('a connect request names the clients and the action, and replace only when asked', () => {
  const r = connectRequest(['codex'], 'connect', false, 'k');
  assert.equal(r.url, '/teamclaude/clients/connect');
  assert.equal(r.init.method, 'POST');
  assert.deepEqual(JSON.parse(r.init.body), { clients: ['codex'], action: 'connect' });
  assert.deepEqual(JSON.parse(connectRequest(['codex'], 'connect', true, null).init.body), { clients: ['codex'], action: 'connect', replace: true });
});

test('each state gets its pill and the button that changes it', () => {
  const connected = connectRowView({ id: 'codex', label: 'Codex CLI', where, state: 'connected' }, false);
  assert.deepEqual([connected.pill.text, connected.button.label, connected.button.action], ['Connected', 'Disconnect', 'disconnect']);
  assert.deepEqual(connected.lines, [where]);

  const off = connectRowView({ id: 'codex', label: 'Codex CLI', where, state: 'disconnected' }, false);
  assert.deepEqual([off.pill.text, off.button.label, off.button.replace], ['Not connected', 'Connect', false]);

  const broken = connectRowView({ id: 'claude', label: 'Claude Code', where: 'x', state: 'unreadable', problem: 'the file is not valid JSON' }, false);
  assert.equal(broken.button, null, 'nothing a click can fix');
  assert.ok(broken.lines.includes('the file is not valid JSON'));
});

test('a client pointing elsewhere says where, and replaces only on the second click', () => {
  const c = { id: 'claude', label: 'Claude Code', where, state: 'elsewhere', current: 'http://10.0.0.2:3456' };
  const first = connectRowView(c, false);
  assert.equal(first.pill.text, 'Uses another setting');
  assert.ok(first.lines.includes('Now set to http://10.0.0.2:3456'));
  assert.deepEqual([first.button.label, first.button.replace], ['Connect', false]);
  const armed = connectRowView(c, true);
  assert.deepEqual([armed.button.label, armed.button.replace], ['Replace', true]);
});

test('Grok Build carries its new-terminal note into the row and the outcome', () => {
  const grok = { id: 'grok', label: 'Grok Build', where: '/home/me/.bashrc', state: 'connected', note: 'Open a new terminal.' };
  assert.ok(connectRowView(grok, false).lines.includes('Open a new terminal.'));
  const out = connectOutcome({ ok: true, clients: [grok], errors: [] }, 'connect');
  assert.equal(out.kind, 'ok');
  assert.match(out.text, /Open a new terminal\./);
});

test('the outcome reports the clients left as they were, and a refusal', () => {
  const partial = connectOutcome({ ok: false, clients: [], errors: [{ id: 'codex', error: 'Codex CLI: set to model_provider "openai"' }] }, 'connect');
  assert.deepEqual(partial, { kind: 'warn', text: 'Codex CLI: set to model_provider "openai"' });
  assert.equal(connectOutcome({ ok: false, error: 'only a caller on the machine' }, 'connect').kind, 'error');
});

test('a setting connect would replace is explained in the page\'s own terms, not the CLI flag', () => {
  const out = connectOutcome({ ok: false, clients: [], errors: [{ id: 'codex', error: 'Codex CLI: already set to model_provider "openai", left as it is.', replaceable: true }] }, 'connect');
  assert.equal(out.kind, 'warn');
  assert.match(out.text, /press Connect on its row, then Replace/);
  assert.doesNotMatch(out.text, /--replace/);
});

test('the page carries the card, closed until the server answers', () => {
  const html = renderDashboardHtml();
  assert.match(html, /<div id="connectCard" class="card ckeys connect" style="display:none">/);
  assert.match(html, /function connectRowView/);
});
