// Basketball opponent-factor model, step 2. Pure: fit on game-log rows from
// data/basketball/<league>-<season>.json (api/_lib/basketball/gamelogs.js),
// project a player-game's expected stat.
//
//   expected = player rate/min × minutes × pace × team factor × position factor
//
//   rate      player's per-minute rate this season, shrunk toward his
//             position group's rate (RATE_N0 minutes); last season's rate
//             counts at PRIOR_RATE_WEIGHT when he has one
//   pace      predicted game possessions / his team's average possessions,
//             predicted = team avg × opponent avg / league avg (each shrunk)
//   team      Σ actual / Σ expected allowed by that defense (expected from
//             rate × minutes × pace), shrunk toward the prior (last season's
//             factor for NBA, 1 for WNBA) with weight g / (g + kTeam)
//   position  same ratio for the defense × position group, after the team
//             factor, shrunk toward 1 with g / (g + kPos)
//
// kTeam / kPos are in games and chosen by the walk-forward backtest
// (scripts/backtest-basketball-opponent.mjs). 2026-10-18, mean log loss over
// 11 stats at a synthetic line (players ≥ 10 min, actual minutes):
//   NBA 2025-26   base 0.66821  pace 0.66745  team 0.66579  (+pos ≤ 0.00004)
//   WNBA 2026     base 0.66150  pace 0.66072  team 0.65915  (+pos ≈ 0)
// kTeam 15–25 best in both; the position layer never beat team-only by more
// than noise (half-season splits agree: team-level r 0.6–0.86, position
// splits mostly noise), so kPos defaults to off. Gains start ~game 11;
// games 1–10 gain ~nothing whatever last season's weight.

import { statOf } from "./gamelogs.js";

export const OPP_STATS = ["pts", "reb", "ast", "fg3m", "fg3a", "stl", "blk", "tov", "fta"];
// PrizePicks combos are sums of the base stats.
export const COMBOS = { pra: ["pts", "reb", "ast"], pr: ["pts", "reb"], pa: ["pts", "ast"], ra: ["reb", "ast"] };

export const OPP_PARAMS = {
  kTeam: 15,              // games: weight g/(g+k) on this season's team factor
  kPos: Infinity,         // games: position deviation shrink toward 1 (off — see header)
  rateN0: 240,            // minutes of group-average prior on a player's rate
  priorRateWeight: 0.35,  // last-season minutes count at this weight
  paceK: 10,              // games: team pace shrink toward league average
  priorTeamWeight: 0.5,   // share of last season's team factor (minus 1) kept as the prior (0/0.5/1 within 0.0005)
};

const sum = (a) => a.reduce((x, y) => x + y, 0);

/**
 * @param {Object} cur   current-season snapshot { players, team_games, rows }
 * @param {Object} [opts]
 * @param {string} [opts.before]  fit only on games with date < before
 * @param {Object} [opts.prior]   last season's FITTED model (NBA) — team
 *                                factors and player rates carry over
 * @param {Object} [opts.params]
 */
export function fitOpponentModel(cur, { before = null, prior = null, params = OPP_PARAMS } = {}) {
  const P = { ...OPP_PARAMS, ...params };
  const tgAll = new Map(cur.team_games.map((t) => [`${t.game_id}|${t.team}`, t]));
  const tgs = cur.team_games.filter((t) => !before || t.date < before);
  const keep = new Set(tgs.map((t) => `${t.game_id}|${t.team}`));
  const rows = cur.rows.filter((r) => keep.has(`${r.game_id}|${r.team}`) && statOf(r, "min") > 0);
  const groupOf = (id) => cur.players[id]?.group ?? prior?.players?.[id]?.group ?? "W";

  // Pace: team average possessions, shrunk toward the league.
  const leaguePoss = tgs.length ? sum(tgs.map((t) => t.poss)) / tgs.length : (prior?.leaguePoss ?? 100);
  const paceAcc = new Map();
  for (const t of tgs) { const a = paceAcc.get(t.team) ?? { s: 0, n: 0 }; a.s += t.poss; a.n++; paceAcc.set(t.team, a); }
  const pace = {};
  for (const [team, a] of paceAcc) pace[team] = (a.s + P.paceK * leaguePoss) / (a.n + P.paceK);

  // Player rates per minute, shrunk toward the group rate.
  const groupRate = {}, playerAcc = new Map();
  for (const r of rows) {
    const g = groupOf(r.player_id);
    const ga = (groupRate[g] ??= { min: 0 });
    const pa = playerAcc.get(r.player_id) ?? { min: 0 };
    ga.min += r.min; pa.min += r.min;
    for (const s of OPP_STATS) { ga[s] = (ga[s] ?? 0) + statOf(r, s); pa[s] = (pa[s] ?? 0) + statOf(r, s); }
    playerAcc.set(r.player_id, pa);
  }
  const rateOf = (pid) => {
    const g = groupOf(pid), ga = groupRate[g], pa = playerAcc.get(pid), pp = prior?.rates?.[pid];
    const out = {};
    for (const s of OPP_STATS) {
      const gr = ga?.min ? ga[s] / ga.min : (prior?.groupRate?.[g]?.[s] ?? 0);
      const pm = pp ? pp.min * P.priorRateWeight : 0;
      out[s] = ((pa?.[s] ?? 0) + (pp ? pp[s] * pm : 0) + P.rateN0 * gr) / ((pa?.min ?? 0) + pm + P.rateN0);
    }
    return out;
  };
  const rates = {};
  for (const pid of new Set([...playerAcc.keys(), ...Object.keys(prior?.rates ?? {})])) {
    const pa = playerAcc.get(pid), pp = prior?.rates?.[pid];
    rates[pid] = { ...rateOf(pid), min: (pa?.min ?? 0) + (pp ? pp.min * P.priorRateWeight : 0) };
  }
  const groupRates = Object.fromEntries(Object.entries(groupRate).map(([g, a]) => [g, Object.fromEntries(OPP_STATS.map((s) => [s, a[s] / a.min]))]));

  // Expected (no opponent) per training row, then defense ratios.
  const baseExp = (r, t) => {
    const rt = rates[r.player_id];
    const pf = (pace[t.team] && pace[t.opponent]) ? (pace[t.team] * pace[t.opponent] / leaguePoss) / pace[t.team] : 1;
    return Object.fromEntries(OPP_STATS.map((s) => [s, rt[s] * r.min * pf]));
  };
  const teamAcc = {}, games = {};
  for (const t of tgs) games[t.opponent] = (games[t.opponent] ?? 0) + 1;
  const expRows = rows.map((r) => { const t = tgAll.get(`${r.game_id}|${r.team}`); return { r, t, e: baseExp(r, t), g: groupOf(r.player_id) }; });
  for (const { r, t, e } of expRows) {
    const a = (teamAcc[t.opponent] ??= {});
    for (const s of OPP_STATS) { const x = (a[s] ??= { y: 0, e: 0 }); x.y += statOf(r, s); x.e += e[s]; }
  }
  const team = {};
  for (const [d, a] of Object.entries(teamAcc)) {
    const g = games[d] ?? 0, w = g / (g + P.kTeam);
    team[d] = Object.fromEntries(OPP_STATS.map((s) => {
      const raw = a[s].e > 0 ? a[s].y / a[s].e : 1;
      const pr = 1 + P.priorTeamWeight * ((prior?.team?.[d]?.[s] ?? 1) - 1);
      return [s, w * raw + (1 - w) * pr];
    }));
  }
  const posAcc = {};
  for (const { r, t, e, g } of expRows) {
    const a = ((posAcc[t.opponent] ??= {})[g] ??= {});
    const tf = team[t.opponent];
    for (const s of OPP_STATS) { const x = (a[s] ??= { y: 0, e: 0 }); x.y += statOf(r, s); x.e += e[s] * (tf?.[s] ?? 1); }
  }
  const pos = {};
  for (const [d, byG] of Object.entries(posAcc)) {
    const g = games[d] ?? 0, w = g / (g + P.kPos);
    pos[d] = {};
    for (const [grp, a] of Object.entries(byG)) {
      pos[d][grp] = Object.fromEntries(OPP_STATS.map((s) => [s, w * (a[s].e > 0 ? a[s].y / a[s].e : 1) + (1 - w)]));
    }
  }
  return { params: P, before, leaguePoss, pace, rates, groupRate: groupRates, team, pos, games, players: cur.players };
}

/**
 * Expected stat for one player-game. layers: "base" (rate × minutes),
 * "pace", "team" (pace + team), "pos" (pace + team + position).
 */
export function projectOpp(model, { playerId, team, opponent, minutes, group = null }, layers = "pos") {
  const rt = model.rates[playerId];
  const grp = group ?? model.players?.[playerId]?.group ?? "W";
  const base = rt ?? model.groupRate[grp];
  if (!base) return null;
  const usePace = layers !== "base", useTeam = layers === "team" || layers === "pos", usePos = layers === "pos";
  const pt = model.pace[team], po = model.pace[opponent];
  const pf = usePace && pt && po ? (pt * po / model.leaguePoss) / pt : 1;
  const out = {};
  for (const s of OPP_STATS) {
    const tf = useTeam ? (model.team[opponent]?.[s] ?? 1) : 1;
    const qf = usePos ? (model.pos[opponent]?.[grp]?.[s] ?? 1) : 1;
    out[s] = base[s] * minutes * pf * tf * qf;
  }
  for (const [c, parts] of Object.entries(COMBOS)) out[c] = sum(parts.map((p) => out[p]));
  return out;
}
