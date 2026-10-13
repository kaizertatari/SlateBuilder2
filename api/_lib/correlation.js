// Same-game leg correlation for the slate builder (foundation step 6).
//
// Legs in DIFFERENT games are treated as independent. Legs in the SAME game
// are joined with a Gaussian copula: each leg hits when its latent normal
// falls below Φ⁻¹(p), and the latents of two legs correlate with ρ. ρ is set
// on the OVER side and flips sign when the legs bet opposite directions.
//
// Priors are φ (phi) coefficients of over/over outcomes measured on the
// graded store 2026-10-13 (scripts/calibration-all.mjs prints the live
// values), converted to the latent scale with ρ = sin(π·φ/2):
//   WNBA  same player φ 0.38 (n 1,259) · teammate 0.14 (3,135) · opponent 0.03 (4,317)
//   EPL   same player φ 0.08 (2,679) · other player same match ≈0 (67,881)
// Leagues with no graded pairs yet (NBA, NFL) borrow the basketball values —
// conservative until their own pairs accrue.
//
// Pure + deterministic: the ≥3-legs-per-game case is simulated with a seeded
// generator keyed on the legs.

import { normCdf, mulberry32, seedFrom, sampleNormal } from "./distributions.js";

const latent = (phi) => Math.sin((Math.PI * phi) / 2);
const BASKETBALL = { samePlayer: latent(0.38), teammate: latent(0.14), opponent: latent(0.03) };
export const CORRELATION_PRIORS = {
  WNBA: BASKETBALL,
  NBA: BASKETBALL,
  EPL: { samePlayer: latent(0.08), teammate: 0, opponent: 0 },
  default: BASKETBALL,
};

// Inverse standard normal CDF — Acklam's rational approximation, refined by
// one Halley step against normCdf (so accurate to normCdf's ~1e-7).
const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
export function normInv(p) {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  let x;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else {
    const q = p - 0.5, r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// Bivariate standard normal CDF P(Z1 ≤ h, Z2 ≤ k; ρ) by 20-point
// Gauss–Legendre integration of Plackett's identity
//   Φ2(h,k;ρ) = Φ(h)Φ(k) + ∫₀^ρ φ2(h,k;r) dr.
const GL_X = [-0.9931285991850949, -0.9639719272779138, -0.9122344282513259, -0.8391169718222188, -0.7463319064601508, -0.6360536807265150, -0.5108670019508271, -0.3737060887154195, -0.2277858511416451, -0.0765265211334973, 0.0765265211334973, 0.2277858511416451, 0.3737060887154195, 0.5108670019508271, 0.6360536807265150, 0.7463319064601508, 0.8391169718222188, 0.9122344282513259, 0.9639719272779138, 0.9931285991850949];
const GL_W = [0.0176140071391521, 0.0406014298003869, 0.0626720483341091, 0.0832767415767048, 0.1019301198172404, 0.1181945319615184, 0.1316886384491766, 0.1420961093183820, 0.1491729864726037, 0.1527533871307258, 0.1527533871307258, 0.1491729864726037, 0.1420961093183820, 0.1316886384491766, 0.1181945319615184, 0.1019301198172404, 0.0832767415767048, 0.0626720483341091, 0.0406014298003869, 0.0176140071391521];
export function bvnCdf(h, k, rho) {
  if (!Number.isFinite(h) || !Number.isFinite(k)) {
    if (h === -Infinity || k === -Infinity) return 0;
    if (h === Infinity) return normCdf(k);
    return normCdf(h);
  }
  const base = normCdf(h) * normCdf(k);
  if (rho === 0) return base;
  const r0 = Math.max(-0.999999, Math.min(0.999999, rho));
  let s = 0;
  for (let i = 0; i < GL_X.length; i++) {
    const r = (r0 * (GL_X[i] + 1)) / 2;
    const om = 1 - r * r;
    s += GL_W[i] * Math.exp(-(h * h - 2 * r * h * k + k * k) / (2 * om)) / Math.sqrt(om);
  }
  return Math.min(1, Math.max(0, base + (s * r0) / 2 / (2 * Math.PI)));
}

/**
 * Latent correlation between two legs' HIT events.
 * Legs: { player, game (cap key), team?, opponent?, direction, league? }.
 * @returns {number} ρ in (−1, 1); 0 for different games
 */
export function legCorrelation(a, b, priors = CORRELATION_PRIORS) {
  if (!a.gameCapKey || a.gameCapKey !== b.gameCapKey) return 0;
  const table = priors[a.league] ?? priors.default;
  let rho;
  if (String(a.player).toLowerCase() === String(b.player).toLowerCase()) rho = table.samePlayer;
  else if (a.player_team && b.player_team) rho = a.player_team === b.player_team ? table.teammate : table.opponent;
  else rho = table.opponent; // same game, side unknown → the weaker link
  const sameDir = String(a.direction ?? a.verdict ?? "").toUpperCase() === String(b.direction ?? b.verdict ?? "").toUpperCase();
  return sameDir ? rho : -rho;
}

// Distribution of #hits for one game's legs.
function groupDistribution(legs, priors, draws) {
  if (legs.length === 1) return [1 - legs[0].prob, legs[0].prob];
  if (legs.length === 2) {
    const [a, b] = legs;
    const both = bvnCdf(normInv(a.prob), normInv(b.prob), legCorrelation(a, b, priors));
    const one = a.prob + b.prob - 2 * both;
    return [Math.max(0, 1 - a.prob - b.prob + both), Math.max(0, one), Math.max(0, both)];
  }
  // ≥3 legs: Gaussian copula by seeded simulation (Cholesky of the ρ matrix).
  const n = legs.length;
  const S = legs.map((x, i) => legs.map((y, j) => (i === j ? 1 : legCorrelation(x, y, priors))));
  const L = cholesky(S);
  const thr = legs.map((l) => normInv(l.prob));
  const rng = mulberry32(seedFrom(legs.map((l) => `${l.player}|${l.stat}|${l.line}|${l.direction}`).join("#")));
  const dist = new Array(n + 1).fill(0);
  const z = new Array(n);
  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < n; i++) z[i] = sampleNormal(rng);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let j = 0; j <= i; j++) x += L[i][j] * z[j];
      if (x <= thr[i]) hits++;
    }
    dist[hits]++;
  }
  return dist.map((c) => c / draws);
}

function cholesky(S) {
  const n = S.length;
  const L = S.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = S[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      // Jitter keeps a near-singular prior matrix factorizable.
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[j][j];
    }
  }
  return L;
}

const convolve = (a, b) => {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
};

/**
 * P(exactly k legs hit), k = 0..n, with same-game legs correlated and games
 * independent. Legs need { prob, gameCapKey, player, direction, ... }.
 * Reduces exactly to the independent Poisson-binomial when every leg is in a
 * different game.
 */
export function hitDistribution(legs, { priors = CORRELATION_PRIORS, draws = 20000, cache = null } = {}) {
  const groups = new Map();
  for (const l of legs) {
    const k = l.gameCapKey ?? `solo:${groups.size}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  let dist = [1];
  for (const g of groups.values()) {
    // Memo per game group (the slate search revisits the same groups across
    // many combinations; simulated groups are the expensive ones).
    // Hot-loop callers give each leg a small integer `corrIdx` (< 53): the
    // group key is then an exact bitmask number instead of a joined string.
    let key = null;
    if (cache && g.length > 1) {
      key = g.every((l) => Number.isInteger(l.corrIdx) && l.corrIdx >= 0 && l.corrIdx < 53)
        ? g.reduce((m, l) => m + 2 ** l.corrIdx, 0)
        : g.map((l) => `${l.player}|${l.stat}|${l.line}|${l.direction}|${l.prob}`).sort().join("#");
    }
    let gd = key ? cache.get(key) : null;
    if (!gd) {
      gd = groupDistribution(g, priors, draws);
      if (key) cache.set(key, gd);
    }
    dist = convolve(dist, gd);
  }
  return dist;
}

/** True when any two legs share a game (so correlation changes the price). */
export function hasSameGamePair(legs) {
  const seen = new Set();
  for (const l of legs) {
    if (seen.has(l.gameCapKey)) return true;
    seen.add(l.gameCapKey);
  }
  return false;
}
