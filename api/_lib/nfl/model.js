// NFL player-prop model (step 2 of the NFL plan). Pure: fit on the nflverse
// snapshot (data/nfl-player-games.json + data/nfl-games.json), price with the
// fitted artifact.
//
// Structure — for a player in an upcoming game:
//
//   TEAM volume   pass attempts / carries / sacks for the team in this game:
//                 league regression on the market (expected margin, total)
//                 + the team's own tendency + the opponent's allowed effect.
//                 Both effects are residuals shrunk toward 0 with an
//                 empirical-Bayes weight n/(n + k), k from method of moments.
//                 (Market lines explain little volume — R² ≈ 0.03 — but they
//                 move yards and points, so efficiency rides on them too.)
//   SHARE         player's share of team targets / carries / pass attempts in
//                 games he played, Beta-style shrink toward the position prior
//                 (strength n0 in team-volume units). 2025 counts at PRIOR_W,
//                 lower again if the player changed teams.
//   EFFICIENCY    catch rate, yards per catch, yards per carry, QB completion
//                 rate / yards per completion / TD and INT rates, TD rates per
//                 target and carry — each shrunk toward the position or league
//                 rate; TD rates scale with the market's implied team points.
//   SIMULATION    seeded, per player: team volume ~ Normal(μ, σ_team) →
//                 targets/carries/attempts ~ NB(share × volume, r) →
//                 receptions ~ Binomial(targets, catch) → yards = Σ per-catch
//                 Gamma(k, θ) (sum = Gamma(n·k, θ)), rush yards ~ Normal(n·ypc,
//                 n·σ_carry²), TDs/INTs ~ Poisson. Every stat of one player
//                 comes from the same draws, so combos (Rush+Rec, Pass+Rush,
//                 Fantasy) are consistent. Prices are conditional on playing
//                 (PrizePicks voids a DNP).
//   DEFENSE/K     tackles+assists and sacks per defensive snap × expected snaps;
//                 kicker FG ~ Poisson(λ ∝ implied points), PAT ~ team TDs.
//
// Every tunable number is in NFL_MODEL_PARAMS; the backtest
// (scripts/backtest-nfl-model.mjs) is the judge.

import { mulberry32, seedFrom, sampleCount, sampleBinomial, sampleGamma, sampleNormal, samplePoisson, sampleLineProbs, quantile } from "../distributions.js";

export const MODEL_VERSION = 1;

export const NFL_MODEL_PARAMS = {
  priorSeasonWeight: 0.25,    // 2025 rows vs 2026 (backtest: 0.2–0.25 beat 0.4 on 2026 wk 3–5)
  teamChangeWeight: 0.35,     // extra multiplier on prior-season SHARE rows when the player changed teams
  weekDecay: 0.85,            // within-season recency: weight × decay^(weeks ago) (0.8–0.92 tie on 2025 wk 4–17; 0.7 worse)
  minTeamShrink: 3,           // floor on the EB k for team effects (team-games)
  seasonShrinkK: 20,          // current-season level shift, shrunk n/(n + k) in team-games
                              // (2026 throws ~1 more pass a game than 2025)
  shareN0: { targets: 45, rush_att: 40, pass_att: 25 }, // prior strength, team-volume units
  catchN0: 40, yprN0: 30, ypcN0: 50, recTdN0: 150, rushTdN0: 120,
  qbCmpN0: 150, qbYpcN0: 80, qbTdN0: 300, qbIntN0: 300,
  perCatchK: 1.0,             // per-reception yards ~ Gamma(k, ypr/k)  (single-catch games: mean 10.4, sd 10.3)
  perCompletionK: 1.2,        // per-completion yards for QBs
  perCarrySd: 6.5,            // per-carry rushing yards sd (single-carry games: sd 6.7)
  shareR: { targets: 6, rush_att: 5, pass_att: 40 }, // NB size for player counts given volume (refit in fit)
  fumblePerTouch: 0.006,
  sims: 20000,
};

// Internal stat keys priced by the model. PrizePicks spellings are mapped in
// verdict.js once the NFL board is captured (step 3/4).
export const MODEL_STATS = [
  "pass_yds", "pass_att", "completions", "pass_td", "pass_int",
  "rush_yds", "rush_att", "rec_yds", "rec", "targets",
  "rush_rec_yds", "pass_rush_yds", "rush_rec_td", "fantasy",
  "tackles_ast", "def_sacks", "fg_made", "kicking_pts",
];

// PrizePicks NFL Fantasy Score (offense).
export const FANTASY_WEIGHTS = { pass_yds: 0.04, pass_td: 4, pass_int: -1, rush_yds: 0.1, rush_td: 6, rec: 1, rec_yds: 0.1, rec_td: 6, fum_lost: -1 };

const s = (r, f) => r?.[f] ?? 0;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ─── Team-game table ─────────────────────────────────────────────────────────

const TEAM_STATS = ["pass_att", "rush_att", "targets", "sacks_taken", "pass_yds", "rush_yds", "completions", "pass_td", "rush_td", "rec_td", "tackles", "fg_made", "pat_made", "points"];

function marginFor(game, team) {
  if (game?.spread_line == null) return 0;
  return game.home === team ? game.spread_line : -game.spread_line;
}

/** Aggregate player rows into team-games with market context. */
export function buildTeamGames(rows, gamesById) {
  const tg = new Map();
  for (const r of rows) {
    const k = `${r.game_id}|${r.team}`;
    let t = tg.get(k);
    if (!t) {
      const g = gamesById.get(r.game_id);
      if (!g) continue;
      const home = g.home === r.team;
      t = { game_id: r.game_id, season: r.season, week: r.week, team: r.team, opp: r.opponent, home,
        margin: marginFor(g, r.team), total: g.total_line ?? null,
        points: home ? g.home_score : g.away_score };
      for (const f of TEAM_STATS) if (f !== "points") t[f] = 0;
      tg.set(k, t);
    }
    for (const f of TEAM_STATS) if (f !== "points" && f !== "tackles") t[f] += s(r, f);
    t.tackles += s(r, "tackles_solo") + s(r, "tackle_ast");
  }
  return [...tg.values()].filter((t) => t.total != null && t.points != null);
}

// Weighted least squares y ~ 1 + margin + total.
function fitMarketRegression(tgs, f, w) {
  const X = tgs.map((t) => [1, t.margin, t.total]);
  const y = tgs.map((t) => t[f]);
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (let i = 0; i < X.length; i++) for (let a = 0; a < 3; a++) { b[a] += w[i] * X[i][a] * y[i]; for (let c = 0; c < 3; c++) A[a][c] += w[i] * X[i][a] * X[i][c]; }
  // Gauss-Jordan.
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i; for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    for (let k = 0; k < 3; k++) if (k !== i) { const q = M[k][i] / M[i][i]; for (let j = i; j < 4; j++) M[k][j] -= q * M[i][j]; }
  }
  const coef = M.map((r, i) => r[3] / r[i]);
  const pred = (m, tot) => coef[0] + coef[1] * m + coef[2] * tot;
  const res = tgs.map((t) => t[f] - pred(t.margin, t.total));
  const W = sum(w);
  const sigma = Math.sqrt(sum(res.map((e, i) => w[i] * e * e)) / W);
  return { coef, sigma, res };
}

// Additive two-way effects on regression residuals: e ≈ off_team + def_opp,
// each shrunk n/(n + k). k = σ²/τ² by method of moments, floored.
function fitEffects(tgs, res, w, minK) {
  const teams = [...new Set(tgs.flatMap((t) => [t.team, t.opp]))];
  const off = Object.fromEntries(teams.map((x) => [x, 0]));
  const def = Object.fromEntries(teams.map((x) => [x, 0]));
  const sigma2 = sum(res.map((e, i) => w[i] * e * e)) / sum(w);
  // τ² from the spread of raw team means.
  const byTeam = new Map();
  tgs.forEach((t, i) => { const a = byTeam.get(t.team) ?? { sw: 0, se: 0 }; a.sw += w[i]; a.se += w[i] * res[i]; byTeam.set(t.team, a); });
  const means = [...byTeam.values()].map((a) => a.se / a.sw);
  const nBar = sum([...byTeam.values()].map((a) => a.sw)) / byTeam.size;
  const tau2 = Math.max(1e-6, sum(means.map((m) => m * m)) / means.length - sigma2 / nBar);
  const k = Math.max(minK, sigma2 / tau2);
  for (let it = 0; it < 20; it++) {
    for (const [obj, other, side] of [[off, def, "team"], [def, off, "opp"]]) {
      const acc = new Map();
      tgs.forEach((t, i) => {
        const key = side === "team" ? t.team : t.opp;
        const otherKey = side === "team" ? t.opp : t.team;
        const a = acc.get(key) ?? { sw: 0, se: 0 };
        a.sw += w[i]; a.se += w[i] * (res[i] - other[otherKey]);
        acc.set(key, a);
      });
      for (const [key, a] of acc) obj[key] = a.se / (a.sw + k);
    }
  }
  return { off, def, k, sigma: Math.sqrt(sigma2) };
}

// ─── Fit ─────────────────────────────────────────────────────────────────────

const before = (r, asOf) => !asOf || r.season < asOf.season || (r.season === asOf.season && r.week < asOf.week);

/**
 * @param {{ rows:Object[], games:Object[], players:Object }} snapshot
 * @param {{ asOf?: { season:number, week:number }, params?: Object }} [opts]
 *   asOf: fit only on games strictly before that week (walk-forward backtest)
 */
export function fitModel(snapshot, { asOf = null, params = NFL_MODEL_PARAMS } = {}) {
  const P = params;
  const gamesById = new Map(snapshot.games.map((g) => [g.game_id, g]));
  const rows = snapshot.rows.filter((r) => before(r, asOf));
  const current = asOf?.season ?? Math.max(...rows.map((r) => r.season));
  const lastWeek = Math.max(...rows.filter((r) => r.season === current).map((r) => r.week), 0);
  const weightOf = (season, week) =>
    season === current ? Math.pow(P.weekDecay, Math.max(0, lastWeek - week)) : P.priorSeasonWeight * Math.pow(P.weekDecay, 4);

  // Team level.
  const tgs = buildTeamGames(rows, gamesById);
  const tw = tgs.map((t) => weightOf(t.season, t.week));
  const team = {};
  for (const f of ["pass_att", "rush_att", "sacks_taken", "pass_yds", "rush_yds", "points", "tackles", "fg_made"]) {
    const reg = fitMarketRegression(tgs, f, tw);
    // Season level: mean residual of current-season team-games, shrunk.
    const cur = reg.res.filter((_, i) => tgs[i].season === current);
    const seasonAdj = cur.length ? (cur.reduce((a, b) => a + b, 0)) / (cur.length + P.seasonShrinkK) : 0;
    const res = reg.res.map((e, i) => (tgs[i].season === current ? e - seasonAdj : e));
    const eff = fitEffects(tgs, res, tw, P.minTeamShrink);
    // Game-to-game σ AFTER the team + opponent effects (the regression σ
    // also carries the between-team spread, which the effects already price).
    const rem = res.map((e, i) => e - (eff.off[tgs[i].team] ?? 0) - (eff.def[tgs[i].opp] ?? 0));
    const sigma = Math.sqrt(rem.reduce((a, e, i) => a + tw[i] * e * e, 0) / sum(tw));
    team[f] = { coef: reg.coef, seasonAdj, sigma, k: eff.k, off: eff.off, def: eff.def };
  }
  const league = {
    points: sum(tgs.map((t) => t.points)) / tgs.length,
    passTdPerPoint: sum(tgs.map((t) => t.pass_td)) / sum(tgs.map((t) => t.points)),
    rushTdPerPoint: sum(tgs.map((t) => t.rush_td)) / sum(tgs.map((t) => t.points)),
    patPerTd: sum(tgs.map((t) => t.pat_made)) / Math.max(1, sum(tgs.map((t) => t.pass_td + t.rush_td))),
  };

  // Player level: accumulate weighted exposures per player.
  const tgByKey = new Map(tgs.map((t) => [`${t.game_id}|${t.team}`, t]));
  const latestTeam = new Map();
  for (const r of rows) { const p = latestTeam.get(r.player_id); if (!p || r.season > p.season || (r.season === p.season && r.week > p.week)) latestTeam.set(r.player_id, r); }
  const acc = new Map();
  for (const r of rows) {
    const t = tgByKey.get(`${r.game_id}|${r.team}`);
    if (!t) continue;
    const pos = snapshot.players[r.player_id]?.position ?? r.position ?? "?";
    const played = (r.off_pct ?? 0) > 0.05 || s(r, "targets") + s(r, "rush_att") + s(r, "pass_att") > 0;
    const defPlayed = (r.def_pct ?? 0) > 0.05 || s(r, "tackles_solo") + s(r, "tackle_ast") > 0;
    let w = weightOf(r.season, r.week);
    const last = latestTeam.get(r.player_id);
    const changed = r.season !== current && last && last.team !== r.team;
    const a = acc.get(r.player_id) ?? { pos, team: last?.team, g: 0, gDef: 0, lastSeason: last?.season, lastWeek: last?.week,
      tgt: 0, tTgt: 0, car: 0, tCar: 0, att: 0, tAtt: 0, rec: 0, recY: 0, rushY: 0, recTd: 0, rushTd: 0,
      cmp: 0, passY: 0, passTd: 0, int: 0, rTgt: 0, rCar: 0, rAtt: 0, tack: 0, sacks: 0, defPct: 0, wDef: 0, fg: 0, pat: 0, wK: 0, offPct: 0, wOff: 0,
      // Snap-weighted team volume (Σ off_pct × team volume) for the role prior.
      sTgt: 0, sCar: 0, sAtt: 0, tTgtS: 0, tCarS: 0, tAttS: 0,
      // QB attempts in games he STARTED (≥50% snaps) — the role is binary.
      attStart: 0, tAttStart: 0, starts: 0 };
    if (played) {
      const ws = changed ? w * P.teamChangeWeight : w;
      a.g += w;
      a.tgt += ws * s(r, "targets"); a.tTgt += ws * t.targets;
      a.car += ws * s(r, "rush_att"); a.tCar += ws * t.rush_att;
      a.att += ws * s(r, "pass_att"); a.tAtt += ws * t.pass_att;
      // Efficiency is a player trait — not discounted for a team change.
      a.rTgt += w * s(r, "targets"); a.rec += w * s(r, "rec"); a.recY += w * s(r, "rec_yds"); a.recTd += w * s(r, "rec_td");
      a.rCar += w * s(r, "rush_att"); a.rushY += w * s(r, "rush_yds"); a.rushTd += w * s(r, "rush_td");
      a.rAtt += w * s(r, "pass_att"); a.cmp += w * s(r, "completions"); a.passY += w * s(r, "pass_yds"); a.passTd += w * s(r, "pass_td"); a.int += w * s(r, "pass_int");
      if (r.off_pct != null) {
        a.offPct += w * r.off_pct; a.wOff += w;
        a.sTgt += ws * r.off_pct * t.targets; a.tTgtS += ws * t.targets;
        a.sCar += ws * r.off_pct * t.rush_att; a.tCarS += ws * t.rush_att;
        a.sAtt += ws * r.off_pct * t.pass_att; a.tAttS += ws * t.pass_att;
        if (r.off_pct >= 0.5) { a.attStart += ws * s(r, "pass_att"); a.tAttStart += ws * t.pass_att; a.starts += w; }
      }
    }
    if (defPlayed) {
      a.gDef += w;
      a.tack += w * (s(r, "tackles_solo") + s(r, "tackle_ast"));
      a.sacks += w * s(r, "def_sacks");
      if (r.def_pct != null) { a.defPct += w * r.def_pct; a.wDef += w; }
    }
    if (s(r, "fg_att") + s(r, "pat_att") > 0) { a.wK += w; a.fg += w * s(r, "fg_made"); a.pat += w * s(r, "pat_made"); }
    acc.set(r.player_id, a);
  }

  // Position priors (pooled rates over active player-games). Shares get a
  // ROLE prior: the position's share per unit of snap share × the player's
  // own snap share — shrinking a 90%-snap WR1 toward the all-WR average
  // (depth players included) biased every starter low in the backtest.
  const pri = {};
  for (const a of acc.values()) {
    const p = (pri[a.pos] ??= { tgt: 0, tTgt: 0, car: 0, tCar: 0, att: 0, tAtt: 0, rTgt: 0, rec: 0, recY: 0, recTd: 0, rCar: 0, rushY: 0, rushTd: 0, rAtt: 0, cmp: 0, passY: 0, passTd: 0, int: 0, sTgt: 0, sCar: 0, sAtt: 0, attStart: 0, tAttStart: 0 });
    for (const k of Object.keys(p)) p[k] += a[k];
  }
  // Starting QB's share of team pass attempts in his starts (league pooled).
  const starterAttShare = (pri.QB?.attStart ?? 0) / Math.max(1e-9, pri.QB?.tAttStart ?? 0) || 0.97;
  const rolePrior = (pp, p, a) => ({
    tgt: a.tTgtS > 0 ? (p.tgt / Math.max(1e-9, p.sTgt)) * (a.sTgt / a.tTgtS) : pp.tgtShare,
    car: a.tCarS > 0 ? (p.car / Math.max(1e-9, p.sCar)) * (a.sCar / a.tCarS) : pp.carShare,
    att: a.tAttS > 0 ? (p.att / Math.max(1e-9, p.sAtt)) * (a.sAtt / a.tAttS) : pp.attShare,
  });
  const L = pri.QB ?? {};
  const leagueQb = { cmp: L.cmp / Math.max(1, L.rAtt), ypc: L.passY / Math.max(1, L.cmp), td: L.passTd / Math.max(1, L.rAtt), int: L.int / Math.max(1, L.rAtt) };
  const posPrior = (pos) => {
    const p = pri[pos] ?? pri.WR;
    return {
      tgtShare: p.tgt / Math.max(1, p.tTgt), carShare: p.car / Math.max(1, p.tCar), attShare: p.att / Math.max(1, p.tAtt),
      catch: p.rec / Math.max(1, p.rTgt), ypr: p.recY / Math.max(1, p.rec), ypc: p.rushY / Math.max(1, p.rCar),
      recTd: p.recTd / Math.max(1, p.rTgt), rushTd: p.rushTd / Math.max(1, p.rCar),
    };
  };

  const shrink = (x, n, prior, n0) => (x + prior * n0) / (n + n0);
  const players = {};
  for (const [id, a] of acc) {
    if (a.g <= 0 && a.gDef <= 0 && a.wK <= 0) continue;
    const pp = posPrior(a.pos);
    const rp = rolePrior(pp, pri[a.pos] ?? pri.WR, a);
    const N0 = P.shareN0;
    const rec = { pos: a.pos, team: a.team, last: { season: a.lastSeason, week: a.lastWeek }, games: Number(a.g.toFixed(2)) };
    if (a.g > 0) {
      rec.tgtShare = shrink(a.tgt, a.tTgt, rp.tgt, N0.targets);
      rec.carShare = shrink(a.car, a.tCar, rp.car, N0.rush_att);
      rec.attShare = a.pos === "QB" ? shrink(a.att, a.tAtt, rp.att, N0.pass_att) : 0;
      if (a.pos === "QB") {
        // Priced as the starter: share in his starts, shrunk to the league
        // starter share. A QB with no starts in the window keeps the
        // all-games share (the verdict layer decides who starts).
        rec.attShareStart = a.tAttStart > 0 ? shrink(a.attStart, a.tAttStart, starterAttShare, N0.pass_att) : null;
        rec.starts = Number(a.starts.toFixed(2));
      }
      rec.catch = shrink(a.rec, a.rTgt, pp.catch, P.catchN0);
      rec.ypr = shrink(a.recY, a.rec, pp.ypr, P.yprN0);
      rec.ypc = shrink(a.rushY, a.rCar, pp.ypc, P.ypcN0);
      rec.recTd = shrink(a.recTd, a.rTgt, pp.recTd, P.recTdN0);
      rec.rushTd = shrink(a.rushTd, a.rCar, pp.rushTd, P.rushTdN0);
      rec.offPct = a.wOff ? a.offPct / a.wOff : null;
      if (a.pos === "QB") {
        rec.qb = {
          cmp: shrink(a.cmp, a.rAtt, leagueQb.cmp, P.qbCmpN0),
          ypc: shrink(a.passY, a.cmp, leagueQb.ypc, P.qbYpcN0),
          td: shrink(a.passTd, a.rAtt, leagueQb.td, P.qbTdN0),
          int: shrink(a.int, a.rAtt, leagueQb.int, P.qbIntN0),
        };
      }
    }
    if (a.gDef > 0) {
      rec.def = { tackPerG: a.tack / a.gDef, sackPerG: a.sacks / a.gDef, defPct: a.wDef ? a.defPct / a.wDef : null, games: Number(a.gDef.toFixed(2)) };
    }
    if (a.wK > 0) rec.k = { fgPerG: a.fg / a.wK, patPerG: a.pat / a.wK };
    players[id] = rec;
  }

  return { version: MODEL_VERSION, asOf, current, lastWeek, params: P, league, leagueQb, starterAttShare, team, players, fitted_on: tgs.length };
}

// ─── Projection + simulation ─────────────────────────────────────────────────

/** Expected team value for stat f in a game context, plus its residual sd. */
export function teamExpect(model, f, { team, opp, margin, total }) {
  const t = model.team[f];
  if (!t) return null;
  const base = t.coef[0] + (t.seasonAdj ?? 0) + t.coef[1] * margin + t.coef[2] * total;
  return { mean: Math.max(0, base + (t.off[team] ?? 0) + (t.def[opp] ?? 0)), sigma: t.sigma };
}

/**
 * Game context for a team: market margin/total (from the game row's closing
 * or current lines) → implied points.
 * @param {{ team:string, opp:string, spreadLineHome:number, total:number, home:boolean }} g
 */
export function gameContext({ team, opp, spreadLineHome, total, home }) {
  const margin = (home ? 1 : -1) * (spreadLineHome ?? 0);
  return { team, opp, margin, total, implied: total / 2 + margin / 2 };
}

/**
 * Simulate one player's stat line in a game (conditional on playing).
 * @returns {null | { draws: Object<string, number[]>, mean: Object<string, number>, pos:string }}
 */
export function simulatePlayer(model, playerId, ctx, { sims = model.params.sims, seed = null, shareScale = 1 } = {}) {
  const p = model.players[playerId];
  if (!p) return null;
  const P = model.params;
  const rng = mulberry32(seed ?? seedFrom(`${playerId}|${ctx.team}|${ctx.opp}|${ctx.margin}|${ctx.total}`));
  const vol = (f) => teamExpect(model, f, ctx);
  const passV = vol("pass_att"), rushV = vol("rush_att"), tackV = vol("tackles");
  // The opponent's offense drives a defender's tackle chances.
  const oppCtx = { team: ctx.opp, opp: ctx.team, margin: -ctx.margin, total: ctx.total };
  const oppPlays = (teamExpect(model, "pass_att", oppCtx)?.mean ?? 32) + (teamExpect(model, "rush_att", oppCtx)?.mean ?? 27);
  const leaguePlays = 59;
  const ptsScale = clamp(ctx.implied / model.league.points, 0.5, 1.8);
  // Targets ≈ 0.95 × attempts (throwaways, spikes) — measured share of team
  // targets already lives in tgtShare, so scale the team target pool off
  // attempts by the league ratio.
  const tgtPerAtt = 0.95;

  const out = { pass_yds: [], pass_att: [], completions: [], pass_td: [], pass_int: [], rush_yds: [], rush_att: [], rec_yds: [], rec: [], targets: [], rush_rec_yds: [], pass_rush_yds: [], rush_rec_td: [], fantasy: [], tackles_ast: [], def_sacks: [], fg_made: [], kicking_pts: [] };
  const hasOff = p.games > 0;
  for (let i = 0; i < sims; i++) {
    let passAtt = 0, cmp = 0, passY = 0, passTd = 0, int = 0, car = 0, rushY = 0, rushTd = 0, tgt = 0, rec = 0, recY = 0, recTd = 0;
    if (hasOff) {
      const teamPass = Math.max(5, passV.mean + passV.sigma * sampleNormal(rng));
      const teamRush = Math.max(5, rushV.mean + rushV.sigma * sampleNormal(rng));
      const attShare = p.attShareStart ?? p.attShare;
      if (p.qb && attShare > 0) {
        passAtt = sampleCount(teamPass * attShare * shareScale, P.shareR.pass_att, rng);
        cmp = sampleBinomial(passAtt, p.qb.cmp, rng);
        passY = cmp > 0 ? Math.round(sampleGamma(cmp * P.perCompletionK, p.qb.ypc / P.perCompletionK, rng)) : 0;
        passTd = samplePoisson(passAtt * p.qb.td * ptsScale, rng);
        int = samplePoisson(passAtt * p.qb.int, rng);
      }
      car = sampleCount(teamRush * p.carShare * shareScale, P.shareR.rush_att, rng);
      rushY = car > 0 ? Math.round(car * p.ypc + Math.sqrt(car) * P.perCarrySd * sampleNormal(rng)) : 0;
      rushTd = samplePoisson(car * p.rushTd * ptsScale, rng);
      tgt = sampleCount(teamPass * tgtPerAtt * p.tgtShare * shareScale, P.shareR.targets, rng);
      rec = sampleBinomial(tgt, p.catch, rng);
      recY = rec > 0 ? Math.round(sampleGamma(rec * P.perCatchK, p.ypr / P.perCatchK, rng)) : 0;
      recTd = samplePoisson(tgt * p.recTd * ptsScale, rng);
    }
    const fum = samplePoisson((car + rec) * P.fumblePerTouch, rng);
    out.pass_att.push(passAtt); out.completions.push(cmp); out.pass_yds.push(passY); out.pass_td.push(passTd); out.pass_int.push(int);
    out.rush_att.push(car); out.rush_yds.push(rushY); out.targets.push(tgt); out.rec.push(rec); out.rec_yds.push(recY);
    out.rush_rec_yds.push(rushY + recY); out.pass_rush_yds.push(passY + rushY); out.rush_rec_td.push(rushTd + recTd);
    const W = FANTASY_WEIGHTS;
    out.fantasy.push(Math.round((W.pass_yds * passY + W.pass_td * passTd + W.pass_int * int + W.rush_yds * rushY + W.rush_td * rushTd + W.rec * rec + W.rec_yds * recY + W.rec_td * recTd + W.fum_lost * fum) * 100) / 100);
    if (p.def) {
      const playScale = oppPlays / leaguePlays;
      out.tackles_ast.push(sampleCount(p.def.tackPerG * playScale * (tackV ? 1 : 1), 8, rng));
      out.def_sacks.push(samplePoisson(p.def.sackPerG, rng));
    }
    if (p.k) {
      const fg = samplePoisson(p.k.fgPerG * ptsScale, rng);
      const pat = samplePoisson(p.k.patPerG * ptsScale, rng);
      out.fg_made.push(fg);
      out.kicking_pts.push(3 * fg + pat);
    }
  }
  const draws = Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
  const mean = Object.fromEntries(Object.entries(draws).map(([k, v]) => [k, sum(v) / v.length]));
  const median = Object.fromEntries(Object.entries(draws).map(([k, v]) => [k, quantile(v, 0.5)]));
  return { pos: p.pos, draws, mean, median };
}

/** Price a line off a simulation: P(over), P(under), P(push), conditional on playing. */
export function priceLine(sim, stat, line) {
  const d = sim?.draws?.[stat];
  if (!d?.length) return null;
  return sampleLineProbs(line, d);
}
