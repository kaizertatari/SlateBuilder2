// Tiny per-key sliding-window rate limiter. Module-level Map persists across
// requests on warm Fluid Compute instances; cold starts reset state (fine —
// the limit is permissive enough that cold-start resets don't meaningfully
// expand the abuse window).
//
// Per-instance only. An attacker spreading requests across instances will
// defeat this; swap for Upstash Redis if that becomes a real concern.

const buckets = new Map();

// Lazy GC: prune empty/expired entries when the map grows past this size.
// Bounds memory without scheduling timers.
const GC_THRESHOLD = 500;

export function rateLimit(key, { windowMs, max }) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const prior = buckets.get(key) || [];
  const hits = prior.filter((t) => t > cutoff);
  if (hits.length >= max) {
    return { ok: false, retryAfterMs: hits[0] + windowMs - now };
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > GC_THRESHOLD) gc(cutoff);
  return { ok: true, remaining: max - hits.length };
}

function gc(cutoff) {
  for (const [k, hits] of buckets) {
    const fresh = hits.filter((t) => t > cutoff);
    if (fresh.length === 0) buckets.delete(k);
    else if (fresh.length !== hits.length) buckets.set(k, fresh);
  }
}
