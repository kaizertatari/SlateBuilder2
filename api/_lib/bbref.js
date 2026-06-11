// Basketball-Reference splits adapter. Reads from disk snapshots maintained
// by scripts/refresh-bbref-splits.mjs (1×/day).
//
// Used as the primary source for home/road splits because Vercel egress IPs
// are throttled by stats.nba.com — the live stats path silently times out and
// leaves UNDERs without their home/road gating signal. BR is a static
// snapshot read from disk, so it never times out and never rate-limits.
//
// Returns the same shape as api/_lib/nba-stats.js getHomeAwaySplits:
//   { home: <averages>|null, road: <averages>|null } or null on miss.

import nbaSnapshot from "../../data/bbref-splits.json" with { type: "json" };
import wnbaSnapshot from "../../data/bbref-splits-wnba.json" with { type: "json" };
import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";

const SUPPORTED_SEASON_TYPES = new Set(["Regular Season"]);

function snapshotFor(league) {
  return league === "WNBA" ? wnbaSnapshot : nbaSnapshot;
}

// Returns `{ home, road }` for the requested player+season, or null when
// either the snapshot is empty (file shipped before refresh) or the player
// has no slug. Callers should fall back to the stats-edge adapter on null.
export function getHomeAwaySplits(playerName, {
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  if (!SUPPORTED_SEASON_TYPES.has(seasonType)) return null;
  if (!playerName) return null;
  const snapshot = snapshotFor(league);
  if (!snapshot?.players) return null;
  // BR splits are keyed by season label (e.g. "2025-26" NBA, "2025" WNBA).
  // The snapshot only covers one season at a time. On a season mismatch we
  // still return the snapshot data (better than nothing on opening day) but
  // tag it with is_prior_season=true so composeGroundTruth surfaces a
  // data_warnings entry and the framework caps the verdict accordingly.
  const isPriorSeason = !!(season && snapshot.season && season !== snapshot.season);
  if (isPriorSeason) {
    const msg = `bbref snapshot (${league}) is ${snapshot.season}, caller asked for ${season} — returning prior-season fallback`;
    console.warn(`${logPrefix()}${msg}`);
    logEvent({
      level: "warn",
      source: "bbref",
      message: msg,
      context: { league, snapshot_season: snapshot.season, requested_season: season, player: playerName },
    });
  }

  const row = snapshot.players[playerName];
  if (!row) return null;

  return {
    home: row.home ?? null,
    road: row.road ?? null,
    is_prior_season: isPriorSeason,
    source_season: snapshot.season,
  };
}

export function snapshotMeta(league = "NBA") {
  const snapshot = snapshotFor(league);
  return {
    league,
    season: snapshot?.season ?? null,
    fetched_at: snapshot?.fetched_at ?? null,
    player_count: Object.keys(snapshot?.players ?? {}).length,
  };
}
