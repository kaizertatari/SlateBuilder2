// Resolves the most-likely primary defender for a player vs a given opponent
// using stats.nba.com/stats/leagueseasonmatchups (season-aggregated, one row
// per defender). Used by Rule 5h FT-leak modifier and Mechanism 3 to gate on
// a confirmed named matchup vs falling back to a team-rank proxy.
//
// Contract mirrors the rest of api/_lib/*: returns null on any failure or
// insufficient signal so the orchestrator never hard-fails on this lookup.

import { nbaFetch, rowToObj, findResultSet } from "./nba-http.js";
import { currentSeason } from "./nba-stats.js";
import { teamIdByAbbr } from "./team-ids.js";
import { swr } from "./cache.js";

const LEAGUE_ID_BY_NAME = { NBA: "00", WNBA: "10" };

// Thresholds — tuned to pre-empt single-possession noise without demanding
// share levels that real rotation defenses rarely produce.
const SURFACE_THRESHOLD = 0.30; // below this, return null (don't surface anything)
const CONFIRMED_THRESHOLD = 0.40; // at/above this, prompt should treat as named-matchup confirmed
const MIN_GAMES = 2;

// 6h is the upper end of "still relevant for tonight's pick" — matchups
// don't change intra-day. Stale window is 24h: an outage can serve a
// 6-24h-old matchup rather than missing the field entirely.
const FRESH_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_TTL_MS = 24 * 60 * 60 * 1000;

function fetchMatchups({ offPlayerId, defTeamId, season, seasonType, leagueId }) {
  return nbaFetch("leagueseasonmatchups", {
    LeagueID: leagueId,
    PerMode: "Totals",
    Season: season,
    SeasonType: seasonType,
    OffPlayerID: String(offPlayerId),
    DefTeamID: String(defTeamId),
  }, { leagueId });
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
  season,
  seasonType = "Regular Season",
  league = "NBA",
} = {}) {
  if (!playerId || !oppAbbr) return null;
  const defTeamId = teamIdByAbbr(oppAbbr, league);
  if (!defTeamId) return null;
  const leagueId = LEAGUE_ID_BY_NAME[league] ?? "00";
  const seasonLabel = season ?? currentSeason(new Date(), league);

  const key = `matchup:${league}:${playerId}:${defTeamId}:${seasonLabel}:${seasonType}`;
  // Wrap in an envelope so a "no defender" result (null) still gets cached —
  // swr drops null values, but we don't want to retry stats edge every call
  // for a player with no recorded matchups vs this team.
  const envelope = await swr(key, async () => {
    const primary = await fetchMatchups({ offPlayerId: playerId, defTeamId, season: seasonLabel, seasonType, leagueId });
    let defender = pickTopDefender(primary, { proxy: false });
    if (!defender && seasonType === "Playoffs") {
      const proxy = await fetchMatchups({
        offPlayerId: playerId,
        defTeamId,
        season: seasonLabel,
        seasonType: "Regular Season",
        leagueId,
      });
      defender = pickTopDefender(proxy, { proxy: true });
    }
    return { defender };
  }, { freshTtlMs: FRESH_TTL_MS, staleTtlMs: STALE_TTL_MS });
  return envelope?.defender ?? null;
}
