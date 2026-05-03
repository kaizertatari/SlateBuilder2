// stats.nba.com client. Vercel serverless IPs are sometimes 403'd by the
// NBA stats edge — every helper returns null on failure so the orchestrator
// can surface a missing-data SKIP rather than crash.

import { nbaFetch, rowToObj, findResultSet } from "./nba-http.js";

export function currentSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  // NBA season rolls over in October; treat Sep+ as the new season for safety.
  const startYear = m >= 9 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Concurrent in-flight de-dupe for playerdashboardbygeneralsplits — the
// season-averages and home/road-splits helpers both extract from the same
// payload, and the orchestrator fires them in parallel. Without this they'd
// hit stats.nba.com twice for one logical request. Promise resolves and the
// entry clears, so a later, separate request still re-fetches.
const dashInflight = new Map();

function dashboardKey(playerId, season, seasonType) {
  return `${playerId}:${season}:${seasonType}`;
}

async function fetchPlayerDashboard(playerId, season, seasonType) {
  const key = dashboardKey(playerId, season, seasonType);
  let p = dashInflight.get(key);
  if (!p) {
    p = nbaFetch("playerdashboardbygeneralsplits", {
      ...DASH_DEFAULTS,
      PlayerID: playerId,
      Season: season,
      SeasonType: seasonType,
    });
    dashInflight.set(key, p);
    p.finally(() => dashInflight.delete(key));
  }
  return p;
}

const DASH_DEFAULTS = {
  LastNGames: 0,
  LeagueID: "00",
  MeasureType: "Base",
  Month: 0,
  OpponentTeamID: 0,
  PaceAdjust: "N",
  PerMode: "PerGame",
  Period: 0,
  PlusMinus: "N",
  Rank: "N",
  SeasonType: "Regular Season",
  DateFrom: "",
  DateTo: "",
  GameSegment: "",
  Location: "",
  Outcome: "",
  ShotClockRange: "",
  VsConference: "",
  VsDivision: "",
};

function pickAverages(row) {
  return {
    games: row.GP,
    minutes: row.MIN,
    ppg: row.PTS,
    rpg: row.REB,
    apg: row.AST,
    fgm: row.FGM,
    fga: row.FGA,
    fg_pct: row.FG_PCT,
    fg3m: row.FG3M,
    fg3a: row.FG3A,
    fg3_pct: row.FG3_PCT,
    ftm: row.FTM,
    fta: row.FTA,
    ft_pct: row.FT_PCT,
  };
}

export async function getSeasonAverages(playerId, {
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  if (!playerId) return null;
  const data = await fetchPlayerDashboard(playerId, season, seasonType);
  const rs = findResultSet(data, "OverallPlayerDashboard");
  if (!rs?.rowSet?.length) return null;
  return {
    season,
    season_type: seasonType,
    ...pickAverages(rowToObj(rs.headers, rs.rowSet[0])),
  };
}

export async function getHomeAwaySplits(playerId, {
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  if (!playerId) return null;
  const data = await fetchPlayerDashboard(playerId, season, seasonType);
  const rs = findResultSet(data, "LocationPlayerDashboard");
  if (!rs?.rowSet?.length) return null;
  const out = { home: null, road: null };
  for (const r of rs.rowSet) {
    const obj = rowToObj(rs.headers, r);
    const key = String(obj.GROUP_VALUE).toLowerCase();
    if (key === "home" || key === "road") out[key] = pickAverages(obj);
  }
  return out;
}

export async function getLastNGames(playerId, n = 5, {
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  if (!playerId) return null;
  const data = await nbaFetch("playergamelog", {
    PlayerID: playerId,
    Season: season,
    SeasonType: seasonType,
    LeagueID: "00",
    DateFrom: "",
    DateTo: "",
  });
  const rs = findResultSet(data, "PlayerGameLog");
  if (!rs?.rowSet?.length) return null;
  const games = rs.rowSet.slice(0, n).map((r) => {
    const o = rowToObj(rs.headers, r);
    return {
      game_id: o.Game_ID,
      date: o.GAME_DATE,
      matchup: o.MATCHUP,
      result: o.WL,
      minutes: o.MIN,
      pts: o.PTS,
      reb: o.REB,
      ast: o.AST,
      fg3m: o.FG3M,
      fgm: o.FGM,
      fga: o.FGA,
      fg_pct: o.FG_PCT,
      pra: (o.PTS ?? 0) + (o.REB ?? 0) + (o.AST ?? 0),
    };
  });
  if (!games.length) return null;
  const avg = (key) =>
    games.reduce((s, g) => s + (g[key] ?? 0), 0) / games.length;
  return {
    season,
    season_type: seasonType,
    n: games.length,
    games,
    averages: {
      ppg: avg("pts"),
      rpg: avg("reb"),
      apg: avg("ast"),
      fg3m: avg("fg3m"),
      fga: avg("fga"),
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
}

// Map NBA team_id → 3-letter abbreviation. Same source of truth as the
// refresh script. Used to key the league-defense map by abbreviation so
// callers can look up by opponent's abbr.
const NBA_TEAM_ID_TO_ABBR = {
  1610612737: "ATL", 1610612738: "BOS", 1610612739: "CLE", 1610612740: "NOP",
  1610612741: "CHI", 1610612742: "DAL", 1610612743: "DEN", 1610612744: "GSW",
  1610612745: "HOU", 1610612746: "LAC", 1610612747: "LAL", 1610612748: "MIA",
  1610612749: "MIL", 1610612750: "MIN", 1610612751: "BKN", 1610612752: "NYK",
  1610612753: "ORL", 1610612754: "IND", 1610612755: "PHI", 1610612756: "PHX",
  1610612757: "POR", 1610612758: "SAC", 1610612759: "SAS", 1610612760: "OKC",
  1610612761: "TOR", 1610612762: "UTA", 1610612763: "MEM", 1610612764: "WAS",
  1610612765: "DET", 1610612766: "CHA",
};

// Returns { <NBA_ABBR>: { team_id, team_name, def_rating, def_rank } } for
// all 30 teams, or null on failure. Rank 1 = best defense (lowest DEF_RATING).
export async function getLeagueTeamDefense({
  season = currentSeason(),
  seasonType = "Regular Season",
} = {}) {
  const data = await nbaFetch("leaguedashteamstats", {
    ...DASH_DEFAULTS,
    MeasureType: "Advanced",
    Season: season,
    SeasonType: seasonType,
  });
  const rs = findResultSet(data, "LeagueDashTeamStats");
  if (!rs?.rowSet?.length) return null;
  const headers = rs.headers;
  const idIdx = headers.indexOf("TEAM_ID");
  const nameIdx = headers.indexOf("TEAM_NAME");
  const drIdx = headers.indexOf("DEF_RATING");
  if (idIdx < 0 || drIdx < 0) return null;

  const rows = rs.rowSet.map((row) => ({
    team_id: row[idIdx],
    team_name: row[nameIdx],
    def_rating: row[drIdx],
  }));
  rows.sort((a, b) => a.def_rating - b.def_rating);
  const out = {};
  rows.forEach((r, i) => {
    const abbr = NBA_TEAM_ID_TO_ABBR[r.team_id];
    if (!abbr) return;
    out[abbr] = {
      team_id: r.team_id,
      team_name: r.team_name,
      def_rating: r.def_rating,
      def_rank: i + 1,
    };
  });
  return out;
}

export async function getCommonPlayerInfo(playerId) {
  if (!playerId) return null;
  const data = await nbaFetch("commonplayerinfo", {
    PlayerID: playerId,
    LeagueID: "00",
  });
  const rs = findResultSet(data, "CommonPlayerInfo");
  if (!rs?.rowSet?.length) return null;
  const o = rowToObj(rs.headers, rs.rowSet[0]);
  return {
    player_id: o.PERSON_ID,
    full_name: o.DISPLAY_FIRST_LAST,
    team_id: o.TEAM_ID,
    team_name: o.TEAM_NAME,
    team_abbr: o.TEAM_ABBREVIATION,
    team_city: o.TEAM_CITY,
    position: o.POSITION,
    roster_status: o.ROSTERSTATUS,
  };
}
