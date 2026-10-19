// Basketball opponent-factor model, step 1: pure parsers for the league-wide
// stats.nba.com / stats.wnba.com feeds. No network here — the refresh script
// (scripts/refresh-basketball-gamelogs.mjs) fetches, this module shapes.
//
//   leaguegamelog?PlayerOrTeam=P  one row per player-game (box score)
//   leaguegamelog?PlayerOrTeam=T  one row per team-game (validation + exact
//                                 team totals)
//   playerindex?Historical=1      listed position for every player
//
// Rows keep zero stats out (read with statOf) to keep the snapshot compact,
// same convention as the NFL snapshot.

export const BOX_FIELDS = {
  min: "MIN", pts: "PTS", reb: "REB", oreb: "OREB", dreb: "DREB", ast: "AST",
  stl: "STL", blk: "BLK", tov: "TOV", pf: "PF", fgm: "FGM", fga: "FGA",
  fg3m: "FG3M", fg3a: "FG3A", ftm: "FTM", fta: "FTA",
};

export const statOf = (row, field) => row?.[field] ?? 0;

// Listed position → defensive matchup group. G = guards; W = wings and
// forwards (G-F, F-G, F); B = bigs (F-C, C-F, C). Listed positions are
// coarse — the backtest is the judge of whether finer roles pay.
export const POSITION_GROUPS = ["G", "W", "B"];
export function positionGroup(pos) {
  const p = String(pos ?? "").toUpperCase().trim();
  if (p === "G") return "G";
  if (p === "G-F" || p === "F-G" || p === "F") return "W";
  if (p === "F-C" || p === "C-F" || p === "C") return "B";
  return null;
}

/** stats.nba.com resultSet → array of objects keyed by header. */
export function resultRows(payload, name = null) {
  const sets = payload?.resultSets ?? (payload?.resultSet ? [payload.resultSet] : []);
  const rs = name ? sets.find((s) => s.name === name) : sets[0];
  if (!rs?.headers || !rs?.rowSet) return [];
  return rs.rowSet.map((row) => Object.fromEntries(rs.headers.map((h, i) => [h, row[i]])));
}

// "OKC vs. HOU" → home game vs HOU; "OKC @ HOU" → away at HOU.
export function parseMatchup(matchup) {
  const m = String(matchup ?? "").match(/^(\S+)\s+(vs\.|@)\s+(\S+)$/);
  if (!m) return null;
  return { team: m[1], home: m[2] === "vs.", opponent: m[3] };
}

/**
 * Player game log → compact rows.
 * @returns {Array<{player_id, game_id, date, team, opponent, home, ...stats}>}
 */
export function parsePlayerGameLog(payload) {
  const out = [];
  for (const r of resultRows(payload)) {
    const mu = parseMatchup(r.MATCHUP);
    if (!mu || !r.GAME_ID || r.PLAYER_ID == null) continue;
    const row = {
      player_id: r.PLAYER_ID, game_id: String(r.GAME_ID), date: r.GAME_DATE,
      team: r.TEAM_ABBREVIATION, opponent: mu.opponent, home: mu.home,
    };
    for (const [k, h] of Object.entries(BOX_FIELDS)) {
      const v = Number(r[h]);
      if (Number.isFinite(v) && v !== 0) row[k] = v;
    }
    out.push(row);
  }
  return out;
}

/** Team game log → { "<game_id>|<team>": { pts, fga, fta, oreb, tov, ... } }. */
export function parseTeamGameLog(payload) {
  const out = {};
  for (const r of resultRows(payload)) {
    const mu = parseMatchup(r.MATCHUP);
    if (!mu || !r.GAME_ID) continue;
    const t = { game_id: String(r.GAME_ID), date: r.GAME_DATE, team: r.TEAM_ABBREVIATION, opponent: mu.opponent, home: mu.home };
    for (const [k, h] of Object.entries(BOX_FIELDS)) if (k !== "min") t[k] = Number(r[h]) || 0;
    out[`${t.game_id}|${t.team}`] = t;
  }
  return out;
}

/** playerindex → { id: { name, position, group } } for the given ids (all if null). */
export function parsePlayerIndex(payload, ids = null) {
  const out = {};
  for (const r of resultRows(payload)) {
    if (ids && !ids.has(r.PERSON_ID)) continue;
    out[r.PERSON_ID] = {
      name: `${r.PLAYER_FIRST_NAME ?? ""} ${r.PLAYER_LAST_NAME ?? ""}`.trim(),
      position: r.POSITION || null,
      group: positionGroup(r.POSITION),
    };
  }
  return out;
}

// Possessions (Oliver): FGA + 0.44·FTA − OREB + TOV, averaged over both
// sides of the game so a team-game and its opponent share one count.
export const possessionsOf = (t) => t.fga + 0.44 * t.fta - t.oreb + t.tov;

/**
 * Team totals → team-games with possessions and the opponent's line.
 * @returns {Array<{game_id, date, team, opponent, home, poss, pts, ..., opp: {...}}>}
 */
export function buildTeamGames(teamLog) {
  const out = [];
  for (const t of Object.values(teamLog)) {
    const o = teamLog[`${t.game_id}|${t.opponent}`];
    if (!o) continue;
    out.push({ ...t, poss: +((possessionsOf(t) + possessionsOf(o)) / 2).toFixed(2), opp_pts: o.pts });
  }
  return out;
}

/**
 * Internal consistency: every game has two teams, and the player rows sum to
 * the team box score for every counted stat. Returns a list of problems.
 */
export function validate(rows, teamLog, players) {
  const problems = [];
  const sums = new Map();
  for (const r of rows) {
    const k = `${r.game_id}|${r.team}`;
    const s = sums.get(k) ?? {};
    for (const f of ["pts", "reb", "ast", "fga", "fg3a", "fta", "tov", "stl", "blk"]) s[f] = (s[f] ?? 0) + statOf(r, f);
    sums.set(k, s);
  }
  for (const [k, s] of sums) {
    const t = teamLog[k];
    if (!t) { problems.push(`${k}: player rows but no team row`); continue; }
    for (const f of Object.keys(s)) {
      // Team turnovers (shot clock, 8-second, ...) are charged to the team,
      // not a player, so the player sum may fall short — never exceed.
      const ok = f === "tov" ? s[f] <= t[f] : s[f] === t[f];
      if (!ok) problems.push(`${k}: ${f} players ${s[f]} vs team ${t[f]}`);
    }
  }
  for (const k of Object.keys(teamLog)) {
    const t = teamLog[k];
    if (!teamLog[`${t.game_id}|${t.opponent}`]) problems.push(`${k}: no opponent row`);
    if (!sums.has(k)) problems.push(`${k}: team row but no player rows`);
  }
  const minutes = rows.reduce((a, r) => a + statOf(r, "min"), 0);
  const unpos = rows.filter((r) => !players[r.player_id]?.group).reduce((a, r) => a + statOf(r, "min"), 0);
  if (minutes > 0 && unpos / minutes > 0.01) problems.push(`${(100 * unpos / minutes).toFixed(1)}% of minutes have no position group`);
  return problems;
}
