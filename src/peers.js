// Linked instances: one proxy showing and controlling another of yours — the
// one on your desktop and the one on a server, say — so whichever is up can
// show the rest. Each lists the others under `peers` in its config, with their
// address and proxy key, and relays /teamclaude/peers/<name>/<route> to them.
//
// The relay, not the browser, talks to the peer: the page keeps holding only
// the key of the machine it was opened on, its CSP stays same-origin, and no
// proxy has to answer cross-origin requests. Only the control plane is
// relayed — a route outside /teamclaude/ never reaches a peer through here, so
// a peer's fleet credential is never spent on a relayed request.

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

// A control route can take a while: a probe or a sign-in step calls upstream.
const RELAY_TIMEOUT_MS = 30_000;
// The reachability check is one small read; a peer slower than this is down
// as far as the picker is concerned.
const CHECK_TIMEOUT_MS = 3_000;
// How long a reachability answer is reused before the next status read asks again.
const CHECK_TTL_MS = 15_000;
// A status reply with session detail is the biggest thing relayed; this is
// generous for it and still bounds what a misbehaving peer can make us buffer.
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

// The routes a peer serves to the relay: lowercase words joined by `/`, with
// an optional query. No dots or escapes, so nothing can climb out of
// /teamclaude/ on the peer's side.
const REST_RE = /^([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)(\?[^#]*)?$/;
// Not relayed: the page itself, the MCP endpoint (its own client and session),
// and another relay hop — a peer's peers are not ours to reach.
const NOT_RELAYED = new Set(['dashboard', 'mcp', 'peers']);

/**
 * @typedef {{ name: string, url: string, apiKey: string }} Peer
 * @typedef {'online' | 'offline' | 'refused' | 'checking'} PeerState
 */

/**
 * The usable entries of `config.peers`. An entry without a name, an http(s)
 * url or a key is skipped, as is a second entry with a name already taken.
 * @param {Record<string, any>} config
 * @returns {Peer[]}
 */
export function configuredPeers(config) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(config?.peers) ? config.peers : []) {
    if (!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.apiKey !== 'string' || !p.apiKey) continue;
    const name = p.name.trim();
    // `.` and `..` would be dot segments in the relay path: a browser folds
    // /teamclaude/peers/../reload into a LOCAL /teamclaude/reload.
    if (seen.has(name) || name === '.' || name === '..' || !/^https?:\/\/[^/]/i.test(String(p.url))) continue;
    let u;
    try { u = new URL(p.url); } catch { continue; }
    // A query or fragment would swallow the control path appended after it.
    if (u.search || u.hash) continue;
    u.search = ''; u.hash = '';
    seen.add(name);
    out.push({ name, url: u.href.replace(/\/+$/, ''), apiKey: p.apiKey });
  }
  return out;
}

/**
 * Split a relay URL into the peer's name and the route to ask it for, or null
 * when the URL is not one. `rest` is null for a route the relay refuses.
 * @param {string} url  req.url, already under /teamclaude/
 * @returns {{ name: string, rest: string | null } | null}
 */
export function parsePeerUrl(url) {
  const m = /^\/teamclaude\/peers\/([^/?#]+)(?:\/(.*))?$/.exec(url || '');
  if (!m) return null;
  let name;
  try { name = decodeURIComponent(m[1]); } catch { return null; }
  const rest = m[2] ?? '';
  const ok = REST_RE.exec(rest);
  return { name, rest: ok && !NOT_RELAYED.has(ok[1].split('/')[0]) ? rest : null };
}

/**
 * The peer's address as the page may show it: no userinfo, no trailing slash.
 * @param {string} url
 */
function shownUrl(url) {
  const u = new URL(url);
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * One request to a peer's control plane, fully buffered.
 * @param {Peer} peer
 * @param {string} rest  route under /teamclaude/, with any query
 * @param {{ method?: string, body?: Buffer | null, contentType?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, body: Buffer }>}
 */
export function peerRequest(peer, rest, { method = 'GET', body = null, contentType, timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  // Built from parsed fields, so the control path lands in the path and the
  // route's query in the query, whatever the configured address looks like.
  const target = new URL(peer.url);
  const q = rest.indexOf('?');
  target.pathname = target.pathname.replace(/\/+$/, '') + '/teamclaude/' + (q < 0 ? rest : rest.slice(0, q));
  target.search = q < 0 ? '' : rest.slice(q);
  const lib = target.protocol === 'https:' ? https : http;
  /** @type {Record<string, string | number>} */
  const headers = { 'x-api-key': peer.apiKey };
  if (body) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = body.length; }
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method, headers, timeout: timeoutMs }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY_BYTES) { req.destroy(new Error('reply too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 502, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

/**
 * Answer a /teamclaude/peers/<name>/<route> request by asking that peer.
 *
 * A peer's own 401 or 403 is answered as 502: the page reads 401/403 as "the
 * key you hold is wrong" and throws it away, but here the key at fault is the
 * one in `peers[]`, on this machine.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, any>} config
 * @param {{ name: string, rest: string | null }} route
 */
export async function relayToPeer(req, res, config, route) {
  const reply = (/** @type {number} */ status, /** @type {Record<string, any>} */ json) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(json));
  };
  const peer = configuredPeers(config).find(p => p.name === route.name);
  if (!peer) return reply(404, { ok: false, error: `no linked instance named ${route.name}` });
  if (route.rest == null) return reply(404, { ok: false, error: 'that route is not relayed to a linked instance' });

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return reply(413, { ok: false, error: 'body too large' });
    chunks.push(chunk);
  }
  let out;
  try {
    out = await peerRequest(peer, route.rest, {
      method: req.method,
      body: size ? Buffer.concat(chunks) : null,
      contentType: req.headers['content-type'],
    });
  } catch (err) {
    return reply(502, { ok: false, unreachable: true, error: `${peer.name} is unreachable (${/** @type {Error} */ (err).message})` });
  }
  if (out.status === 401 || out.status === 403) {
    let why = '';
    try {
      const j = JSON.parse(out.body.toString('utf8'));
      why = typeof j.error === 'string' ? j.error : (j.error?.message || '');
    } catch { /* not JSON: the status says enough */ }
    return reply(502, { ok: false, error: `${peer.name} refused the request (${out.status}${why ? ': ' + why : ''}); check its key in peers` });
  }
  // Whatever the peer says its reply is, it reaches the browser as inert
  // JSON: the control plane answers nothing else, and a peer's HTML served
  // from this origin would run beside the key the dashboard keeps here.
  res.writeHead(out.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(out.body);
}

/**
 * Reachability of each configured peer, for the dashboard's instance picker.
 * Answers at once from what it last saw and refreshes a stale answer in the
 * background, so a peer that is down never slows the status read that asks.
 * Nothing runs unless something asks, and nothing is asked with no peers.
 * @param {{ check?: (peer: Peer) => Promise<PeerState>, ttlMs?: number, now?: () => number }} [opts]
 */
export function createPeerDirectory({ check = checkPeer, ttlMs = CHECK_TTL_MS, now = Date.now } = {}) {
  /** @type {Map<string, { key: string, state: PeerState, at: number, inFlight: boolean }>} */
  const seen = new Map();
  return {
    /**
     * @param {Record<string, any>} config
     * @returns {{ name: string, url: string, state: PeerState }[]}
     */
    list(config) {
      const peers = configuredPeers(config);
      for (const name of seen.keys()) if (!peers.some(p => p.name === name)) seen.delete(name);
      return peers.map((peer) => {
        const key = peer.url + '\n' + peer.apiKey;
        let entry = seen.get(peer.name);
        // A changed address or key is a different peer: what was seen no longer says anything.
        if (!entry || entry.key !== key) { entry = { key, state: 'checking', at: -Infinity, inFlight: false }; seen.set(peer.name, entry); }
        if (!entry.inFlight && now() - entry.at >= ttlMs) {
          const e = entry;
          e.inFlight = true;
          check(peer).catch(() => /** @type {PeerState} */ ('offline')).then((state) => {
            e.state = state; e.at = now(); e.inFlight = false;
          });
        }
        return { name: peer.name, url: shownUrl(peer.url), state: entry.state };
      });
    },
  };
}

/**
 * Ask a peer for its quota summary: the smallest gated read it has.
 * @param {Peer} peer
 * @returns {Promise<PeerState>}
 */
export async function checkPeer(peer) {
  try {
    const { status } = await peerRequest(peer, 'quota', { timeoutMs: CHECK_TIMEOUT_MS });
    if (status === 401 || status === 403) return 'refused';
    return status === 200 ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}

// Interfaces whose addresses another machine never uses to reach this one:
// container and VM bridges, which every Docker host has.
const BRIDGE_IFACE = /^(docker|br-|veth|virbr|cni|flannel|podman)/;

/**
 * Whether a bind address keeps the proxy on this machine only.
 * @param {string | null | undefined} bindHost
 */
export function bindsLoopbackOnly(bindHost) {
  const h = String(bindHost || '127.0.0.1').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

/**
 * Addresses another machine of yours might reach this proxy at, best guess
 * first, for the dashboard's "link back" field: Tailscale, then the LAN, then
 * anything else. A proxy that binds one address has only that one; one bound
 * to loopback has none, since nothing off this machine can reach it.
 *
 * @param {string | null | undefined} bindHost
 * @param {number} port
 * @param {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} [interfaces]
 * @returns {string[]}
 */
export function selfAddresses(bindHost, port, interfaces = os.networkInterfaces()) {
  if (bindsLoopbackOnly(bindHost)) return [];
  const bound = String(bindHost).replace(/^\[|\]$/g, '');
  const at = (/** @type {string} */ ip) => `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`;
  if (bound !== '0.0.0.0' && bound !== '::' && bound !== '') return [at(bound)];
  /** @type {{ ip: string, rank: number }[]} */
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (BRIDGE_IFACE.test(name)) continue;
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || found.some(f => f.ip === a.address)) continue;
      const [x, y] = a.address.split('.').map(Number);
      // 100.64.0.0/10 is Tailscale's range; the private ranges are a LAN.
      const rank = x === 100 && y >= 64 && y < 128 ? 0
        : x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168) ? 1 : 2;
      found.push({ ip: a.address, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map(f => at(f.ip));
}

/**
 * What the dashboard needs to offer this machine to another: a name to list
 * it under there, the addresses it may be reached at, and whether it can be
 * linked at all (it listens off this machine and has a proxy key to hand out).
 *
 * @param {Record<string, any>} config
 * @param {string | null | undefined} bindHost
 * @param {number} port  the port the asking request came in on
 */
export function selfLinkInfo(config, bindHost, port) {
  const name = os.hostname().split('.')[0].replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return {
    name: name || 'teamclaude',
    addresses: selfAddresses(bindHost, port),
    offBox: !bindsLoopbackOnly(bindHost),
    hasKey: !!config.proxy?.apiKey,
  };
}

/**
 * Try an address and key before they are saved: the same check the picker
 * makes, then whether that instance can be linked back from here (a version
 * with /teamclaude/peer-links) and the name it suggests for itself.
 *
 * The quota read the picker makes is open to a client key too, so it cannot
 * tell one from the proxy key. The second read can: a current version
 * refuses a client key there, which makes the key `refused` with `clientKey`
 * set, since that key would be turned away from every change made through
 * the link. Only a 404 says the version is older.
 *
 * @param {Peer} peer
 * @returns {Promise<{ state: PeerState, linkable: boolean, name?: string, clientKey?: boolean }>}
 */
export async function testPeerLink(peer) {
  const state = await checkPeer(peer);
  if (state !== 'online') return { state, linkable: false };
  try {
    const { status, body } = await peerRequest(peer, 'peer-links', { timeoutMs: CHECK_TIMEOUT_MS });
    if (status === 403) return { state: 'refused', linkable: false, clientKey: true };
    if (status === 401) return { state: 'refused', linkable: false };
    if (status !== 200) return { state, linkable: false };
    const self = JSON.parse(body.toString('utf8'))?.self;
    const name = typeof self?.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(self.name) ? self.name : undefined;
    return { state, linkable: true, ...(name ? { name } : {}) };
  } catch {
    return { state, linkable: false };
  }
}

/**
 * Ask a peer to list this machine in its own `peers`, so its dashboard shows
 * this one too. `entry` carries this machine's own proxy key: the peer needs
 * it to reach us, exactly as we hold the peer's.
 *
 * @param {Peer} peer
 * @param {{ name: string, url: string, apiKey: string }} entry
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function askPeerToLinkBack(peer, entry) {
  let out;
  try {
    out = await peerRequest(peer, 'peer-links/add', { method: 'POST', body: Buffer.from(JSON.stringify(entry)) });
  } catch (err) {
    return { ok: false, error: `${peer.name} is unreachable (${/** @type {Error} */ (err).message})` };
  }
  if (out.status === 200) return { ok: true };
  if (out.status === 401 || out.status === 403) return { ok: false, error: `${peer.name} refused the key` };
  if (out.status === 404) return { ok: false, error: `${peer.name} runs a version that cannot be linked from another dashboard; update it, or link this machine from its own dashboard` };
  let why = '';
  try { why = String(JSON.parse(out.body.toString('utf8')).error || ''); } catch { /* not JSON */ }
  why = why.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  return { ok: false, error: `${peer.name} did not add this machine (${why || 'status ' + out.status})` };
}

// A mesh join visits every instance either side lists; past this many it
// stops, so a misbehaving peer's list cannot make one link run for minutes.
const MESH_MAX_INSTANCES = 32;
// The whole join, so a link made through the relay still gets its answer:
// at most this long, and over by RELAY_TIMEOUT_MS less a margin, counted from
// when the add began (the link back before it can be slow too). What is not
// done by then is reported as not done.
const MESH_BUDGET_MS = 15_000;
const MESH_REPLY_MARGIN_MS = 5_000;
// One read or add during a join. A remote test runs two checks of its own,
// each up to CHECK_TIMEOUT_MS, so it gets longer.
const MESH_STEP_TIMEOUT_MS = 5_000;
const MESH_TEST_TIMEOUT_MS = 2 * CHECK_TIMEOUT_MS + 2_000;
const TIMED_OUT = Symbol('timed out');

/**
 * The linked instances a peer lists, keys included, from its
 * /teamclaude/peer-links/peers. Null when it cannot be read: unreachable,
 * refused, or a version without the route.
 *
 * @param {Peer} peer
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Peer[] | null>}
 */
export async function readPeerList(peer, { timeoutMs = MESH_STEP_TIMEOUT_MS } = {}) {
  try {
    const { status, body } = await peerRequest(peer, 'peer-links/peers', { method: 'POST', body: Buffer.from('{}'), timeoutMs });
    if (status !== 200) return null;
    return configuredPeers({ peers: JSON.parse(body.toString('utf8'))?.peers });
  } catch {
    return null;
  }
}

/**
 * A name for `want` that the add routes accept (config-ops.js PEER_NAME) and
 * that `list` does not use for another instance yet: the name itself, else
 * with -2, -3 and so on. configuredPeers lets through names an add refuses,
 * such as one with a space.
 *
 * @param {Peer[]} list
 * @param {string} want
 */
function freeName(list, want) {
  const base = want.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'instance';
  if (!list.some(p => p.name === base)) return base;
  for (let n = 2; ; n++) if (!list.some(p => p.name === `${base}-${n}`)) return `${base}-${n}`;
}

/**
 * @typedef {{ from: string, to: string }} MeshLink
 * @typedef {{ from: string, to: string, error: string }} MeshSkip
 */

/**
 * Join two groups of linked instances into one, after this machine and
 * `joined` have just been linked both ways: this machine, `joined`, and
 * every instance either of them lists are linked both ways with each other.
 * Linking desk to hub, when hub already lists a server, so also links desk
 * and the server; and a link missing inside either group is made as well,
 * since a group is meant to be everyone linked with everyone.
 *
 * Instances are told apart by their proxy key, since a name and an address
 * are only what one machine calls another. Two installs may share a key,
 * though: a key listed at two different addresses could be one machine or
 * two, so every instance with that key is left out and reported.
 *
 * A pair is linked one direction at a time, each by the machine that will
 * hold the entry: it tests the address and key first (its own
 * peer-links/test), so an address that only the listing machine can reach is
 * reported instead of saved. The adds sent to other machines carry no
 * linkBack, so they never start a join of their own. Each machine's adds run
 * in turn, different machines' at once, and the whole join stops at
 * MESH_BUDGET_MS.
 *
 * Nothing is undone when a step fails: each link made works on its own, and
 * the ones that were not are listed with why.
 *
 * @param {object} opts
 * @param {Peer} opts.self  this machine, as `joined` lists it, with its own proxy key
 * @param {Peer[]} opts.ownPeers  what this machine lists, `joined` included
 * @param {Peer} opts.joined  the instance just linked
 * @param {(entries: Peer[]) => Promise<(string | null)[]>} opts.addLocal  save entries to this
 *   machine's `peers`; per entry, null when saved or why not
 * @param {typeof readPeerList} [opts.readList]
 * @param {(peer: Peer) => Promise<{ state: PeerState }>} [opts.test]
 * @param {typeof peerRequest} [opts.request]
 * @param {number} [opts.startedAt]  when the add that led here began (Date.now()); now by default
 * @param {Promise<unknown>} [opts.expiry]  settles when the join is out of time; the
 *   budget above by default
 * @returns {Promise<{ linked: MeshLink[], skipped: MeshSkip[] }>}
 */
export async function joinPeerMesh({ self, ownPeers, joined, addLocal, readList = readPeerList, test = testPeerLink, request = peerRequest, startedAt = Date.now(), expiry }) {
  const budgetMs = Math.min(MESH_BUDGET_MS, RELAY_TIMEOUT_MS - MESH_REPLY_MARGIN_MS - (Date.now() - startedAt));
  if (!expiry && budgetMs <= 0) {
    return { linked: [], skipped: [{ from: self.name, to: '*', error: `linking ${joined.name} took all the time this request has, so no other instance was linked; link those from their own dashboards` }] };
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
  let timedOut = false;
  /** @type {Promise<typeof TIMED_OUT>} */
  const expired = (expiry || new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); timer.unref?.(); }))
    .then(() => { timedOut = true; return TIMED_OUT; });
  /** @type {<T>(p: Promise<T>) => Promise<T | typeof TIMED_OUT>} */
  const bounded = (p) => Promise.race([p, expired]);
  try {
    return await join();
  } finally {
    clearTimeout(timer);
  }

  async function join() {
    /** @type {MeshSkip[]} */ const skipped = [];
    const done = (/** @type {MeshLink[]} */ linked = []) => ({ linked, skipped });

    const joinedList = await bounded(readList(joined, { timeoutMs: MESH_STEP_TIMEOUT_MS }));
    if (!joinedList || joinedList === TIMED_OUT) {
      skipped.push({ from: joined.name, to: '*', error: `could not read the instances ${joined.name} lists; it may run an older version` });
      return done();
    }

    // Every instance either side names, one per key, under the name this
    // machine gives it where it lists it. A key seen at two addresses is
    // ambiguous and left out.
    /** @type {Map<string, Peer>} */ const nodes = new Map();
    /** @type {Map<string, Set<string>>} */ const seenAt = new Map();
    /** @type {Map<string, Set<string>>} */ const seenAs = new Map();
    for (const p of [self, ...ownPeers, joined, ...joinedList]) {
      if (!nodes.has(p.apiKey)) { nodes.set(p.apiKey, p); seenAt.set(p.apiKey, new Set()); seenAs.set(p.apiKey, new Set()); }
      seenAt.get(p.apiKey)?.add(p.url);
      seenAs.get(p.apiKey)?.add(p.name);
    }
    /** @type {Set<string>} */ const ambiguous = new Set();
    for (const [key, urls] of seenAt) {
      if (urls.size < 2) continue;
      ambiguous.add(key);
      const names = [...(seenAs.get(key) || [])].join(' / ');
      skipped.push({ from: names, to: '*', error: `${names} is listed at ${[...urls].join(' and ')} with one proxy key, so it cannot be told whether that is one instance or several; give each its own proxy.apiKey, or link these by hand` });
    }
    if (ambiguous.has(self.apiKey) || ambiguous.has(joined.apiKey)) return done();
    for (const key of ambiguous) nodes.delete(key);

    if (nodes.size > MESH_MAX_INSTANCES) {
      skipped.push({ from: self.name, to: '*', error: `more than ${MESH_MAX_INSTANCES} instances between the two; link the rest by hand` });
      return done();
    }

    // What each instance lists now, read all at once. One that cannot be read
    // cannot be asked to add anything either; it is reported once, and the
    // others still try to list it.
    /** @type {Map<string, Peer[] | null>} */ const lists = new Map([[self.apiKey, [...ownPeers]], [joined.apiKey, [...joinedList]]]);
    const toRead = [...nodes.keys()].filter(k => !lists.has(k));
    const read = await Promise.all(toRead.map(k => bounded(readList(/** @type {Peer} */ (nodes.get(k)), { timeoutMs: MESH_STEP_TIMEOUT_MS }))));
    toRead.forEach((k, i) => {
      const r = read[i];
      lists.set(k, r === TIMED_OUT ? null : r);
      if (!r || r === TIMED_OUT) {
        const p = /** @type {Peer} */ (nodes.get(k));
        skipped.push({ from: p.name, to: '*', error: `could not reach ${p.name} to read what it lists, so it was not asked to list the others; link it from its own dashboard` });
      }
    });

    // Each missing direction once, in a fixed order, so the report reads the
    // same whatever finishes first.
    /** @type {{ from: Peer, to: Peer }[]} */ const pairs = [];
    for (const [u, from] of nodes) {
      const list = lists.get(u);
      if (!list) continue;
      for (const [v, to] of nodes) if (u !== v && !list.some(p => p.apiKey === v)) pairs.push({ from, to });
    }

    /** @type {(MeshLink | MeshSkip | null)[]} */ const results = pairs.map(() => null);
    /** @type {{ index: number, entry: Peer }[]} */ const localAdds = [];
    const byFrom = new Map();
    pairs.forEach((pair, index) => {
      if (!byFrom.has(pair.from.apiKey)) byFrom.set(pair.from.apiKey, []);
      byFrom.get(pair.from.apiKey).push(index);
    });
    await Promise.all([...byFrom.values()].map(async (/** @type {number[]} */ indexes) => {
      for (const index of indexes) {
        const { from, to } = pairs[index];
        const skip = (/** @type {string} */ error) => { results[index] = { from: from.name, to: to.name, error }; };
        const list = /** @type {Peer[]} */ (lists.get(from.apiKey));
        if (timedOut) { skip('ran out of time before getting to it'); continue; }
        const entry = { name: freeName(list, to.name), url: to.url, apiKey: to.apiKey };
        if (from === self) {
          const out = await bounded(test(to).catch(() => ({ state: /** @type {PeerState} */ ('offline') })));
          if (out === TIMED_OUT) { skip(`ran out of time testing ${to.name}`); continue; }
          if (out.state !== 'online') { skip(`${to.name} is ${out.state} from ${from.name}`); continue; }
          localAdds.push({ index, entry });
        } else {
          const err = await bounded(remoteAdd(request, from, entry));
          if (err === TIMED_OUT) { skip(`ran out of time waiting for ${from.name}; it may have linked ${to.name} anyway`); continue; }
          if (err) { skip(err); continue; }
          results[index] = { from: from.name, to: entry.name };
        }
        list.push(entry);
      }
    }));

    // Saved last and in one go: one write under the config lock, one reload.
    // A link counts only once it is saved.
    if (localAdds.length) {
      const saved = await addLocal(localAdds.map(a => a.entry)).catch(() => localAdds.map(() => 'could not save it; see the proxy log'));
      localAdds.forEach(({ index, entry }, i) => {
        const why = saved[i];
        results[index] = why ? { from: self.name, to: pairs[index].to.name, error: why } : { from: self.name, to: entry.name };
      });
    }

    /** @type {MeshLink[]} */ const linked = [];
    for (const r of results) {
      if (r && 'error' in r) skipped.push(r);
      else if (r) linked.push(r);
    }
    return done(linked);
  }
}

/**
 * Ask `from` to test `entry` and, when it answers, to list it. The error to
 * report, or null when it was added.
 *
 * @param {typeof peerRequest} request
 * @param {Peer} from
 * @param {Peer} entry
 * @returns {Promise<string | null>}
 */
async function remoteAdd(request, from, entry) {
  /** @param {Buffer} body */
  const why = (body) => {
    try { return String(JSON.parse(body.toString('utf8')).error || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200); } catch { return ''; }
  };
  try {
    const tested = await request(from, 'peer-links/test', { method: 'POST', body: Buffer.from(JSON.stringify({ url: entry.url, apiKey: entry.apiKey })), timeoutMs: MESH_TEST_TIMEOUT_MS });
    if (tested.status !== 200) return `${from.name} could not test the link (${why(tested.body) || 'status ' + tested.status})`;
    const state = JSON.parse(tested.body.toString('utf8'))?.state;
    if (state !== 'online') return `${entry.name} is ${typeof state === 'string' ? state.slice(0, 20) : 'unknown'} from ${from.name}`;
    const added = await request(from, 'peer-links/add', { method: 'POST', body: Buffer.from(JSON.stringify(entry)), timeoutMs: MESH_STEP_TIMEOUT_MS });
    if (added.status !== 200) return `${from.name} did not add ${entry.name} (${why(added.body) || 'status ' + added.status})`;
    return null;
  } catch (err) {
    return `${from.name} is unreachable (${/** @type {Error} */ (err).message})`;
  }
}
