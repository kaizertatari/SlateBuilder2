// stats.nba.com client. Vercel serverless IPs are sometimes 403'd by the
// NBA stats edge — every helper returns null on failure so the orchestrator
// can surface a missing-data SKIP rather than crash.

const BASE = "https://stats.nba.com/stats";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Connection": "keep-alive",
};

export function currentSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  // NBA season rolls over in October; treat Sep+ as the new season for safety.
  const startYear = m >= 9 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

async function nbaFetch(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${endpoint}?${qs}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      console.error(`stats.nba.com ${endpoint} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`stats.nba.com ${endpoint} threw:`, err.message);
    return null;
  }
}

function rowToObj(headers, row) {
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

function findResultSet(payload, name) {
  return payload?.resultSets?.find((rs) => rs.name === name) ?? null;
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
  const data = await nbaFetch("playerdashboardbygeneralsplits", {
    ...DASH_DEFAULTS,
    PlayerID: playerId,
    Season: season,
    SeasonType: seasonType,
  });
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
  const data = await nbaFetch("playerdashboardbygeneralsplits", {
    ...DASH_DEFAULTS,
    PlayerID: playerId,
    Season: season,
    SeasonType: seasonType,
  });
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
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
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
