// EPL grading + calibration math (step 5). Pure — the scripts do the I/O.
//
//   actualFor / gradeVerdict  settle a logged EPL verdict against the player's
//                             FotMob match row (PrizePicks rules: a DNP voids,
//                             an exact tie on an integer line is a push)
//   latestBeforeKickoff       one verdict per join key — the last one priced
//                             before kickoff (closest to the confirmed lineup)
//   fitLogit                  ridge-regularised logistic regression (Newton):
//                             learns the blend weights / model-only shrink
//                             from graded outcomes
//   reliability, scoreProbs   calibration tables + log loss / Brier

import { FANTASY_WEIGHTS } from "./model.js";

/** Actual stat value for a model stat key from a FotMob player row. */
export function actualFor(stat, row) {
  if (!row) return null;
  const n = (k) => row[k] ?? 0;
  switch (stat) {
    case "goal_assist": return n("goals") + n("assists");
    case "fantasy": {
      const w = FANTASY_WEIGHTS;
      return Number((
        w.goals * n("goals") + w.assists * n("assists") + w.shots * n("shots") + w.sot * n("sot") +
        w.passes_att * n("passes_att") + w.key_passes * n("key_passes") + w.clearances * n("clearances") +
        w.tackles * n("tackles") + w.dribbles_att * n("dribbles_att") + w.crosses_att * n("crosses_att") +
        w.yellow * n("yellow_cards") + w.red * n("red_cards") + w.fouls * n("fouls")
      ).toFixed(2));
    }
    default: return row[stat] ?? (row.minutes > 0 ? 0 : null);
  }
}

/**
 * @param {{ epl_stat:string, line:number, direction:"OVER"|"UNDER" }} v
 * @param {Object|null} row  FotMob player row for that match (null = not in squad)
 * @returns {{ hit_or_miss:"hit"|"miss"|"push"|"void", reason:string|null, actual_value:number|null, minutes:number }}
 */
export function gradeVerdict(v, row) {
  const minutes = row?.minutes ?? 0;
  if (!row || !(minutes > 0)) return { hit_or_miss: "void", reason: row ? "dnp" : "not_in_squad", actual_value: null, minutes };
  const actual = actualFor(v.epl_stat, row);
  if (actual == null) return { hit_or_miss: "void", reason: "no_stat", actual_value: null, minutes };
  const line = Number(v.line);
  if (actual === line) return { hit_or_miss: "push", reason: null, actual_value: actual, minutes };
  const over = actual > line;
  const hit = String(v.direction).toUpperCase() === "OVER" ? over : !over;
  return { hit_or_miss: hit ? "hit" : "miss", reason: null, actual_value: actual, minutes };
}

export const joinKey = (e) =>
  [e.player ?? "", e.prop_type ?? "", Number(e.line), e.direction ?? "", e.game_start_time ?? ""].join("|");

/** Keep, per join key, the latest verdict logged before kickoff. */
export function latestBeforeKickoff(verdicts) {
  const best = new Map();
  for (const v of verdicts) {
    const t = Date.parse(v._time);
    const ko = Date.parse(v.game_start_time);
    if (Number.isFinite(ko) && Number.isFinite(t) && t >= ko) continue;
    const k = joinKey(v);
    const prev = best.get(k);
    if (!prev || t > Date.parse(prev._time)) best.set(k, v);
  }
  return [...best.values()];
}

const clamp = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
export const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Ridge logistic regression by Newton–Raphson:
 *   P(hit) = σ(b · x),  penalty ½ Σ λ_j (b_j − prior_j)²
 * The ridge pulls toward the current policy (prior), so a few dozen graded
 * picks nudge the weights instead of throwing them around.
 * @param {number[][]} X  rows of features (include a 1 column for an intercept)
 * @param {number[]} y    0/1 outcomes
 * @param {{ prior?: number[], lambda?: number[]|number, iters?: number }} [opts]
 * @returns {{ coef:number[], se:number[], n:number, logloss:number }}
 */
export function fitLogit(X, y, { prior = null, lambda = 1, iters = 50 } = {}) {
  const k = X[0]?.length ?? 0;
  const pr = prior ?? new Array(k).fill(0);
  const lam = Array.isArray(lambda) ? lambda : new Array(k).fill(lambda);
  let b = [...pr];
  let H = null;
  for (let it = 0; it < iters; it++) {
    const g = b.map((bj, j) => -lam[j] * (bj - pr[j]));
    H = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? -lam[i] : 0)));
    for (let r = 0; r < X.length; r++) {
      const p = sigmoid(X[r].reduce((a, x, j) => a + x * b[j], 0));
      const w = p * (1 - p);
      for (let i = 0; i < k; i++) {
        g[i] += (y[r] - p) * X[r][i];
        for (let j = 0; j < k; j++) H[i][j] -= w * X[r][i] * X[r][j];
      }
    }
    const step = solve(H.map((row) => row.map((v) => -v)), g);
    if (!step) break;
    b = b.map((bj, j) => bj + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const cov = invert(H.map((row) => row.map((v) => -v)));
  const se = cov ? cov.map((row, i) => Math.sqrt(Math.max(0, row[i]))) : new Array(k).fill(null);
  let ll = 0;
  for (let r = 0; r < X.length; r++) {
    const p = clamp(sigmoid(X[r].reduce((a, x, j) => a + x * b[j], 0)));
    ll -= y[r] ? Math.log(p) : Math.log(1 - p);
  }
  return { coef: b, se, n: X.length, logloss: X.length ? ll / X.length : null };
}

function solve(A, bvec) {
  const n = A.length;
  const M = A.map((row, i) => [...row, bvec[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function invert(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    const x = solve(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}

/** Mean log loss + Brier of probabilities p against 0/1 outcomes y. */
export function scoreProbs(p, y) {
  if (!p.length) return { n: 0, logloss: null, brier: null };
  let ll = 0, br = 0;
  for (let i = 0; i < p.length; i++) {
    const q = clamp(p[i]);
    ll -= y[i] ? Math.log(q) : Math.log(1 - q);
    br += (q - y[i]) ** 2;
  }
  return { n: p.length, logloss: ll / p.length, brier: br / p.length };
}

/** Calibration table: predicted-probability bins vs realized hit rate. */
export function reliability(p, y, edges = [0, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.0001]) {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, pred: 0, hits: 0 }));
  for (let i = 0; i < p.length; i++) {
    const b = bins.find((x) => p[i] >= x.lo && p[i] < x.hi);
    if (!b) continue;
    b.n++;
    b.pred += p[i];
    b.hits += y[i];
  }
  return bins.filter((b) => b.n).map((b) => ({ range: `${Math.round(b.lo * 100)}–${Math.round(Math.min(b.hi, 1) * 100)}%`, n: b.n, predicted: b.pred / b.n, realized: b.hits / b.n }));
}

/** Wilson score interval for a hit rate. */
export function wilson(hits, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: (c - m) / d, hi: (c + m) / d };
}
