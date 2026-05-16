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

function cacheKey(league, season, seasonType) {
  return `team-defense:${league}:${season}:${seasonType}`;
}

async function fetchLeague(season, seasonType, league) {
  return cache.swr(
    cacheKey(league, season, seasonType),
    () => getLeagueTeamDefense({ season, seasonType, league }),
    { freshTtlMs: FRESH_TTL_MS, staleTtlMs: STALE_TTL_MS }
  );
}

// Snapshot is NBA-only at present. Returns null for WNBA so the orchestrator
// can drop opponent_defense rather than mis-applying NBA data to a WNBA game.
function snapshotLookup(seasonType, league) {
  if (league !== "NBA") return null;
  return snapshot?.seasons?.[seasonType] ?? null;
}

// Returns { def_rating, def_rank, source } for the opponent, or null if
// the abbreviation is unknown to both live and snapshot data.
export async function getOpponentDefense(opponentEspnAbbr, {
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  const statsAbbr = toNbaAbbr(opponentEspnAbbr, league);
  if (!statsAbbr) return null;
  const seasonLabel = season ?? currentSeason(new Date(), league);

  const live = await fetchLeague(seasonLabel, seasonType, league);
  if (live && live[statsAbbr]) {
    const row = live[statsAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "live",
    };
  }

  const snap = snapshotLookup(seasonType, league);
  if (snap && snap[statsAbbr]) {
    const row = snap[statsAbbr];
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: "snapshot",
    };
  }

  console.warn(`${logPrefix()}team-defense miss for ${statsAbbr} (espn=${opponentEspnAbbr}, league=${league}); live and snapshot both empty`);
  return null;
}
