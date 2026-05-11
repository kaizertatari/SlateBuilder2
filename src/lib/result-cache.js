// Browser-side cache for /api/analyze-all responses. Mirrors the server
// cache key in api/analyze-all.js so the same (player, fetched_at, stats,
// direction) tuple maps to the same key on both sides.
//
// Storage: window.sessionStorage. Per-tab; survives navigation, dies on
// tab close. Quota ~5MB; one analyze-all response is well under that.
//
// Invalidation: implicit. The key embeds lines_fetched_at, so when the
// PrizePicks cron writes a new snapshot, prior keys become unreachable.
// We also lazily evict stale per-player siblings on write to bound growth.

const PREFIX = "analyze-all:";

function isBrowser() {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function normalizePlayer(name) {
  return String(name || "").trim().toLowerCase();
}

export function normalizeStats(statTypes) {
  if (!Array.isArray(statTypes) || statTypes.length === 0) return "ALL";
  return [...statTypes].sort().join(",");
}

export function normalizeDirection(direction) {
  return direction === "OVER" || direction === "UNDER" ? direction : "BOTH";
}

// Full key, used when we already know fetched_at (i.e. after a network
// response). Must match server format byte-for-byte.
export function buildKey(player, fetchedAt, statTypes, direction) {
  return `${PREFIX}${normalizePlayer(player)}::${fetchedAt || "unknown"}::${normalizeStats(statTypes)}::${normalizeDirection(direction)}`;
}

// Pattern used to find any cached entry for a given (player, stats,
// direction) tuple regardless of fetched_at. The middle segment is the
// only thing that varies between consecutive cron snapshots.
function keyMatcher(normPlayer, normStats, normDir) {
  const head = `${PREFIX}${normPlayer}::`;
  const tail = `::${normStats}::${normDir}`;
  return (key) => key.startsWith(head) && key.endsWith(tail);
}

// Scan sessionStorage for any cached entry matching (player, stats,
// direction). When multiple snapshots exist, return the one with the
// largest fetched_at — ISO 8601 strings sort lexicographically the same
// as chronologically, so a string max gives the freshest. Returns
// { key, data, fetchedAt } or null.
export function readNewestCached(player, statTypes, direction) {
  if (!isBrowser()) return null;
  const normPlayer = normalizePlayer(player);
  const normStats = normalizeStats(statTypes);
  const normDir = normalizeDirection(direction);
  const matches = keyMatcher(normPlayer, normStats, normDir);

  let best = null; // { key, fetchedAt }
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (!key || !matches(key)) continue;
    // Extract fetched_at segment: between the 2nd and 3rd "::".
    const fetchedAt = key.slice(PREFIX.length + normPlayer.length + 2, key.length - normStats.length - normDir.length - 4);
    if (!best || fetchedAt > best.fetchedAt) {
      best = { key, fetchedAt };
    }
  }
  if (!best) return null;

  try {
    const raw = window.sessionStorage.getItem(best.key);
    if (!raw) return null;
    return { key: best.key, fetchedAt: best.fetchedAt, data: JSON.parse(raw) };
  } catch {
    // Corrupted entry — evict it so we don't keep tripping over it.
    try { window.sessionStorage.removeItem(best.key); } catch { /* ignore */ }
    return null;
  }
}

// Remove every analyze-all entry for this player whose key differs from
// currentKey (i.e. older fetched_at). Keeps one entry per (player, stats,
// direction) tuple instead of N per cron tick.
export function clearStaleForPlayer(currentKey, player) {
  if (!isBrowser()) return;
  const normPlayer = normalizePlayer(player);
  const head = `${PREFIX}${normPlayer}::`;
  const toDelete = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (!key || !key.startsWith(head) || key === currentKey) continue;
    toDelete.push(key);
  }
  for (const k of toDelete) {
    try { window.sessionStorage.removeItem(k); } catch { /* ignore */ }
  }
}

// Drop every analyze-all:* entry. Used as a last resort when sessionStorage
// throws QuotaExceededError on write.
function clearAllAnalyzeAll() {
  if (!isBrowser()) return;
  const toDelete = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key && key.startsWith(PREFIX)) toDelete.push(key);
  }
  for (const k of toDelete) {
    try { window.sessionStorage.removeItem(k); } catch { /* ignore */ }
  }
}

// Persist a response under `key`. If sessionStorage is full, drop every
// analyze-all entry and retry once. If the retry also fails, give up
// quietly — the next call will just re-hit the server cache.
export function writeCached(key, data) {
  if (!isBrowser()) return false;
  const payload = JSON.stringify(data);
  try {
    window.sessionStorage.setItem(key, payload);
    return true;
  } catch {
    clearAllAnalyzeAll();
    try {
      window.sessionStorage.setItem(key, payload);
      return true;
    } catch {
      return false;
    }
  }
}
