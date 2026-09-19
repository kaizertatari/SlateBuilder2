// Count distributions for the EPL player model. Pure + deterministic.
//
// Every prop count is Poisson or Negative Binomial (mean μ, size r;
// Var = μ + μ²/r, so r = Infinity is exactly Poisson). Minutes uncertainty
// enters as a mixture over playing-time scenarios. Fantasy Score has no
// closed form, so it is simulated with a SEEDED generator — the engine's
// reproducibility contract (same inputs → same verdict) holds.

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
