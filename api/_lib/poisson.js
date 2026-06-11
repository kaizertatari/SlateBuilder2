// Poisson machinery for soccer (WC) counting props — WC_FRAMEWORK_SPEC.md §3.
//
// DK prices soccer player props as ONE-SIDED milestone ladders ("2+ shots
// −650, 3+ −200"): there is no Under side, so devigTwoWay can't apply. We
// recover a fair distribution by fitting Poisson(λ) jointly with a
// multiplicative overround c, assuming implied_k ≈ c · P(X ≥ k | λ) across
// the ladder's rungs. PrizePicks lines sit on the half (k.5), so the fair
// P(over k.5) = P(X ≥ k+1 | λ̂) — usually a margin-corrected read of an
// observed rung, not an extrapolation.
//
// Pure math, no I/O: used by scripts/scrape-odds.mjs at scrape time (fit)
// and api/_lib/odds.js + projection.js at runtime (tail pricing).

// One-sided book margin prior, used when a ladder has a single rung (c is
// unidentifiable from one price). Initial value per spec §7 — recalibrate
// against graded outcomes.
export const DEFAULT_ONE_SIDED_OVERROUND = 1.06;
const OVERROUND_MIN = 1.0;
const OVERROUND_MAX = 1.15;

// Empirical finding (first live fit, 2026-06-11): across ~2,100 DK WC
// ladders the multiplicative overround c pegs at its 1.0 floor with tiny
// residuals — DK's ladder IS a Poisson curve with the margin already baked
// into λ (they shade the rate, not the probabilities). So the fair-side
// correction is a λ haircut: λ_fair = λ̂ / (1 + POISSON_LAMBDA_MARGIN).
// 0.05 initial: a ~4-prob-pt one-sided margin at the coin-flip rung
// (dP/dλ = pmf(k−1) ≈ 0.22 at λ≈3.5) ⇒ δλ ≈ 0.18 ≈ 5% of λ. Calibration
// item — refine against graded group-stage outcomes (spec §7).
export const POISSON_LAMBDA_MARGIN = 0.05;

/** Margin-corrected fair λ from a ladder-fitted λ̂. */
export function fairLambda(lambda) {
  return Number.isFinite(lambda) && lambda > 0 ? lambda / (1 + POISSON_LAMBDA_MARGIN) : null;
}

/** P(X ≥ k) for X ~ Poisson(λ). k is rounded up to an integer ≥ 0. */
export function poissonTail(lambda, k) {
  if (!Number.isFinite(lambda) || lambda <= 0) return null;
  const kk = Math.max(0, Math.ceil(k));
  if (kk === 0) return 1;
  let term = Math.exp(-lambda); // pmf(0)
  let cdf = term;
  for (let i = 1; i < kk; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/** Fair P(over a PrizePicks-style half line) from a fitted λ. */
export function poissonFairOver(lambda, line) {
  if (typeof line !== "number") return null;
  return poissonTail(lambda, Math.floor(line) + 1);
}

// ─── Outfield Fantasy Score composite (WC_FRAMEWORK_SPEC.md §10.5) ──────────

// Official PrizePicks outfield fantasy weights, transcribed from the in-app
// scoring chart 2026-06-11 (not published anywhere public — re-verify if PP
// revises the chart). Keys match the soccer ground-truth λ field names.
export const WC_FANTASY_WEIGHTS = {
  goals: 10,
  assists: 5,
  shots: 1,
  sot: 1,
  passes_att: 0.05,
  key_passes: 0.5, // PP "Shots Assisted"
  clearances: 1,
  tackles: 1,
  dribbles_att: 1, // PP "Attempted Dribbles"
  crosses: 0.5,
  yellow: -1,
  red: -2,
  fouls: -0.5,
};

/**
 * Moment-match the fantasy composite F = Σ wᵢ·Xᵢ from per-component match
 * rates. Components are Poisson (Var = λ) except passes (overdispersed,
 * Var = φλ), with Poisson-thinning covariances along the containment chains
 * goals ⊂ SOT ⊂ shots and assists ⊂ key passes — a scored goal books
 * ~12 pts of simultaneous mass (goal + shot + SOT), which is why fantasy
 * variance is goal-dominated for attackers.
 *
 * @param {Object} lambda — per-component expected counts for the match
 *   (missing/invalid components contribute nothing).
 * @param {{phiPasses?: number}} opts
 * @returns {null | { mean:number, variance:number, sd:number }}
 */
export function fantasyMoments(lambda, { phiPasses = 3.5 } = {}) {
  if (!lambda || typeof lambda !== "object") return null;
  let mean = 0;
  let variance = 0;
  let used = 0;
  for (const [k, w] of Object.entries(WC_FANTASY_WEIGHTS)) {
    const lam = lambda[k];
    if (!Number.isFinite(lam) || lam < 0) continue;
    mean += w * lam;
    variance += w * w * (k === "passes_att" ? phiPasses * lam : lam);
    used += 1;
  }
  if (!used) return null;
  const W = WC_FANTASY_WEIGHTS;
  const addCov = (lam, wi, wj) => { if (Number.isFinite(lam) && lam > 0) variance += 2 * wi * wj * lam; };
  addCov(lambda.sot, W.shots, W.sot); // Cov(shots, sot) = λ_sot
  addCov(lambda.goals, W.shots, W.goals); // Cov(shots, goals) = λ_goal
  addCov(lambda.goals, W.sot, W.goals); // Cov(sot, goals) = λ_goal
  addCov(lambda.assists, W.key_passes, W.assists); // Cov(kp, assists) = λ_assist
  return {
    mean: Number(mean.toFixed(4)),
    variance: Number(variance.toFixed(4)),
    sd: Number(Math.sqrt(Math.max(variance, 1e-9)).toFixed(4)),
  };
}

// SSE of log-prob residuals for a candidate λ, with the profile-optimal c.
function ladderSse(lambda, rungs, weights) {
  let logc = 0;
  let wsum = 0;
  const logq = rungs.map((r) => Math.log(poissonTail(lambda, r.k)));
  for (let i = 0; i < rungs.length; i++) {
    logc += weights[i] * (Math.log(rungs[i].implied) - logq[i]);
    wsum += weights[i];
  }
  let c = Math.exp(logc / wsum);
  c = Math.min(OVERROUND_MAX, Math.max(OVERROUND_MIN, c));
  let sse = 0;
  for (let i = 0; i < rungs.length; i++) {
    const resid = Math.log(rungs[i].implied) - Math.log(c) - logq[i];
    sse += weights[i] * resid * resid;
  }
  return { sse, c };
}

/**
 * Fit Poisson(λ) + one-sided overround c to a milestone ladder.
 *
 * @param {Array<{k:number, implied:number}>} rungs — milestone count k ("2+"
 *   → k=2) and the book's implied probability (vig INCLUDED).
 * @param {{line?:number}} opts — optional PrizePicks line; rungs nearer the
 *   line get more weight (w = 1/(1+|k−(line+0.5)|)).
 * @returns {null | { lambda:number, overround:number, rungs_used:number,
 *   rmse:number }}
 */
export function fitLadderPoisson(rungs, { line = null } = {}) {
  const usable = (rungs || [])
    .filter((r) => Number.isInteger(r?.k) && r.k >= 1 && typeof r.implied === "number" && r.implied > 0.02 && r.implied < 0.985)
    .sort((a, b) => a.k - b.k);
  if (!usable.length) return null;

  // Single rung: c is unidentifiable — assume the prior margin and invert the
  // tail for λ by bisection (tail is monotone increasing in λ).
  if (usable.length === 1) {
    const { k, implied } = usable[0];
    const fair = Math.min(0.985, implied / DEFAULT_ONE_SIDED_OVERROUND);
    let lo = 0.01, hi = 12;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (poissonTail(mid, k) < fair) lo = mid; else hi = mid;
    }
    const lambda = (lo + hi) / 2;
    return { lambda: Number(lambda.toFixed(4)), overround: DEFAULT_ONE_SIDED_OVERROUND, rungs_used: 1, rmse: 0 };
  }

  const weights = usable.map((r) => (typeof line === "number" ? 1 / (1 + Math.abs(r.k - (line + 0.5))) : 1));

  // Coarse grid + local refinement. SSE is smooth and near-unimodal in λ over
  // the plausible soccer range; a 0.05 grid then a 0.005 sweep is plenty.
  let best = { sse: Infinity, lambda: null, c: null };
  for (let lam = 0.05; lam <= 8.0001; lam += 0.05) {
    const { sse, c } = ladderSse(lam, usable, weights);
    if (sse < best.sse) best = { sse, lambda: lam, c };
  }
  if (best.lambda == null) return null;
  for (let lam = Math.max(0.01, best.lambda - 0.05); lam <= best.lambda + 0.0501; lam += 0.005) {
    const { sse, c } = ladderSse(lam, usable, weights);
    if (sse < best.sse) best = { sse, lambda: lam, c };
  }

  return {
    lambda: Number(best.lambda.toFixed(4)),
    overround: Number(best.c.toFixed(4)),
    rungs_used: usable.length,
    rmse: Number(Math.sqrt(best.sse / usable.length).toFixed(4)),
  };
}
