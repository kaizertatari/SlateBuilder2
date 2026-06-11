// Native P(over) model — ENGINE_ACCURACY_PLAN Stage 3.
//
// The engine's box-score rules answer "is the line below the adjusted
// baseline?" (a pass/fail). This module answers the actual prop question —
// P(stat > line) — by treating the stat as Normal(mean, σ²) and reading the
// crossing probability. That gives the engine a calibrated PROBABILITY it can
// (a) log + grade natively and (b) compare against the sharp no-vig market to
// confirm a pick or flag a conflict (see rule-projection.js).
//
//   mean  = the engine's own road-adjusted, blend-aware baseline
//           (computeOverBufferCheck.adjusted) — so the model and the rules
//           share one projection.
//   σ     = the live points stddev when available (≥8 games), otherwise the
//           per-league σ implied by the odds line-shift slopes (σ ≈ 0.4/slope,
//           the same variance assumption used to shift book lines). One source
//           of truth for variance across the codebase.
//
// Pure: no fetches, no side effects. Returns null when there's no baseline or
// no σ for the stat (caller no-ops).

import { getBaselines, computeOverBufferCheck } from "./rules/_helpers.js";
import { slopeFor } from "./odds.js";
import { poissonFairOver } from "./poisson.js";
import { PROP_TO_FIELD } from "./prop-types.js";

// Standard normal CDF — Abramowitz & Stegun 26.2.17 (|error| < 7.5e-8).
export function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Standard deviation for a (stat, league). Uses the live points stddev only
 * for exactly "Points" (the variance block is points-specific and would
 * mis-scale a combo); everything else uses the slope-implied per-league σ,
 * which already reflects each stat's own spread.
 * @returns {number|null}
 */
export function sigmaFor(stat, league, groundTruth) {
  if (stat === "Points") {
    const live = groundTruth?.variance?.ppg_stddev;
    if (typeof live === "number" && live > 0) return live;
  }
  const slope = slopeFor(stat, league);
  return typeof slope === "number" && slope > 0 ? 0.4 / slope : null;
}

/**
 * P(stat > line) for X ~ N(mean, σ²). PrizePicks lines sit on the half-point,
 * so no continuity correction. Clamped to [0.01, 0.99].
 * @returns {number|null}
 */
export function probOver({ mean, sigma, line }) {
  if (typeof mean !== "number" || typeof sigma !== "number" || sigma <= 0 || typeof line !== "number") return null;
  return clamp(normCdf((mean - line) / sigma), 0.01, 0.99);
}

/**
 * Project the model probability for a pick. Resolves the mean from the
 * engine's baseline machinery (unless one is supplied) and the σ from
 * sigmaFor, then crosses the line.
 *
 * @returns {null | { model_prob:number, dir_prob:number, mean:number, sigma:number }}
 *   model_prob = P(over); dir_prob = P(the bet side).
 */
export function projectProb({ groundTruth, statType, direction, line, mean }) {
  const league = groundTruth?.league ?? "NBA";

  // World Cup (soccer): counting stats with means 0.5–4 are Poisson, not
  // Normal — the Normal crossing is wrong exactly in the tails PrizePicks
  // prices (WC_FRAMEWORK_SPEC.md §4). λ_model comes pre-composed from the
  // soccer ground truth (per-90 rate × expected minutes × opponent env).
  if (String(league).toUpperCase() === "WC") {
    const field = PROP_TO_FIELD[statType];
    const lam = groundTruth?.soccer?.lambda?.[field];
    if (!(typeof lam === "number" && lam > 0) || typeof line !== "number") return null;
    const p = poissonFairOver(lam, line);
    if (p == null) return null;
    const model_prob = Math.max(0.01, Math.min(0.99, p));
    return {
      model_prob: Number(model_prob.toFixed(4)),
      dir_prob: Number((direction === "UNDER" ? 1 - model_prob : model_prob).toFixed(4)),
      mean: lam,
      sigma: Number(Math.sqrt(lam).toFixed(4)), // Poisson: Var = λ (telemetry)
    };
  }

  let m = typeof mean === "number" ? mean : null;
  if (m == null) {
    const bl = getBaselines({ groundTruth, statType });
    if (bl.l5Avg == null && bl.seasonAvg == null) return null;
    const chk = computeOverBufferCheck({
      groundTruth, statType, line,
      seasonAvg: bl.seasonAvg, l5Avg: bl.l5Avg, l5WeightedUsed: bl.l5WeightedUsed,
    });
    m = chk.adjusted;
  }
  if (typeof m !== "number" || !Number.isFinite(m)) return null;
  const sigma = sigmaFor(statType, league, groundTruth);
  if (sigma == null) return null;
  const pOver = probOver({ mean: m, sigma, line });
  if (pOver == null) return null;
  const dirProb = direction === "UNDER" ? 1 - pOver : pOver;
  return {
    model_prob: Number(pOver.toFixed(4)),
    dir_prob: Number(dirProb.toFixed(4)),
    mean: Number(m.toFixed(2)),
    sigma: Number(sigma.toFixed(2)),
  };
}
