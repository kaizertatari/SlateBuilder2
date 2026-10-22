// Opponent defensive rating + league rank. Two-tier reliability:
//   1. Live: stats.nba.com / stats.wnba.com leaguedashteamstats (cached SWR
//      fresh 6h / stale 24h)
//   2. Fallback: committed snapshots — data/team-defense.json (NBA) and
//      data/team-defense-wnba.json (WNBA), refreshed with
//      `npm run refresh-team-defense:guarded` / `refresh-team-defense:wnba:guarded`
//
// The snapshot keeps Rule 5h satisfied even when stats.nba.com 403s the
// Vercel egress IP (a documented, recurring failure mode).
//
// NBA ratings are a blend of this season and last season, weighted by games
// played: w = gp / (gp + DEF_BLEND_K). A few games of defense are mostly
// noise; last season is a decent but fading prior. Backtest over 2021-22 →
// 2025-26 (scripts/fit-defense-blend.mjs): the blend beats either source
// alone at every point of the season. WNBA uses this season only (no
// carry-over policy).
//
// Every result carries provenance (source, season, as_of, games, weight) so
// a verdict built on stale or prior-season defense is visible in telemetry.

import * as cache from "./cache.js";
import { getLeagueTeamDefense, currentSeason } from "./nba-stats.js";
import { toNbaAbbr } from "./espn.js";
import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";
import nbaSnapshot from "../../data/team-defense.json" with { type: "json" };
import wnbaSnapshot from "../../data/team-defense-wnba.json" with { type: "json" };

const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

// Games at which this season and last season get equal weight. Fit with
// `node scripts/fit-defense-blend.mjs` (minimises rest-of-season DRtg
// error). 2026-10-18, four season pairs 2021-22→2025-26: k=15 RMSE 2.49,
// k=20 2.48, k=10 2.54, this-season-only 3.68, last-season-only 2.90.
// Re-fit each preseason.
export const DEF_BLEND_K = 15;

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

function priorSeasonLabel(seasonLabel) {
  const y = parseInt(seasonLabel, 10);
  return `${y - 1}-${String(y % 100).padStart(2, "0")}`;
}

const nonEmpty = (t) => (t && Object.keys(t).length > 0 ? t : null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Pure: build the one defense table the engine uses.
 *   current = live, else a current-season snapshot
 *   prior   = NBA only: last season's regular season (snapshot whose season
 *             is last season, or its `prior_season` block)
 * Both → per-team blend w·current + (1−w)·prior, w = gp/(gp+K), prior
 * re-centred on the current league mean, then re-ranked. One → that one.
 *
 * @returns {{teams, source, season, as_of, games}|null} — teams[abbr] has
 *   def_rating, def_rank, gp, weight (current-season share, 0..1)
 */
export function resolveDefenseTable({ live, snapshot, seasonType, seasonLabel, league, k = DEF_BLEND_K }) {
  let current = null;
  if (nonEmpty(live?.teams)) {
    current = { teams: live.teams, source: "live", as_of: live.fetched_at ?? null };
  } else if (snapshot?.season === seasonLabel && nonEmpty(snapshot.seasons?.[seasonType])) {
    current = { teams: snapshot.seasons[seasonType], source: "snapshot", as_of: snapshot.fetched_at ?? null };
  }

  let prior = null;
  if (league !== "WNBA") {
    const want = priorSeasonLabel(seasonLabel);
    if (snapshot?.season === want) prior = nonEmpty(snapshot.seasons?.["Regular Season"]);
    else if (snapshot?.prior_season?.season === want) prior = nonEmpty(snapshot.prior_season.teams);
  }

  const gps = (t) => Object.values(t).map((r) => r?.gp).filter((g) => typeof g === "number");
  const table = (teams, meta) => {
    const ranked = Object.entries(teams).sort((a, b) => a[1].def_rating - b[1].def_rating);
    const out = {};
    ranked.forEach(([abbr, r], i) => { out[abbr] = { ...r, def_rank: i + 1 }; });
    const g = gps(teams);
    return { teams: out, games: g.length ? Math.min(...g) : null, ...meta };
  };

  if (current && prior) {
    const curMean = mean(Object.values(current.teams).map((r) => r.def_rating));
    const priorMean = mean(Object.values(prior).map((r) => r.def_rating));
    const blended = {};
    for (const [abbr, r] of Object.entries(current.teams)) {
      const p = prior[abbr];
      // Unknown gp means a finished/established table — trust it fully.
      const w = !p || typeof r.gp !== "number" ? 1 : r.gp / (r.gp + k);
      const pr = p ? p.def_rating - priorMean + curMean : r.def_rating;
      blended[abbr] = { ...r, def_rating: +(w * r.def_rating + (1 - w) * pr).toFixed(2), weight: +w.toFixed(3) };
    }
    // Opening week: the live table only lists teams that have played, so a
    // team yet to tip off keeps its re-centred last-season row (weight 0).
    for (const [abbr, p] of Object.entries(prior)) {
      if (blended[abbr]) continue;
      blended[abbr] = { ...p, def_rating: +(p.def_rating - priorMean + curMean).toFixed(2), gp: 0, weight: 0 };
    }
    return table(blended, { source: `${current.source}+prior`, season: seasonLabel, as_of: current.as_of });
  }
  if (current) {
    const teams = Object.fromEntries(Object.entries(current.teams).map(([a, r]) => [a, { ...r, weight: 1 }]));
    return table(teams, { source: current.source, season: seasonLabel, as_of: current.as_of });
  }
  if (prior) {
    const teams = Object.fromEntries(Object.entries(prior).map(([a, r]) => [a, { ...r, gp: 0, weight: 0 }]));
    return table(teams, { source: "prior", season: priorSeasonLabel(seasonLabel), as_of: snapshot.fetched_at ?? null });
  }
  return null;
}

async function defenseTable({ season, seasonType, league }) {
  const seasonLabel = season ?? currentSeason(new Date(), league);
  const live = await fetchLeague(seasonLabel, seasonType, league).catch(() => null);
  const snapshot = league === "WNBA" ? wnbaSnapshot : nbaSnapshot;
  return { seasonLabel, table: resolveDefenseTable({ live, snapshot, seasonType, seasonLabel, league }) };
}

// Returns a { team_abbr → def_rank } map from the resolved table.
// Used by composeGroundTruth to feed weighted-L5's per-game opponent
// quality multiplier (v3.5). Missing teams resolve to undefined so the
// weighted-L5 module can treat them as the "null → 1.0" branch.
export async function getDefRankByAbbr({
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  const { table } = await defenseTable({ season, seasonType, league });
  if (!table) return null;
  const map = {};
  for (const [abbr, row] of Object.entries(table.teams)) {
    if (row?.def_rank != null) map[abbr] = row.def_rank;
  }
  return map;
}

// Returns { def_rating, def_rank, source, season, as_of, games, weight,
// prior_season } for the opponent, or null when no table has it.
export async function getOpponentDefense(opponentEspnAbbr, {
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  const statsAbbr = toNbaAbbr(opponentEspnAbbr, league);
  if (!statsAbbr) return null;
  const { seasonLabel, table } = await defenseTable({ season, seasonType, league });

  const row = table?.teams?.[statsAbbr];
  if (row) {
    return {
      def_rating: row.def_rating,
      def_rank: row.def_rank,
      source: table.source,
      season: table.season,
      as_of: table.as_of,
      games: row.gp ?? null,
      weight: row.weight,
      prior_season: table.source === "prior",
    };
  }

  const msg = `team-defense miss for ${statsAbbr} (espn=${opponentEspnAbbr}, league=${league}); ${table ? `resolved ${table.source} table lacks it` : "no live or usable snapshot table"}`;
  console.warn(`${logPrefix()}${msg}`);
  logEvent({
    level: "warn",
    source: "team-defense",
    message: msg,
    context: { stats_abbr: statsAbbr, espn_abbr: opponentEspnAbbr, league, season_type: seasonType, season: seasonLabel, table: table?.source ?? null },
  });
  return null;
}
