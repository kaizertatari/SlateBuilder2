// Tiny in-process TTL cache. Module-level Map persists across requests on
// warm Vercel Fluid Compute instances; cold starts re-fetch. Used for
// league-wide ESPN data (scoreboard, injuries) where a single user's
// back-to-back analyses would otherwise re-hit the same endpoint.
//
// Two modes:
//   - get/set: hard TTL. Entry returns null after expiry.
//   - swr:     stale-while-revalidate. Within the fresh window, return
//              cached. After fresh expires but within stale window, return
//              cached AND kick off a background refresh. After stale
//              expires, await a fresh fetch. Concurrent callers coalesce
//              onto a single in-flight promise per key.
//
// Only successful fetches should be cached — fetchers must return null on
// failure so transient outages don't pin a stale value for the TTL window.

import { logPrefix } from "./request-context.js";

const store = new Map();
const inflight = new Map();

export function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function set(key, value, ttlMs, staleTtlMs) {
  const now = Date.now();
  store.set(key, {
    value,
    expires: now + ttlMs,
    staleExpires: now + (staleTtlMs ?? ttlMs),
  });
}

// Returns { value, isStale } or null. Hard-deletes entries past their
// stale boundary. swr() uses this; callers that want raw access can too.
export function getEntry(key) {
  const entry = store.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.staleExpires <= now) {
    store.delete(key);
    return null;
  }
  return { value: entry.value, isStale: entry.expires <= now };
}

export async function swr(key, fetcher, { freshTtlMs, staleTtlMs }) {
  const entry = getEntry(key);
  if (entry && !entry.isStale) return entry.value;

  // Coalesce: only one refresh in flight per key. Stale callers attach to
  // the same promise as a cold caller would, but only the cold caller
  // awaits it.
  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = (async () => {
      try {
        const value = await fetcher();
        if (value != null) set(key, value, freshTtlMs, staleTtlMs);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, refresh);
  }

  if (entry && entry.isStale) {
    // Stale hit: don't await, but log refresh failures so a degraded backend
    // doesn't silently serve stale data for the entire stale window.
    refresh.catch((err) => console.warn(`${logPrefix()}swr refresh failed for ${key}: ${err?.message}`));
    return entry.value;
  }

  return refresh;
}
