// Basketball probability pipeline, step 1: the predictive distribution of a
// player's stat in his next game. Pure. Replaces the engine's
// Normal(mean, one fixed σ per stat) — which gives a 2-rebound guard and a
// 12-rebound center the same σ (3.81) and uses a placeholder σ = 8 for
// Blocks+Steals / 3PA / FGA / Fantasy — with a count distribution whose
// spread scales with the player's own mean and minutes.
//
//   minutes   recency-weighted mean of his last MIN_WINDOW games played
//             (weights MIN_DECAY^k), plus the empirical spread of those
//             minutes for the mixture
//   mean      opponent.js projection at those minutes (rate × min × pace ×
//             defense), or any caller-supplied per-minute rate
//   shape     negative binomial with a per-stat dispersion r (var = μ + μ²/r)
//             fitted on last season's residuals; optionally mixed over his
//             recent minutes (bench/foul-trouble volatility)
//
// Combos and Fantasy Score are priced as one NB on the summed mean with
// their own fitted dispersion (simple, and the backtest is the judge).

import { lineProbs, mixtureLineProbs } from "../distributions.js";
import { statOf } from "./gamelogs.js";
import { projectOpp, fitOpponentModel, PROP_WEIGHTS } from "./opponent.js";

export const MIN_WINDOW = 10;
export const MIN_DECAY = 0.85;

// PrizePicks basketball prop → internal key used for dispersion + value.
export const PROP_KEY = {
  "Points": "pts", "Rebounds": "reb", "Assists": "ast", "PRA": "pra", "PR": "pr", "PA": "pa", "RA": "ra",
  "3-Pointers Made": "fg3m", "3-Pointers Attempted": "fg3a", "FG Attempted": "fga",
  "Blocks+Steals": "bs", "Fantasy Score": "fs",
};
const KEY_PROP = Object.fromEntries(Object.entries(PROP_KEY).map(([p, k]) => [k, p]));
export const DIST_KEYS = Object.values(PROP_KEY);

/** Actual value of a prop key from a game-log row. */
export function valueOf(row, key) {
  const w = PROP_WEIGHTS[KEY_PROP[key]];
  return w ? Object.entries(w).reduce((a, [s, k]) => a + k * statOf(row, s), 0) : 0;
}

/**
 * Minutes profile from a player's prior games (newest last).
 * @returns {{ mean:number, samples:number[], n:number }|null}
 */
export function minutesProfile(priorMinutes, { window = MIN_WINDOW, decay = MIN_DECAY } = {}) {
  const recent = priorMinutes.filter((m) => m > 0).slice(-window);
  if (!recent.length) return null;
  let sw = 0, s = 0;
  recent.forEach((m, i) => { const w = decay ** (recent.length - 1 - i); sw += w; s += w * m; });
  return { mean: s / sw, samples: recent, n: recent.length };
}

/** Expected value of a prop key at given minutes from the opponent model. */
export function meanAt(model, ctx, key, minutes, layers = "team") {
  const p = projectOpp(model, { ...ctx, minutes }, layers);
  if (!p) return null;
  const w = PROP_WEIGHTS[KEY_PROP[key]];
  return Object.entries(w).reduce((a, [s, k]) => a + k * (p[s] ?? 0), 0);
}

/**
 * P(over line) under the chosen shape.
 *   shape "nb"     NB(μ at mean minutes, r)
 *   shape "nbmix"  equal-weight mixture over the recent minutes samples,
 *                  each NB(μ at that minute count, r)
 */
export function probOver({ model, ctx, key, line, minutes, r, shape = "nbmix", layers = "team" }) {
  if (!minutes || !(r > 0)) return null;
  if (shape === "nb") {
    const mu = meanAt(model, ctx, key, minutes.mean, layers);
    return mu == null ? null : lineProbs(line, Math.max(1e-3, mu), r).over;
  }
  // Rescale the samples so their mean matches the recency-weighted mean.
  const sMean = minutes.samples.reduce((a, b) => a + b, 0) / minutes.samples.length;
  const scale = sMean > 0 ? minutes.mean / sMean : 1;
  const scen = [];
  for (const m of minutes.samples) {
    const mu = meanAt(model, ctx, key, m * scale, layers);
    if (mu == null) return null;
    scen.push({ p: 1 / minutes.samples.length, mu: Math.max(1e-3, mu), r });
  }
  return mixtureLineProbs(line, scen).over;
}

/**
 * Method-of-moments NB dispersion per key from (μ, y) pairs:
 * r = Σμ² / Σ((y − μ)² − μ). Large r → Poisson-like.
 */
export function fitDispersion(pairs) {
  let num = 0, den = 0;
  for (const { mu, y } of pairs) { num += mu * mu; den += (y - mu) ** 2 - mu; }
  return den > 0 ? Math.max(0.5, num / den) : 1e6;
}

// ── Fitting (shared by scripts/backtest-basketball-dist.mjs and the daily
// artifact build) ────────────────────────────────────────────────────────

export const MIN_PRIOR_GAMES = 5;
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

/**
 * Walk a season: yield every eligible player-game (played, ≥ MIN_PRIOR_GAMES
 * earlier games this season) with the inputs a live prediction would have —
 * opponent model refit every `step` days on games before the window, the
 * player's earlier games and his minutes profile. History updates only after
 * a whole window is predicted (no same-window leakage).
 */
export function* walkSeason(snap, { priorModel = null, step = 7, fit = fitOpponentModel } = {}) {
  const tg = new Map(snap.team_games.map((t) => [`${t.game_id}|${t.team}`, t]));
  const rows = snap.rows.filter((r) => tg.has(`${r.game_id}|${r.team}`)).map((r) => ({ r, t: tg.get(`${r.game_id}|${r.team}`) }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date));
  const hist = new Map();
  const dates = [...new Set(rows.map((x) => x.t.date))];
  let i = 0;
  for (let d0 = dates[0]; d0 <= dates.at(-1); d0 = addDays(d0, step)) {
    const d1 = addDays(d0, step);
    const model = fit(snap, { before: d0, prior: priorModel });
    const batch = [];
    while (i < rows.length && rows[i].t.date < d1) batch.push(rows[i++]);
    for (const { r, t } of batch) {
      const h = hist.get(r.player_id) ?? [];
      if (statOf(r, "min") > 0 && h.length >= MIN_PRIOR_GAMES) {
        yield { r, t, model, h, minutes: minutesProfile(h.map((g) => g.min)), ctx: { playerId: r.player_id, team: t.team, opponent: t.opponent } };
      }
    }
    for (const { r } of batch) if (statOf(r, "min") > 0) { const h = hist.get(r.player_id) ?? []; h.push({ min: r.min, row: r }); hist.set(r.player_id, h); }
  }
}

/** Engine-style recency mean: ½ last-5 average + ½ season-to-date average. */
export function engineMean(history, key) {
  const vals = history.map((g) => valueOf(g.row, key));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return 0.5 * avg(vals.slice(-5)) + 0.5 * avg(vals);
}

/** Opponent + pace multiplier for a prop key (ratio, so minutes cancel). */
export function matchupRatio(model, ctx, key, minutes) {
  const b = meanAt(model, ctx, key, minutes, "base"), t = meanAt(model, ctx, key, minutes, "team");
  return b > 0 && t != null ? t / b : 1;
}

/**
 * Fit the calibrated distribution on a finished season (walk-forward):
 *   r_eng  NB dispersion around the engine-style mean alone
 *   c      per-key mean multiplier Σy / Σ(engine mean × matchup)
 *   r      NB dispersion around the calibrated mean (engine × matchup × c)
 * Backtest 2026-10-19 (fit on the prior season, scored on the next):
 * synthetic-line log loss NBA main 0.6902 → 0.6852, WNBA 0.6900 → 0.6828;
 * real graded WNBA lines (engine's logged mean) 0.8236 → 0.7510.
 */
export function fitDistParams(snap, { priorModel = null, step = 7, fit = fitOpponentModel } = {}) {
  const eng = {}, cal = {};
  for (const x of walkSeason(snap, { priorModel, step, fit })) {
    for (const key of DIST_KEYS) {
      const y = valueOf(x.r, key), em = Math.max(1e-3, engineMean(x.h, key));
      (eng[key] ??= []).push({ mu: em, y });
      (cal[key] ??= []).push({ mu: Math.max(1e-3, em * matchupRatio(x.model, x.ctx, key, x.minutes.mean)), y });
    }
  }
  const out = { r_eng: {}, c: {}, r: {}, n: {} };
  for (const key of DIST_KEYS) {
    const p = cal[key] ?? [];
    out.r_eng[key] = +fitDispersion(eng[key] ?? []).toFixed(3);
    out.c[key] = +(p.reduce((a, x) => a + x.y, 0) / Math.max(1e-9, p.reduce((a, x) => a + x.mu, 0))).toFixed(4);
    out.r[key] = +fitDispersion(p.map((x) => ({ mu: x.mu * out.c[key], y: x.y }))).toFixed(3);
    out.n[key] = p.length;
  }
  return out;
}

/** Calibrated P(over) for a prop given an engine mean and its matchup factor. */
export function calibratedProbOver({ params, key, mean, factor = 1, line }) {
  const r = params?.r?.[key], c = params?.c?.[key];
  if (!(r > 0) || !(c > 0) || typeof mean !== "number" || typeof line !== "number") return null;
  const mu = Math.max(1e-3, mean * factor * c);
  return { p_over: lineProbs(line, mu, r).over, mean: mu };
}

/**
 * Move a book's fair P(over) at its own line to another line through the
 * fitted negative binomial: find μ with NB(μ, r).over(bookLine) = pOver
 * (monotone in μ — bisection), then read P(over) at targetLine. Replaces the
 * fixed-σ normal shift in odds.js for the SHADOW pipeline, so goblin/demon
 * lines (typically 2–7 points from the book line) get a skewed, mean-scaled
 * tail. Returns pOver unchanged when the lines match. Clamped [0.01, 0.99].
 */
export function nbShiftOver({ pOver, bookLine, targetLine, r }) {
  if (typeof pOver !== "number" || typeof bookLine !== "number" || typeof targetLine !== "number" || !(r > 0)) return null;
  const p = Math.min(0.99, Math.max(0.01, pOver));
  if (targetLine === bookLine) return p;
  const over = (mu) => lineProbs(bookLine, mu, r).over;
  let lo = 1e-3, hi = Math.max(5, 4 * bookLine + 10);
  while (over(hi) < p && hi < 1e4) hi *= 2;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (over(mid) < p) lo = mid; else hi = mid; }
  return Math.min(0.99, Math.max(0.01, lineProbs(targetLine, (lo + hi) / 2, r).over));
}
