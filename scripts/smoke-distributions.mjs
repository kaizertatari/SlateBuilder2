// Smoke for the shared distributions (api/_lib/distributions.js) — the parts
// added for NFL + the basketball port. The NB/Poisson/mixture core is covered
// by smoke-epl-model; the EPL re-export path is checked here too.

import {
  lgamma, gammaP, gammaCdf, gammaFromMeanSd, hurdleGammaLineProbs, binomialPmf, thinCount,
  pmfLineProbs, sampleLineProbs, quantile, normCdf, fitScale, countPmf, lineProbs,
  mulberry32, sampleGamma, sampleNormal,
} from "../api/_lib/distributions.js";
import * as eplDist from "../api/_lib/epl/distributions.js";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const sums1 = (lp) => near(lp.over + lp.under + lp.push, 1, 1e-9);

check("EPL path re-exports the shared module", eplDist.lineProbs === lineProbs && eplDist.countPmf === countPmf);

check("lgamma: Γ(5) = 24, Γ(½) = √π", near(lgamma(5), Math.log(24), 1e-12) && near(lgamma(0.5), 0.5 * Math.log(Math.PI), 1e-12));
check("gammaP(1, x) = 1 − e^−x (exponential)", near(gammaP(1, 2), 1 - Math.exp(-2), 1e-12));
check("gammaP(2, 1) = 1 − 2/e (series branch)", near(gammaP(2, 1), 1 - 2 / Math.E, 1e-12));
check("gammaP(3, 10) via continued fraction", near(gammaP(3, 10), 1 - Math.exp(-10) * (1 + 10 + 50), 1e-12));
check("gammaP edges: 0 at 0, 1 at ∞", gammaP(2, 0) === 0 && gammaP(2, Infinity) === 1);
const g = gammaFromMeanSd(60, 30);
check("gammaFromMeanSd matches moments", near(g.k * g.theta, 60) && near(Math.sqrt(g.k) * g.theta, 30));
check("gamma median < mean (right skew)", gammaCdf(60, g.k, g.theta) > 0.5);

const rec = hurdleGammaLineProbs(54.5, { p0: 0, mean: 60, sd: 30 });
check("yards: half-point line has no push, sums to 1", rec.push === 0 && sums1(rec));
check("yards: over the mean's half-point is < 50% (skew)", hurdleGammaLineProbs(59.5, { mean: 60, sd: 30 }).over < 0.5);
const intLine = hurdleGammaLineProbs(50, { mean: 60, sd: 30 });
check("yards: integer line has a push and sums to 1", intLine.push > 0 && sums1(intLine));
const hz = hurdleGammaLineProbs(0.5, { p0: 0.2, mean: 40, sd: 25 });
check("hurdle: P(0) mass lands under 0.5", hz.under >= 0.2 && hz.under < 0.21 && sums1(hz));
check("hurdle: no body → all mass at 0", hurdleGammaLineProbs(0.5, { mean: 0, sd: 0 }).under === 1 && hurdleGammaLineProbs(0, { mean: 0, sd: 0 }).push === 1);

const bp = binomialPmf(8, 0.65);
check("binomial pmf sums to 1 with mean np", near(bp.reduce((a, b) => a + b, 0), 1, 1e-12) && near(bp.reduce((a, p, k) => a + k * p, 0), 5.2, 1e-9));
check("binomial edges p=0 / p=1", binomialPmf(5, 0)[0] === 1 && binomialPmf(5, 1)[5] === 1);
const t = thinCount(7, 4, 0.7);
check("thinning keeps NB size, scales mean", near(t.mu, 4.9) && t.r === 4);

const pl = pmfLineProbs(4.5, bp);
check("pmfLineProbs on a half-point", pl.push === 0 && near(pl.under, bp.slice(0, 5).reduce((a, b) => a + b, 0)));
check("pmfLineProbs matches lineProbs for NB", near(pmfLineProbs(3, countPmf(3.2, 5, 60)).push, lineProbs(3, 3.2, 5).push, 1e-12));

const draws = [0, 1, 2, 2, 3, 5];
const sl = sampleLineProbs(2, draws);
check("sampleLineProbs counts pushes", near(sl.push, 2 / 6) && near(sl.over, 2 / 6) && near(sl.under, 2 / 6));
check("quantile median", quantile(draws, 0.5) === 2 || quantile(draws, 0.5) === 3);

check("normCdf symmetric", near(normCdf(1.3) + normCdf(-1.3), 1, 1e-7));

const rng = mulberry32(7);
const gs = Array.from({ length: 20000 }, () => sampleGamma(4, 15, rng));
check("sampleGamma mean ≈ kθ", Math.abs(gs.reduce((a, b) => a + b, 0) / gs.length - 60) < 1.5);
const rng2 = mulberry32(7);
check("seeded sampling is reproducible", sampleNormal(rng2) === sampleNormal(mulberry32(7)));

// σ too narrow by 1.5× and mean high by 0.5σ → fitScale recovers both.
const r3 = mulberry32(11);
const rows = Array.from({ length: 4000 }, () => ({ mean: 20, sigma: 4, actual: 20 - 2 + 6 * sampleNormal(r3) }));
const f = fitScale(rows);
check("fitScale recovers σ multiplier ≈ 1.5", Math.abs(f.scale - 1.5) < 0.05);
check("fitScale recovers bias ≈ −0.5σ", Math.abs(f.bias + 0.5) < 0.05);
const small = fitScale(rows.slice(0, 5));
check("fitScale shrinks small samples toward 1 / 0", Math.abs(small.scale - 1) < Math.abs((small.raw_sd ?? 1) - 1) + 1e-9 && Math.abs(small.bias) < Math.abs(small.raw_mean));
check("fitScale with no rows returns the prior", fitScale([]).scale === 1 && fitScale([]).bias === 0);

console.log(`\nsmoke-distributions: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
