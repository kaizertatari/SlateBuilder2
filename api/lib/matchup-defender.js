// Resolves the most-likely primary defender for a player vs a given opponent
// using stats.nba.com/stats/leagueseasonmatchups (season-aggregated, one row
// per defender). Used by Rule 5h FT-leak modifier and Mechanism 3 to gate on
// a confirmed named matchup vs falling back to a team-rank proxy.
//
// Contract mirrors the rest of api/lib/*: returns null on any failure or
// insufficient signal so the orchestrator never hard-fails on this lookup.

import { nbaFetch, rowToObj, findResultSet } from "./nba-http.js";
import { currentSeason } from "./nba-stats.js";
import { TEAM_ID_BY_ABBR } from "./team-ids.js";

// Thresholds — tuned to pre-empt single-possession noise without demanding
// share levels that real rotation defenses rarely produce.
const SURFACE_THRESHOLD = 0.30; // below this, return null (don't surface anything)
const CONFIRMED_THRESHOLD = 0.40; // at/above this, prompt should treat as named-matchup confirmed
const MIN_GAMES = 2;

// In-memory TTL cache. Serverless cold starts re-fetch; warm instances
// amortize. 6h is the upper end of "still relevant for tonight's pick" —
// matchups don't change intra-day.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cacheKey(offPlayerId, defTeamId, season, seasonType) {
  return `${offPlayerId}:${defTeamId}:${season}:${seasonType}`;
}

function fetchMatchups({ offPlayerId, defTeamId, season, seasonType }) {
  return nbaFetch("leagueseasonmatchups", {
    LeagueID: "00",
    PerMode: "Totals",
    Season: season,
    SeasonType: seasonType,
    OffPlayerID: String(offPlayerId),
    DefTeamID: String(defTeamId),
  });
}

// Parse a leagueseasonmatchups payload → top-defender object, or null.
// `proxy` is appended to source so the prompt knows when the data was
// pulled from a fallback (e.g. regular season standing in for empty
// playoff matchup history).
function pickTopDefender(payload, { proxy = false }) {
  const rs = findResultSet(payload, "SeasonMatchups");
  if (!rs?.rowSet?.length) return null;
  const rows = rs.rowSet.map((r) => rowToObj(rs.headers, r));

  const totalPoss = rows.reduce((s, r) => s + (r.PARTIAL_POSS ?? 0), 0);
  if (!totalPoss) return null;

  rows.sort((a, b) => (b.PARTIAL_POSS ?? 0) - (a.PARTIAL_POSS ?? 0));
  const top = rows[0];
  const share = (top.PARTIAL_POSS ?? 0) / totalPoss;

  if (share < SURFACE_THRESHOLD) return null;
  if ((top.GP ?? 0) < MIN_GAMES) return null;

  return {
    player: top.DEF_PLAYER_NAME,
    defender_id: top.DEF_PLAYER_ID,
    share_pct: Number(share.toFixed(2)),
    n_games: top.GP,
    total_poss: Number(totalPoss.toFixed(1)),
    confirmed: share >= CONFIRMED_THRESHOLD,
    source: proxy ? "nba_season_matchups_regular_proxy" : "nba_season_matchups",
  };
}

// Public entry point. `seasonType` is "Regular Season" or "Playoffs".
// For playoffs, falls through to regular-season data when the playoff query
// returns no rows (typical in Game 1/2 of a series). The fallback is tagged
// in the source so the framework can apply lighter weight if desired.
export async function getPrimaryDefender(playerId, oppAbbr, {
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  if (!playerId || !oppAbbr) return null;
  const defTeamId = TEAM_ID_BY_ABBR[String(oppAbbr).toUpperCase()];
  if (!defTeamId) return null;

  const key = cacheKey(playerId, defTeamId, season, seasonType);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const primary = await fetchMatchups({ offPlayerId: playerId, defTeamId, season, seasonType });
  let result = pickTopDefender(primary, { proxy: false });

  if (!result && seasonType === "Playoffs") {
    const proxy = await fetchMatchups({
      offPlayerId: playerId,
      defTeamId,
      season,
      seasonType: "Regular Season",
    });
    result = pickTopDefender(proxy, { proxy: true });
  }

  cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
