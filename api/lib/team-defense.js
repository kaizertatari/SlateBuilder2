// Opponent defensive rating + league rank. Two-tier reliability:
//   1. Live: stats.nba.com leaguedashteamstats (cached SWR fresh 6h / stale 24h)
//   2. Fallback: data/team-defense.json snapshot (committed, refreshed manually)
//
// The snapshot keeps Rule 5h satisfied even when stats.nba.com 403s the
// Vercel egress IP (a documented, recurring failure mode). Refresh the
// snapshot with `npm run refresh-team-defense` whenever convenient.

import * as cache from "./cache.js";
import { getLeagueTeamDefense, currentSeason } from "./nba-stats.js";
import { toNbaAbbr } from "./espn.js";
import { logPrefix } from "./request-context.js";
import snapshot from "../../data/team-defense.json" with { type: "json" };

const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(season, seasonType) {
  return `team-defense:${season}:${seasonType}`;
}

async function fetchLeague(season, seasonType) {
  return cache.swr(
    cacheKey(season, seasonType),
    () => getLeagueTeamDefense({ season, seasonType }),
    { freshTtlMs: FRESH_TTL_MS, staleTtlMs: STALE_TTL_MS }
  );
}

function snapshotLookup(seasonType) {
  return snapshot?.seasons?.[seasonType] ?? null;
}

// Returns { def_rating, def_rank, source } for the opponent, or null if
// the abbreviation is unknown to both live and snapshot data.
export async function getOpponentDefense(opponentEspnAbbr, {
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  const nbaAbbr = toNbaAbbr(opponentEspnAbbr);
  if (!nbaAbbr) return null;

  const live = await fetchLeague(season, seasonType);
  if (live && live[nbaAbbr]) {
    const row = live[nbaAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "live",
    };
  }

  const snap = snapshotLookup(seasonType);
  if (snap && snap[nbaAbbr]) {
    const row = snap[nbaAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "snapshot",
    };
  }

  console.warn(`${logPrefix()}team-defense miss for ${nbaAbbr} (espn=${opponentEspnAbbr}); live and snapshot both empty`);
  return null;
}
