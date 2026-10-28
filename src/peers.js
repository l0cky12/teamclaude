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
