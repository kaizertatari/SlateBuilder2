// Basketball-Reference splits adapter. Reads from data/bbref-splits.json,
// a snapshot maintained by scripts/refresh-bbref-splits.mjs (1×/day).
//
// Used as the primary source for home/road splits because Vercel egress IPs
// are throttled by stats.nba.com — the NBA path silently times out and
// leaves UNDERs without their home/road gating signal. BR is a static
// snapshot read from disk, so it never times out and never rate-limits.
//
// Returns the same shape as api/lib/nba-stats.js getHomeAwaySplits:
//   { home: <averages>|null, road: <averages>|null } or null on miss.

import snapshot from "../../data/bbref-splits.json" with { type: "json" };
import { logPrefix } from "./request-context.js";

const SUPPORTED_SEASON_TYPES = new Set(["Regular Season"]);

// Returns `{ home, road }` for the requested player+season, or null when
// either the snapshot is empty (file shipped before refresh) or the player
// has no slug. Callers should fall back to the NBA-stats adapter on null.
export function getHomeAwaySplits(playerName, {
  season = snapshot?.season ?? null,
  seasonType = "Regular Season",
} = {}) {
  if (!SUPPORTED_SEASON_TYPES.has(seasonType)) return null;
  if (!playerName) return null;
  if (!snapshot?.players) return null;
  // BR splits are keyed by season label (e.g. "2025-26"). The snapshot only
  // covers one season at a time; if the caller asked for a different one,
  // signal a miss so NBA Stats can serve the correct year.
  if (season && snapshot.season && season !== snapshot.season) {
    console.warn(`${logPrefix()}bbref snapshot is ${snapshot.season}, caller asked for ${season} — returning null`);
    return null;
  }

  const row = snapshot.players[playerName];
  if (!row) return null;

  return {
    home: row.home ?? null,
    road: row.road ?? null,
  };
}

export function snapshotMeta() {
  return {
    season: snapshot?.season ?? null,
    fetched_at: snapshot?.fetched_at ?? null,
    player_count: Object.keys(snapshot?.players ?? {}).length,
  };
}
