// Tiny in-process TTL cache. Module-level Map persists across requests on
// warm Vercel Fluid Compute instances; cold starts re-fetch. Used for
// league-wide ESPN data (scoreboard, injuries) where a single user's
// back-to-back analyses would otherwise re-hit the same endpoint.
//
// Only successful responses should be cached — callers must skip set() on
// null/error so transient outages don't get pinned for the TTL window.

const store = new Map();

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export function clear() {
  store.clear();
}
