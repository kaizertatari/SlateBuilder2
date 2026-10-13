// Shared prop distributions (EPL, NFL, basketball port). Pure + deterministic.
//
// Counts are Poisson or Negative Binomial (mean μ, size r; Var = μ + μ²/r, so
// r = Infinity is exactly Poisson) or Binomial (receptions out of targets).
// Skewed integer stats (yards) use a discretized gamma with an optional mass
// at zero (hurdle). Playing-time uncertainty enters as a mixture over
// scenarios. Anything without a closed form (Fantasy Score, combos) is
// simulated with a SEEDED generator — the engine's reproducibility contract
// (same inputs → same verdict) holds. fitScale sizes σ from graded residuals.

// P(X = 0..kMax) via the pmf recursions (no lgamma, stable for μ ≲ 700).
export function countPmf(mu, r, kMax) {
  const out = new Array(kMax + 1).fill(0);
  if (!(mu > 0)) {
    out[0] = 1;
    return out;
  }
  if (!Number.isFinite(r) || r <= 0) {
    out[0] = Math.exp(-mu);
    for (let k = 1; k <= kMax; k++) out[k] = (out[k - 1] * mu) / k;
    return out;
  }
  const p = r / (r + mu); // NB success prob
  out[0] = Math.pow(p, r);
  for (let k = 1; k <= kMax; k++) out[k] = (out[k - 1] * (k - 1 + r) * (1 - p)) / k;
  return out;
}

// Support bound that holds ≥ 1 − 1e-9 of the mass for any μ/r we use.
export function kMaxFor(mu, r) {
  const variance = Number.isFinite(r) && r > 0 ? mu + (mu * mu) / r : mu;
  return Math.max(10, Math.ceil(mu + 12 * Math.sqrt(Math.max(variance, 1e-9)) + 10));
}

export function countCdf(k, mu, r) {
  if (k < 0) return 0;
  const pmf = countPmf(mu, r, Math.floor(k));
  return Math.min(1, pmf.reduce((a, b) => a + b, 0));
}

// PrizePicks-style line: P(X > line), P(X < line), P(X == line) (push only on
// integer lines).
export function lineProbs(line, mu, r) {
  const fl = Math.floor(line);
  const isInt = fl === line;
  const pmf = countPmf(mu, r, Math.max(fl, 0));
  const cdfFl = Math.min(1, pmf.reduce((a, b) => a + b, 0));
  if (line < 0) return { over: 1, under: 0, push: 0 };
  if (isInt) {
    const push = pmf[fl] ?? 0;
    return { over: Math.max(0, 1 - cdfFl), under: Math.max(0, cdfFl - push), push };
  }
  return { over: Math.max(0, 1 - cdfFl), under: cdfFl, push: 0 };
}

// Mixture over scenarios [{ p, mu, r }] (p need not sum to 1 — renormalized).
export function mixtureLineProbs(line, scenarios) {
  const total = scenarios.reduce((a, s) => a + (s.p > 0 ? s.p : 0), 0);
  if (!(total > 0)) return { over: 0, under: 0, push: 0 };
  let over = 0, under = 0, push = 0;
  for (const s of scenarios) {
    if (!(s.p > 0)) continue;
    const lp = lineProbs(line, s.mu, s.r);
    over += (s.p / total) * lp.over;
    under += (s.p / total) * lp.under;
    push += (s.p / total) * lp.push;
  }
  return { over, under, push };
}

export function mixtureMean(scenarios) {
  const total = scenarios.reduce((a, s) => a + (s.p > 0 ? s.p : 0), 0);
  return total > 0 ? scenarios.reduce((a, s) => a + (s.p > 0 ? (s.p / total) * s.mu : 0), 0) : 0;
}

// Continuous ranked probability score for a count outcome y under a mixture
// (lower is better; a proper score over ALL thresholds, so it grades the
// whole distribution rather than one line).
export function mixtureCrps(y, scenarios) {
  const total = scenarios.reduce((a, s) => a + (s.p > 0 ? s.p : 0), 0);
  if (!(total > 0)) return null;
  const kMax = Math.max(y, ...scenarios.map((s) => kMaxFor(s.mu, s.r)));
  const cdf = new Array(kMax + 1).fill(0);
  for (const s of scenarios) {
    if (!(s.p > 0)) continue;
    const pmf = countPmf(s.mu, s.r, kMax);
    let c = 0;
    for (let k = 0; k <= kMax; k++) {
      c += pmf[k];
      cdf[k] += (s.p / total) * c;
    }
  }
  let crps = 0;
  for (let k = 0; k <= kMax; k++) {
    const ind = y <= k ? 1 : 0;
    crps += (cdf[k] - ind) ** 2;
  }
  return crps;
}

// ─── Seeded sampling (Fantasy Score simulation) ──────────────────────────────

// mulberry32: tiny, fast, good-enough PRNG with a 32-bit state.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stable 32-bit seed from a string (FNV-1a) so a player/stat/line always
// simulates the same draws.
export function seedFrom(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normal(rng) {
  // Box–Muller
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Marsaglia–Tsang gamma(shape k, scale θ).
function gamma(k, theta, rng) {
  if (k < 1) return gamma(k + 1, theta, rng) * Math.pow(rng(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v * theta;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * theta;
  }
}

export function samplePoisson(lambda, rng) {
  if (!(lambda > 0)) return 0;
  if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal(rng)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// NB as a gamma–Poisson mixture.
export function sampleCount(mu, r, rng) {
  if (!(mu > 0)) return 0;
  if (!Number.isFinite(r) || r <= 0) return samplePoisson(mu, rng);
  return samplePoisson(gamma(r, mu / r, rng), rng);
}

export function sampleBinomial(n, p, rng) {
  if (!(n > 0) || !(p > 0)) return 0;
  if (p >= 1) return n;
  let x = 0;
  for (let i = 0; i < n; i++) if (rng() < p) x++;
  return x;
}

export const sampleGamma = gamma;
export const sampleNormal = normal;

// ─── Generic line pricing ────────────────────────────────────────────────────

// P(X > line), P(X < line), P(X == line) from an integer pmf over 0..K (the
// pmf need not sum to 1 — mass beyond K counts as "over").
export function pmfLineProbs(line, pmf) {
  if (line < 0) return { over: 1, under: 0, push: 0 };
  const fl = Math.floor(line);
  let cdf = 0;
  for (let k = 0; k <= Math.min(fl, pmf.length - 1); k++) cdf += pmf[k];
  cdf = Math.min(1, cdf);
  if (fl === line) {
    const push = pmf[fl] ?? 0;
    return { over: Math.max(0, 1 - cdf), under: Math.max(0, cdf - push), push };
  }
  return { over: Math.max(0, 1 - cdf), under: cdf, push: 0 };
}

// Same, from simulated draws (integer-valued or not).
export function sampleLineProbs(line, draws) {
  if (!draws.length) return { over: 0, under: 0, push: 0 };
  let over = 0, push = 0;
  for (const x of draws) {
    if (x > line) over++;
    else if (x === line) push++;
  }
  const n = draws.length;
  return { over: over / n, under: (n - over - push) / n, push: push / n };
}

export function quantile(draws, q) {
  if (!draws.length) return null;
  const s = [...draws].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

// ─── Normal ──────────────────────────────────────────────────────────────────

// Standard normal CDF — Abramowitz & Stegun 26.2.17 (|error| < 7.5e-8).
export function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// ─── Binomial ────────────────────────────────────────────────────────────────

export function binomialPmf(n, p) {
  const N = Math.max(0, Math.round(n));
  const out = new Array(N + 1).fill(0);
  if (!(p > 0)) { out[0] = 1; return out; }
  if (p >= 1) { out[N] = 1; return out; }
  out[0] = Math.pow(1 - p, N);
  for (let k = 1; k <= N; k++) out[k] = (out[k - 1] * (N - k + 1) * p) / (k * (1 - p));
  return out;
}

// Binomial thinning of a count: X ~ Binomial(T, p) with T ~ NB(μ, r) is
// NB(μp, r) — e.g. receptions = targets × catch rate stays NB.
export const thinCount = (mu, r, p) => ({ mu: mu * p, r });

// ─── Gamma (continuous, right-skewed) ────────────────────────────────────────

// ln Γ(x) — Lanczos (g=7, n=9), |rel error| < 1e-13 for x > 0.
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized lower incomplete gamma P(a, x): series for x < a+1, Lentz
// continued fraction otherwise (Numerical Recipes 6.2).
export function gammaP(a, x) {
  if (!(x > 0)) return 0;
  if (!Number.isFinite(x)) return 1;
  const lnPre = a * Math.log(x) - x - lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.min(1, sum * Math.exp(lnPre));
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.max(0, 1 - Math.exp(lnPre) * h);
}

// Gamma(shape k, scale θ) by its mean and sd.
export function gammaFromMeanSd(mean, sd) {
  if (!(mean > 0) || !(sd > 0)) return null;
  const k = (mean * mean) / (sd * sd);
  return { k, theta: mean / k };
}

export const gammaCdf = (x, k, theta) => gammaP(k, x / theta);

/**
 * Integer stat (yards) with a mass p0 at zero and, otherwise, a gamma body
 * with the given mean/sd, discretized to integers by rounding
 * (P(Y=k) = F(k+½) − F(k−½)). With p0 = 0 it is a plain discretized gamma.
 * Negative values (rushing losses) are folded into 0.
 * @returns {{ over:number, under:number, push:number }}
 */
export function hurdleGammaLineProbs(line, { p0 = 0, mean, sd }) {
  const g = gammaFromMeanSd(mean, sd);
  // No positive body (mean/sd ≤ 0): all mass at zero.
  if (!g) return line < 0 ? { over: 1, under: 0, push: 0 } : line === 0 ? { over: 0, under: 0, push: 1 } : { over: 0, under: 1, push: 0 };
  const F = (y) => (y < 0 ? 0 : p0 + (1 - p0) * gammaCdf(y, g.k, g.theta));
  // Discretized CDF at integer k: P(Y ≤ k) = F(k + ½); P(Y = 0) = F(½).
  const cdfInt = (k) => (k < 0 ? 0 : F(k + 0.5));
  if (line < 0) return { over: 1, under: 0, push: 0 };
  const fl = Math.floor(line);
  if (fl === line) {
    const push = cdfInt(fl) - cdfInt(fl - 1);
    return { over: 1 - cdfInt(fl), under: cdfInt(fl - 1), push };
  }
  return { over: 1 - cdfInt(fl), under: cdfInt(fl), push: 0 };
}

// ─── σ sizing from graded residuals ──────────────────────────────────────────

/**
 * Fit a σ multiplier and a mean bias from graded rows [{ actual, mean, sigma }]
 * with z = (actual − mean)/σ. scale = shrunk RMS of the de-biased z (prior 1
 * worth priorN rows), so applying σ' = σ × scale and mean' = mean + bias·σ
 * makes sd(z) ≈ 1 and mean(z) ≈ 0. bias is shrunk toward 0 the same way.
 * @returns {{ n:number, scale:number, bias:number, raw_sd:number|null, raw_mean:number|null }}
 */
export function fitScale(rows, { prior = 1, priorN = 30 } = {}) {
  const z = rows.filter((r) => Number.isFinite(r.actual) && Number.isFinite(r.mean) && r.sigma > 0).map((r) => (r.actual - r.mean) / r.sigma);
  const n = z.length;
  if (!n) return { n: 0, scale: prior, bias: 0, raw_sd: null, raw_mean: null };
  const m = z.reduce((a, b) => a + b, 0) / n;
  const ss = z.reduce((a, b) => a + (b - m) ** 2, 0);
  const rawSd = n > 1 ? Math.sqrt(ss / (n - 1)) : null;
  const scale = Math.sqrt((priorN * prior * prior + ss) / (priorN + Math.max(n - 1, 0)));
  const bias = (n * m) / (n + priorN);
  return { n, scale, bias, raw_sd: rawSd, raw_mean: m };
}
