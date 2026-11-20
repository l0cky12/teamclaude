// How many client requests the proxy served, and how many failed, in each
// ten-minute slot of the last 3h 20m, read from `traffic` in GET /teamclaude/status.
//
// The event log (event-log.js) already records every request, but it keeps a
// fixed number of entries, not a fixed span of time: under heavy use its 2000
// entries cover minutes, not hours. This keeps a fixed number of time slots
// instead, so the span is the same however busy the proxy is.
//
// The slots ride along in the state file (teamclaude.state.json) on its
// regular save, so a restart keeps the chart: read() is what is saved, and
// restore() takes it back at startup.

export const TRAFFIC_BUCKET_MS = 10 * 60 * 1000;

export const TRAFFIC_BUCKETS = 20;

/**
 * @typedef {Object} TrafficBucket
 * @property {number} at  the slot's start, epoch milliseconds
 * @property {number} ok  requests that ended with a status below 400
 * @property {number} failed  requests that ended with no status, or 400 and up
 */

export class RequestTraffic {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {TrafficBucket[]} */
    this.slots = Array.from({ length: TRAFFIC_BUCKETS }, () => ({ at: -1, ok: 0, failed: 0 }));
  }

  /**
   * Count one client request that just ended.
   * @param {unknown} status  the final HTTP status, or null when none was sent
   */
  record(status) {
    const n = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    const at = n * TRAFFIC_BUCKET_MS;
    const slot = this.slots[n % TRAFFIC_BUCKETS];
    if (slot.at !== at) {
      slot.at = at;
      slot.ok = 0;
      slot.failed = 0;
    }
    if (typeof status === 'number' && status > 0 && status < 400) slot.ok++;
    else slot.failed++;
  }

  /**
   * Every slot of the last 3h 20m, oldest first, ending with the current one.
   * A slot with no traffic is listed with zeros.
   * @returns {{ bucketMs: number, buckets: TrafficBucket[] }}
   */
  read() {
    const current = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    /** @type {TrafficBucket[]} */
    const buckets = [];
    for (let n = current - TRAFFIC_BUCKETS + 1; n <= current; n++) {
      const at = n * TRAFFIC_BUCKET_MS;
      const slot = this.slots[n % TRAFFIC_BUCKETS];
      buckets.push(slot.at === at ? { at, ok: slot.ok, failed: slot.failed } : { at, ok: 0, failed: 0 });
    }
    return { bucketMs: TRAFFIC_BUCKET_MS, buckets };
  }

  /**
   * Take back slots saved from read() by an earlier run. The saved value comes
   * from a file, so it is checked here: a different slot size or a value that
   * is not the saved shape is ignored whole, and a slot that is malformed or
   * outside the current 3h 20m is dropped. A kept slot replaces what this
   * instance holds for that time rather than adding to it, so restoring the
   * same value twice counts it once.
   * @param {unknown} saved
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const { bucketMs, buckets } = /** @type {{ bucketMs?: unknown, buckets?: unknown }} */ (saved);
    if (bucketMs !== TRAFFIC_BUCKET_MS || !Array.isArray(buckets)) return;
    const current = Math.floor(this.now() / TRAFFIC_BUCKET_MS);
    for (const b of buckets) {
      if (!b || typeof b !== 'object') continue;
      const { at, ok, failed } = /** @type {Record<string, unknown>} */ (b);
      if (!isCount(ok) || !isCount(failed) || typeof at !== 'number' || at % TRAFFIC_BUCKET_MS !== 0) continue;
      const n = at / TRAFFIC_BUCKET_MS;
      if (n > current || n <= current - TRAFFIC_BUCKETS) continue;
      this.slots[n % TRAFFIC_BUCKETS] = { at, ok, failed };
    }
  }
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isCount(v) {
  return Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0;
}
