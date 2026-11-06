import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closedPort, spawnServer, waitForStatus } from '../test-helpers/spawn-server.js';

// A master and a backup as two real proxies (sync-cluster.js): the backup
// picks up the master's account and keeps a copy of its store; when the
// master's process stops, the backup takes over and answers the store's API
// itself. The checks run every 100 ms here (SYNC_CLUSTER_CHECK_MS) so the
// three missed checks that make a member down take well under a second.

const env = { TEAMCLAUDE_SYNC_CLUSTER_CHECK_MS: '100' };

const call = (port, key, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json', 'x-api-key': key },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Read the card until `predicate` holds; the runner's timeout bounds it. */
async function waitForView(port, key, predicate) {
  for (;;) {
    const res = await call(port, key, '/teamclaude/account-sync').catch(() => null);
    const view = res && res.ok ? await res.json() : null;
    if (view && predicate(view)) return view;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('the backup copies the master\'s store, and takes over when the master stops', async () => {
  const deadPort = await closedPort();
  const base = { upstream: `http://127.0.0.1:${deadPort}`, upstreamProxy: false, autoUpdate: false };
  const shared = {
    name: 'shared@example.com', email: 'shared@example.com', type: 'oauth',
    accountUuid: 'uuid-shared', orgUuid: 'org-shared', orgName: 'Shared Org',
    accessToken: 'at-shared-1', refreshToken: 'rt-shared-1', expiresAt: Date.now() + 8 * 3600_000,
  };
  const cluster = { mode: 'cluster', members: ['alpha', 'beta'] };
  const alpha = await spawnServer({
    env,
    config: () => ({ ...base, instanceName: 'alpha', proxy: { apiKey: 'tc-alpha-key' }, accountSync: cluster, accounts: [shared] }),
  });
  let beta;
  try {
    beta = await spawnServer({
      env,
      config: () => ({
        ...base,
        instanceName: 'beta',
        proxy: { apiKey: 'tc-beta-key' },
        accountSync: cluster,
        peers: [{ name: 'alpha', url: `http://127.0.0.1:${alpha.port}`, apiKey: 'tc-alpha-key' }],
        accounts: [{ name: 'local@example.com', type: 'apikey', apiKey: 'sk-demo-1' }],
      }),
    });

    // alpha is first in line and up: the master. beta is its backup.
    const first = await waitForView(beta.port, 'tc-beta-key', (v) => v.instance?.cluster?.master === 'alpha' && v.instance.cluster.role === 'backup');
    assert.deepEqual(first.instance.members, ['alpha', 'beta']);
    // beta's sync goes to alpha's store, and brings the account in.
    assert.ok(await waitForStatus(beta.port, (s) => s.accounts?.some((/** @type {any} */ a) => a.name === 'shared@example.com')), beta.output());
    // A backup answers no store calls of its own.
    assert.equal((await call(beta.port, 'tc-beta-key', '/teamclaude/sync-store', { method: 'GET', path: 'User/Credential' })).status, 404);
    // And it keeps a copy of alpha's store, the row included.
    const copyPath = join(beta.dir, 'config.sync-store.json');
    for (;;) {
      const copy = await readFile(copyPath, 'utf8').then(JSON.parse, () => null);
      if (copy?.rows?.some((/** @type {any} */ r) => r.key === 'teamrouter.anthropic.uuid-shared.org-shared')) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    await alpha.stop();

    // alpha no longer answers: after three missed checks beta is the master.
    const after = await waitForView(beta.port, 'tc-beta-key', (v) => v.instance?.cluster?.role === 'master');
    assert.equal(after.instance.cluster.master, 'beta');
    assert.deepEqual(after.instance.cluster.memberStates.map((/** @type {any} */ m) => [m.name, m.state]), [['alpha', 'down'], ['beta', 'up']]);
    // It now answers the store's API, from the copy it kept.
    const res = await call(beta.port, 'tc-beta-key', '/teamclaude/sync-store', { method: 'GET', path: 'User/Credential', envelope: true });
    assert.equal(res.status, 200, beta.output());
    const rows = (await res.json()).result.data;
    assert.ok(rows.some((/** @type {any} */ r) => r.Key === 'teamrouter.anthropic.uuid-shared.org-shared'));
    assert.match(beta.output(), /Account store master: beta \(this machine\)/);
  } finally {
    await beta?.stop();
    await alpha.stop();
  }
});
