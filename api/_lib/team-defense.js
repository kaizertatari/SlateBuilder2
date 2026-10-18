// Opponent defensive rating + league rank. Two-tier reliability:
//   1. Live: stats.nba.com / stats.wnba.com leaguedashteamstats (cached SWR
//      fresh 6h / stale 24h)
//   2. Fallback: committed snapshots — data/team-defense.json (NBA) and
//      data/team-defense-wnba.json (WNBA), refreshed with
//      `npm run refresh-team-defense:guarded [-- --league WNBA]`
//
// The snapshot keeps Rule 5h satisfied even when stats.nba.com 403s the
// Vercel egress IP (a documented, recurring failure mode).
//
// Every result carries provenance (source, season, as_of, games played,
// prior_season) so a verdict built on stale or thin defense data is visible
// in telemetry instead of looking identical to a live, current-season one.

import * as cache from "./cache.js";
import { getLeagueTeamDefense, currentSeason } from "./nba-stats.js";
import { toNbaAbbr } from "./espn.js";
import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";
import nbaSnapshot from "../../data/team-defense.json" with { type: "json" };
import wnbaSnapshot from "../../data/team-defense-wnba.json" with { type: "json" };

const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

// Live ranks built on a handful of games are mostly noise. Until every team
// has played this many, a snapshot (current season, or NBA prior season) is
// preferred; thin live data is used only when nothing else exists.
export const DEF_MIN_GAMES = 10;

function cacheKey(league, season, seasonType) {
  return `team-defense:${league}:${season}:${seasonType}`;
}

async function fetchLeague(season, seasonType, league) {
  return cache.swr(
    cacheKey(league, season, seasonType),
    async () => {
      const teams = await getLeagueTeamDefense({ season, seasonType, league });
      return teams && Object.keys(teams).length > 0
        ? { teams, fetched_at: new Date().toISOString() }
        : null;
    },
    { freshTtlMs: FRESH_TTL_MS, staleTtlMs: STALE_TTL_MS }
  );
}

function minGames(teams) {
  const gps = Object.values(teams).map((r) => r?.gp).filter((g) => typeof g === "number");
  return gps.length ? Math.min(...gps) : null;
}

/**
 * Pure: order the usable defense tables, best first.
 *   1. live, once every team has DEF_MIN_GAMES (or GP is unknown)
 *   2. snapshot for the current season
 *   3. NBA only: snapshot from a prior season (flagged prior_season). WNBA
 *      never carries a prior season forward — same no-carry-over policy as
 *      the WNBA baselines.
 *   4. thin live (flagged thin)
 *
 * @returns {Array<{teams, source, season, as_of, games, prior_season, thin}>}
 */
export function rankDefenseTables({ live, snapshot, seasonType, seasonLabel, league }) {
  const out = [];
  const liveTeams = live?.teams && Object.keys(live.teams).length > 0 ? live.teams : null;
  const liveGames = liveTeams ? minGames(liveTeams) : null;
  const liveEntry = liveTeams && {
    teams: liveTeams, source: "live", season: seasonLabel, as_of: live.fetched_at ?? null,
    games: liveGames, prior_season: false, thin: liveGames != null && liveGames < DEF_MIN_GAMES,
  };
  if (liveEntry && !liveEntry.thin) out.push(liveEntry);

  const snapTeams = snapshot?.seasons?.[seasonType];
  if (snapTeams && Object.keys(snapTeams).length > 0) {
    const prior = snapshot.season !== seasonLabel;
    if (!prior || league !== "WNBA") {
      out.push({
        teams: snapTeams, source: "snapshot", season: snapshot.season ?? null,
        as_of: snapshot.fetched_at ?? null, games: minGames(snapTeams),
        prior_season: prior, thin: false,
      });
    }
  }

  if (liveEntry?.thin) out.push(liveEntry);
  return out;
}

async function defenseTables({ season, seasonType, league }) {
  const seasonLabel = season ?? currentSeason(new Date(), league);
  const live = await fetchLeague(seasonLabel, seasonType, league).catch(() => null);
  const snapshot = league === "WNBA" ? wnbaSnapshot : nbaSnapshot;
  return { seasonLabel, tables: rankDefenseTables({ live, snapshot, seasonType, seasonLabel, league }) };
}

// Returns a { team_abbr → def_rank } map from the best available table.
// Used by composeGroundTruth to feed weighted-L5's per-game opponent
// quality multiplier (v3.5). Missing teams resolve to undefined so the
// weighted-L5 module can treat them as the "null → 1.0" branch.
export async function getDefRankByAbbr({
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  const { tables } = await defenseTables({ season, seasonType, league });
  const best = tables[0];
  if (!best) return null;
  const map = {};
  for (const [abbr, row] of Object.entries(best.teams)) {
    if (row?.def_rank != null) map[abbr] = row.def_rank;
  }
  return map;
}

// Returns { def_rating, def_rank, source, season, as_of, games,
// prior_season, thin } for the opponent from the best table that has it,
// or null if no usable table does.
export async function getOpponentDefense(opponentEspnAbbr, {
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  const statsAbbr = toNbaAbbr(opponentEspnAbbr, league);
  if (!statsAbbr) return null;
  const { seasonLabel, tables } = await defenseTables({ season, seasonType, league });

  for (const t of tables) {
    const row = t.teams[statsAbbr];
    if (!row) continue;
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: t.source,
      season: t.season,
      as_of: t.as_of,
      games: t.games,
      prior_season: t.prior_season,
      thin: t.thin,
    };
  }

  const msg = `team-defense miss for ${statsAbbr} (espn=${opponentEspnAbbr}, league=${league}); no usable live or snapshot table has it`;
  console.warn(`${logPrefix()}${msg}`);
  logEvent({
    level: "warn",
    source: "team-defense",
    message: msg,
    context: { stats_abbr: statsAbbr, espn_abbr: opponentEspnAbbr, league, season_type: seasonType, season: seasonLabel, tables: tables.map((t) => t.source) },
  });
  return null;
}
