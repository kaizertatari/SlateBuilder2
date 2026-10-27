// NBA team tracker, step 1: pure parsers for the per-game stats.nba.com box
// score feeds (v3 JSON). No network here — scripts/refresh-nba-boxscores.mjs
// fetches, this module shapes and validates.
//
//   boxscoretraditionalv3  team totals + the STARTERS / BENCH split; a player
//                          is a starter when his `position` is non-empty
//   boxscoremiscv3         paint / fast-break / second-chance / off-TO points
//                          (team and player, own and opponent's)
//   boxscoreadvancedv3     team ratings; player on-court ORtg / DRtg, usage
//   boxscorehustlev2       contests, deflections, charges, box-outs
//   boxscoredefensivev2    matchup defense: FG allowed to the players guarded
//
// One game → { game_id, date, home, away, teams: { TRI: {...} }, players: [...] }.
// Zero stats are kept (unlike the gamelog snapshot) — the tracker averages
// them and a missing key would read as "not tracked", not 0.

export const TRAD = {
  fgm: "fieldGoalsMade", fga: "fieldGoalsAttempted", fg3m: "threePointersMade", fg3a: "threePointersAttempted",
  ftm: "freeThrowsMade", fta: "freeThrowsAttempted", oreb: "reboundsOffensive", dreb: "reboundsDefensive",
  reb: "reboundsTotal", ast: "assists", stl: "steals", blk: "blocks", tov: "turnovers", pf: "foulsPersonal",
  pts: "points", pm: "plusMinusPoints",
};
export const MISC = {
  pts_off_tov: "pointsOffTurnovers", pts_2nd: "pointsSecondChance", pts_fb: "pointsFastBreak", pts_paint: "pointsPaint",
  opp_pts_off_tov: "oppPointsOffTurnovers", opp_pts_2nd: "oppPointsSecondChance", opp_pts_fb: "oppPointsFastBreak",
  opp_pts_paint: "oppPointsPaint", blk_against: "blocksAgainst", fouls_drawn: "foulsDrawn",
};
export const ADV = {
  ortg: "offensiveRating", drtg: "defensiveRating", ast_pct: "assistPercentage", oreb_pct: "offensiveReboundPercentage",
  dreb_pct: "defensiveReboundPercentage", tov_ratio: "turnoverRatio", efg: "effectiveFieldGoalPercentage",
  ts: "trueShootingPercentage", usg: "usagePercentage", pace: "pace", poss: "possessions",
};
export const HUSTLE = {
  contests: "contestedShots", contests3: "contestedShots3pt", deflections: "deflections", charges: "chargesDrawn",
  screen_ast: "screenAssists", loose_balls: "looseBallsRecoveredTotal", box_outs: "boxOuts", def_box_outs: "defensiveBoxOuts",
};
export const MATCHUP = {
  m_min: "matchupMinutes", m_poss: "partialPossessions", m_pts: "playerPoints", m_fgm: "matchupFieldGoalsMade",
  m_fga: "matchupFieldGoalsAttempted", m_fg3m: "matchupThreePointersMade", m_fg3a: "matchupThreePointersAttempted",
  m_ast: "matchupAssists", m_tov: "matchupTurnovers",
};

/** "33:15" / "PT33M15.00S" / 33 → minutes as a number (2 decimals). */
export function minutesOf(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const s = String(v);
  let m = s.match(/^(\d+):(\d+)/);
  if (m) return +(Number(m[1]) + Number(m[2]) / 60).toFixed(2);
  m = s.match(/^PT(\d+)M([\d.]+)S$/);
  if (m) return +(Number(m[1]) + Number(m[2]) / 60).toFixed(2);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pick(src, map) {
  const out = {};
  for (const [k, f] of Object.entries(map)) {
    const v = src?.[f];
    out[k] = k === "m_min" ? minutesOf(v) : (typeof v === "number" ? v : v == null ? null : Number(v));
  }
  return out;
}

const boxOf = (payload) => payload?.[Object.keys(payload ?? {}).find((k) => k.startsWith("boxScore"))] ?? null;

/**
 * Five payloads for one game → the stored game record. `date` comes from the
 * league game log (the v3 feeds don't carry it). Missing optional feeds
 * (hustle / matchup are sometimes late) leave those blocks null.
 */
export function parseGame({ trad, misc, adv, hustle, def }, date) {
  const t = boxOf(trad);
  if (!t?.homeTeam || !t?.awayTeam) return null;
  const sides = { home: t.homeTeam, away: t.awayTeam };
  const extra = { misc: boxOf(misc), adv: boxOf(adv), hustle: boxOf(hustle), def: boxOf(def) };
  const game = { game_id: String(t.gameId), date, home: t.homeTeam.teamTricode, away: t.awayTeam.teamTricode, teams: {}, players: [] };
  for (const [side, team] of Object.entries(sides)) {
    const tri = team.teamTricode;
    const opp = sides[side === "home" ? "away" : "home"].teamTricode;
    const other = (feed) => extra[feed]?.[`${side}Team`] ?? null;
    game.teams[tri] = {
      team: tri, opp, home: side === "home",
      min: minutesOf(team.statistics?.minutes),
      totals: pick(team.statistics, TRAD),
      starters: { ...pick(team.starters, TRAD), min: minutesOf(team.starters?.minutes) },
      bench: { ...pick(team.bench, TRAD), min: minutesOf(team.bench?.minutes) },
      misc: other("misc") ? pick(other("misc").statistics, MISC) : null,
      adv: other("adv") ? pick(other("adv").statistics, ADV) : null,
      hustle: other("hustle") ? pick(other("hustle").statistics, HUSTLE) : null,
    };
    const byId = (feed) => new Map((other(feed)?.players ?? []).map((p) => [p.personId, p.statistics]));
    const mi = byId("misc"), ad = byId("adv"), hu = byId("hustle"), de = byId("def");
    for (const p of team.players ?? []) {
      const min = minutesOf(p.statistics?.minutes);
      if (!(min > 0)) continue; // DNP / inactive
      game.players.push({
        id: p.personId, name: `${p.firstName ?? ""} ${p.familyName ?? ""}`.trim(), team: tri, opp,
        starter: Boolean(p.position), pos: p.position || null, min,
        ...pick(p.statistics, TRAD),
        misc: mi.has(p.personId) ? pick(mi.get(p.personId), MISC) : null,
        adv: ad.has(p.personId) ? pick(ad.get(p.personId), ADV) : null,
        hustle: hu.has(p.personId) ? pick(hu.get(p.personId), HUSTLE) : null,
        matchup: de.has(p.personId) ? pick(de.get(p.personId), MATCHUP) : null,
      });
    }
  }
  return game;
}

export const COUNTED = ["fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "pf", "pts"];

/**
 * Team totals vs another source's team totals ({ TRI: { pts, fga, ... } }).
 * Only fields the other source carries are compared. Returns problems.
 */
export function compareTotals(game, other, label) {
  const p = [];
  for (const [tri, t] of Object.entries(game.teams)) {
    const o = other?.[tri];
    if (!o) { p.push(`${game.game_id} ${tri}: no ${label} row`); continue; }
    for (const f of COUNTED) if (o[f] != null && o[f] !== t.totals[f]) p.push(`${game.game_id} ${tri}: ${f} box ${t.totals[f]} ≠ ${label} ${o[f]}`);
  }
  return p;
}

/**
 * Internal accuracy checks for one stored game (sources compared separately
 * with compareTotals). Returns a list of problems (empty = clean).
 */
export function validateGame(game) {
  const p = [];
  const tris = Object.keys(game.teams);
  if (tris.length !== 2) p.push(`${game.game_id}: ${tris.length} teams`);
  for (const tri of tris) {
    const t = game.teams[tri];
    const tag = `${game.game_id} ${tri}`;
    // Regulation 240 team-minutes, +25 per overtime.
    if (!(t.min >= 239.5) || Math.abs(((t.min - 240) / 25) - Math.round((t.min - 240) / 25)) > 0.05) p.push(`${tag}: team minutes ${t.min}`);
    const starters = game.players.filter((x) => x.team === tri && x.starter);
    if (starters.length !== 5) p.push(`${tag}: ${starters.length} starters`);
    for (const f of COUNTED) {
      const tot = t.totals[f];
      if (t.starters[f] + t.bench[f] !== tot) p.push(`${tag}: ${f} starters ${t.starters[f]} + bench ${t.bench[f]} ≠ team ${tot}`);
      const ps = game.players.filter((x) => x.team === tri).reduce((a, x) => a + (x[f] ?? 0), 0);
      if (ps !== tot) p.push(`${tag}: ${f} players ${ps} ≠ team ${tot}`);
      const sp = starters.reduce((a, x) => a + (x[f] ?? 0), 0);
      if (sp !== t.starters[f]) p.push(`${tag}: ${f} starter rows ${sp} ≠ starters block ${t.starters[f]}`);
    }
    if (t.totals.fgm * 2 + t.totals.fg3m + t.totals.ftm !== t.totals.pts) p.push(`${tag}: pts ≠ 2·FGM + 3PM + FTM`);
    if (t.totals.oreb + t.totals.dreb !== t.totals.reb) p.push(`${tag}: OREB + DREB ≠ REB`);
    const o = game.teams[t.opp];
    if (o && t.totals.pm !== t.totals.pts - o.totals.pts) p.push(`${tag}: plus-minus ${t.totals.pm} ≠ margin ${t.totals.pts - o.totals.pts}`);
    if (o && t.misc && o.misc && t.misc.pts_paint !== o.misc.opp_pts_paint) p.push(`${tag}: paint pts ${t.misc.pts_paint} ≠ opponent's allowed ${o.misc.opp_pts_paint}`);
    if (!t.misc) p.push(`${tag}: misc box missing`);
    if (!t.adv) p.push(`${tag}: advanced box missing`);
  }
  return p;
}

/** ESPN summary boxscore.teams[] → { NBA_TRI: { fgm, fga, ... } } (mapTri: ESPN abbr → NBA). */
export function parseEspnTeamTotals(summary, mapTri) {
  const out = {};
  for (const t of summary?.boxscore?.teams ?? []) {
    const s = Object.fromEntries((t.statistics ?? []).map((x) => [x.name, x.displayValue]));
    const pair = (k) => String(s[k] ?? "").split("-").map(Number);
    const [fgm, fga] = pair("fieldGoalsMade-fieldGoalsAttempted");
    const [fg3m, fg3a] = pair("threePointFieldGoalsMade-threePointFieldGoalsAttempted");
    const [ftm, fta] = pair("freeThrowsMade-freeThrowsAttempted");
    const n = (k) => (s[k] == null || s[k] === "" ? null : Number(s[k]));
    out[mapTri(t.team?.abbreviation)] = {
      fgm, fga, fg3m, fg3a, ftm, fta,
      oreb: n("offensiveRebounds"), dreb: n("defensiveRebounds"), reb: n("totalRebounds"),
      ast: n("assists"), stl: n("steals"), blk: n("blocks"),
    };
  }
  return out;
}
