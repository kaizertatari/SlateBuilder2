// Sportsbook math for the EPL model. Pure — no I/O.
//
// Two kinds of market:
//
// 1. TWO-SIDED match markets (1X2, match total O/U, team total O/U). The book
//    quotes both sides, so the margin comes out by normalising (de-vig) and
//    what remains is a fair probability. fitTeamLambdas turns all of them
//    into one pair of team goal expectations (λ_home, λ_away) under
//    independent Poisson goals — the market's game script, which the player
//    model consumes as teamContext.
//
// 2. ONE-SIDED player "milestone ladders" ("2+ shots −500, 3+ −165"). No
//    Under side exists, so nothing arbitrages the shading away; the World Cup
//    run found DraftKings' ladders overstate player rates ~2× (graded λ̂ 2.61
//    vs actual 1.34). fitLadder recovers the ladder's implied Poisson rate λ̂
//    (and a multiplicative overround c); λ̂ is RAW — the per-stat haircut is
//    estimated against the model / graded outcomes before any blend trusts
//    it (see scripts/epl-board-report.mjs).

// "−500", "+165", -500, 165 → implied probability (vig included).
export function americanToProb(a) {
  const n = typeof a === "number" ? a : Number(String(a ?? "").replace(/[−–]/g, "-").replace(/[^0-9.+-]/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

// Proportional de-vig of a complete set of outcomes (sums to 1).
export function devig(probs) {
  const s = probs.reduce((a, b) => a + (b ?? 0), 0);
  if (!(s > 0) || probs.some((p) => p == null)) return null;
  return probs.map((p) => p / s);
}

export function poissonPmfs(lambda, maxK = 12) {
  const out = new Array(maxK + 1);
  out[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxK; k++) out[k] = (out[k - 1] * lambda) / k;
  return out;
}

// P(X ≥ k), X ~ Poisson(λ).
export function poissonTail(lambda, k) {
  if (!(lambda > 0)) return k <= 0 ? 1 : 0;
  const kk = Math.max(0, Math.ceil(k));
  if (kk === 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < kk; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

// ─── Match markets → team goal expectations ─────────────────────────────────

const MAX_GOALS = 12;

function matchProbs(ph, pa) {
  let home = 0, draw = 0, away = 0;
  const totalPmf = new Array(2 * MAX_GOALS + 1).fill(0);
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j];
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      totalPmf[i + j] += p;
    }
  }
  return { home, draw, away, totalPmf };
}

const overFromPmf = (pmf, line) => {
  let under = 0;
  for (let k = 0; k <= Math.floor(line) && k < pmf.length; k++) under += pmf[k];
  return 1 - under;
};

/**
 * Least-squares fit of (λ_home, λ_away) to de-vigged match probabilities.
 * @param {Object} obs
 * @param {{home:number,draw:number,away:number}} [obs.result]
 * @param {Array<{line:number, over:number}>} [obs.totals]      match goals
 * @param {Array<{line:number, over:number}>} [obs.homeTotals]  home goals
 * @param {Array<{line:number, over:number}>} [obs.awayTotals]  away goals
 * @returns {{home:number, away:number, rmse:number, n:number} | null}
 */
export function fitTeamLambdas(obs) {
  const terms = [];
  if (obs.result) for (const k of ["home", "draw", "away"]) if (obs.result[k] != null) terms.push({ kind: k, target: obs.result[k] });
  for (const t of obs.totals ?? []) terms.push({ kind: "total", line: t.line, target: t.over });
  for (const t of obs.homeTotals ?? []) terms.push({ kind: "homeTotal", line: t.line, target: t.over });
  for (const t of obs.awayTotals ?? []) terms.push({ kind: "awayTotal", line: t.line, target: t.over });
  if (terms.length < 2) return null;

  const cache = new Map();
  const pmf = (l) => {
    const key = l.toFixed(3);
    if (!cache.has(key)) cache.set(key, poissonPmfs(l, MAX_GOALS));
    return cache.get(key);
  };
  const sse = (lh, la) => {
    const ph = pmf(lh), pa = pmf(la);
    const mp = matchProbs(ph, pa);
    let s = 0;
    for (const t of terms) {
      let v;
      if (t.kind === "home" || t.kind === "draw" || t.kind === "away") v = mp[t.kind];
      else if (t.kind === "total") v = overFromPmf(mp.totalPmf, t.line);
      else if (t.kind === "homeTotal") v = overFromPmf(ph, t.line);
      else v = overFromPmf(pa, t.line);
      s += (v - t.target) ** 2;
    }
    return s;
  };
  let best = { s: Infinity, h: null, a: null };
  for (let h = 0.1; h <= 4.5001; h += 0.05) {
    for (let a = 0.1; a <= 4.5001; a += 0.05) {
      const s = sse(h, a);
      if (s < best.s) best = { s, h, a };
    }
  }
  const h0 = best.h, a0 = best.a;
  for (let h = Math.max(0.05, h0 - 0.06); h <= h0 + 0.0601; h += 0.005) {
    for (let a = Math.max(0.05, a0 - 0.06); a <= a0 + 0.0601; a += 0.005) {
      const s = sse(h, a);
      if (s < best.s) best = { s, h, a };
    }
  }
  return { home: Number(best.h.toFixed(3)), away: Number(best.a.toFixed(3)), rmse: Number(Math.sqrt(best.s / terms.length).toFixed(4)), n: terms.length };
}

// ─── One-sided ladders → Poisson rate ────────────────────────────────────────

const DEFAULT_ONE_SIDED_OVERROUND = 1.06; // single rung: c unidentifiable
const OVERROUND_MIN = 1.0;
const OVERROUND_MAX = 1.15;

function ladderSse(lambda, rungs, weights) {
  const logq = rungs.map((r) => Math.log(Math.max(1e-12, poissonTail(lambda, r.k))));
  let logc = 0, wsum = 0;
  for (let i = 0; i < rungs.length; i++) {
    logc += weights[i] * (Math.log(rungs[i].implied) - logq[i]);
    wsum += weights[i];
  }
  const c = Math.min(OVERROUND_MAX, Math.max(OVERROUND_MIN, Math.exp(logc / wsum)));
  let sse = 0;
  for (let i = 0; i < rungs.length; i++) {
    const resid = Math.log(rungs[i].implied) - Math.log(c) - logq[i];
    sse += weights[i] * resid * resid;
  }
  return { sse, c };
}

/**
 * Fit Poisson(λ) + one-sided overround c to a milestone ladder:
 *   implied_k ≈ c · P(X ≥ k | λ).
 * (Ported from the World Cup model, 2026-06.)
 * @param {Array<{k:number, implied:number}>} rungs  "2+" → k=2, vig included
 * @param {{line?:number}} [opts] rungs near a target line get more weight
 * @returns {{lambda:number, overround:number, rungs_used:number, rmse:number} | null}
 */
export function fitLadder(rungs, { line = null } = {}) {
  const usable = (rungs || [])
    .filter((r) => Number.isInteger(r?.k) && r.k >= 1 && r.implied > 0.02 && r.implied < 0.985)
    .sort((a, b) => a.k - b.k);
  if (!usable.length) return null;
  if (usable.length === 1) {
    const { k, implied } = usable[0];
    const fair = Math.min(0.985, implied / DEFAULT_ONE_SIDED_OVERROUND);
    let lo = 0.005, hi = 60;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (poissonTail(mid, k) < fair) lo = mid;
      else hi = mid;
    }
    return { lambda: Number(((lo + hi) / 2).toFixed(4)), overround: DEFAULT_ONE_SIDED_OVERROUND, rungs_used: 1, rmse: 0 };
  }
  const weights = usable.map((r) => (typeof line === "number" ? 1 / (1 + Math.abs(r.k - (line + 0.5))) : 1));
  const top = Math.max(8, usable[usable.length - 1].k * 2.5);
  let best = { sse: Infinity, lambda: null, c: null };
  for (let lam = 0.05; lam <= top + 1e-9; lam += 0.05) {
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
