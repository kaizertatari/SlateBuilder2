// Smoke for the basketball predictive distribution (api/_lib/basketball/dist.js).
// No network.
//   node scripts/smoke-basketball-dist.mjs
import { valueOf, minutesProfile, fitDispersion, engineMean, calibratedProbOver, PROP_KEY, DIST_KEYS } from "../api/_lib/basketball/dist.js";
import { mulberry32, sampleCount } from "../api/_lib/distributions.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// A) Prop values from a box score (combos, Blocks+Steals, Fantasy weights)
const row = { min: 30, pts: 20, reb: 10, ast: 5, stl: 2, blk: 1, tov: 3, fg3m: 2, fg3a: 6, fga: 15 };
ok(valueOf(row, "pra") === 35 && valueOf(row, "pr") === 30 && valueOf(row, "ra") === 15, "A: combos sum");
ok(valueOf(row, "bs") === 3, "A: Blocks+Steals");
ok(Math.abs(valueOf(row, "fs") - (20 + 12 + 7.5 + 6 + 3 - 3)) < 1e-9, "A: Fantasy Score 1/1.2/1.5/3/3/−1");
ok(Object.keys(PROP_KEY).length === DIST_KEYS.length && PROP_KEY["Fantasy Score"] === "fs", "A: every PrizePicks prop has a key");

// B) Minutes profile: recency-weighted, ignores DNPs, window of 10
const mp = minutesProfile([10, 10, 10, 0, 30, 30]);
ok(mp.n === 5 && mp.mean > 18 && mp.mean < 30, `B: recent minutes weigh more than the plain average 18 (${mp.mean.toFixed(2)})`);
ok(minutesProfile(Array(15).fill(20)).n === 10, "B: window capped at 10");
ok(minutesProfile([0, 0]) === null, "B: no minutes → null");

// C) Dispersion fit recovers a known negative binomial
{
  const rng = mulberry32(3), pairs = [];
  for (let i = 0; i < 20000; i++) { const mu = 2 + (i % 20); pairs.push({ mu, y: sampleCount(mu, 6, rng) }); }
  const r = fitDispersion(pairs);
  ok(r > 4.8 && r < 7.4, `C: NB(r=6) recovered (${r.toFixed(2)})`);
  ok(fitDispersion([{ mu: 3, y: 3 }, { mu: 5, y: 5 }]) === 1e6, "C: no overdispersion → Poisson-like (r huge)");
}

// D) Engine-style mean = ½ last-5 + ½ season
{
  const h = [10, 10, 10, 10, 10, 20, 20, 20, 20, 20].map((pts) => ({ row: { pts } }));
  ok(Math.abs(engineMean(h, "pts") - (0.5 * 20 + 0.5 * 15)) < 1e-9, "D: engine mean blends last 5 and season");
}

// E) Calibrated P(over)
{
  const params = { r: { pts: 6 }, c: { pts: 1.04 } };
  const p = (mean, line, factor = 1) => calibratedProbOver({ params, key: "pts", mean, factor, line }).p_over;
  ok(p(20, 15.5) > 0.5 && p(20, 24.5) < p(20, 19.5), "E: line well below the mean → P(over) > 0.5; higher line → lower P(over)");
  ok(p(20, 20.5, 1.1) > p(20, 20.5), "E: favorable matchup raises P(over)");
  ok(Math.abs(calibratedProbOver({ params, key: "pts", mean: 20, line: 20.5 }).mean - 20.8) < 1e-9, "E: mean × c");
  // right skew: at a line at the mean, P(over) < 0.5 (median below mean)
  ok(p(20 / 1.04, 19.5) < 0.5 + 1e-9 || p(20 / 1.04, 20.5) < 0.5, "E: right-skewed — P(over the mean) < 0.5");
  ok(calibratedProbOver({ params, key: "reb", mean: 5, line: 4.5 }) === null, "E: missing params → null");
  ok(calibratedProbOver({ params, key: "pts", mean: null, line: 4.5 }) === null, "E: missing mean → null");
}

// F) Bundled artifacts carry fitted parameters for every key
{
  const fs = await import("node:fs");
  for (const lg of ["nba", "wnba"]) {
    const f = new URL(`../data/${lg}-opp-model.json`, import.meta.url);
    if (!fs.existsSync(f)) { console.log(`SKIP  ${lg} artifact`); continue; }
    const a = JSON.parse(fs.readFileSync(f, "utf8"));
    ok(a.dist && DIST_KEYS.every((k) => a.dist.r[k] > 0 && a.dist.c[k] > 0.8 && a.dist.c[k] < 1.2), `F: ${lg} artifact has r and c for every prop`);
  }
}

// G) Pipeline policy: blend, direction, caps (basketball/policy.js)
{
  const { pipelineVerdict, BASKETBALL_POLICY } = await import("../api/_lib/basketball/policy.js");
  const v = pipelineVerdict({ pModelOver: 0.70, pMarketOver: 0.60, direction: "OVER" });
  ok(v.prob > 0.60 && v.prob < 0.70 && !v.model_only, `G: 50/50 log-odds blend sits between model and market (${v.prob.toFixed(3)})`);
  const u = pipelineVerdict({ pModelOver: 0.30, pMarketOver: 0.40, direction: "UNDER" });
  ok(Math.abs(u.prob - v.prob) < 1e-12, "G: UNDER prices the other side symmetrically");
  ok(v.tier === "A" && Math.abs(v.break_even - 0.577) < 0.002, `G: standard edge ${v.edge.toFixed(3)} over 57.7% → A`);
  ok(pipelineVerdict({ pModelOver: 0.90, pMarketOver: null, direction: "OVER" }).tier === "SKIP", "G: no market → model-only, never tiered");
  ok(pipelineVerdict({ pModelOver: 0.95, pMarketOver: 0.92, direction: "OVER", oddsType: "goblin" }).tier !== "A", "G: goblin capped below A (approximate payout)");
  ok(pipelineVerdict({ pModelOver: 0.55, pMarketOver: 0.50, direction: "OVER" }).tier === "SKIP", "G: below break-even → SKIP");
  ok(pipelineVerdict({ pModelOver: null, pMarketOver: 0.5, direction: "OVER" }) === null, "G: no model P → null");
  ok(BASKETBALL_POLICY.maxTier === "A" && BASKETBALL_POLICY.modelOnlyMaxTier === "SKIP", "G: no S-tier, model-only never tiered");
}

// H) NB market shift (book price at its line → PrizePicks line)
{
  const { nbShiftOver } = await import("../api/_lib/basketball/dist.js");
  const s = (o) => nbShiftOver({ r: 6, ...o });
  ok(s({ pOver: 0.5, bookLine: 20.5, targetLine: 20.5 }) === 0.5, "H: same line → unchanged");
  const down = s({ pOver: 0.5, bookLine: 20.5, targetLine: 16.5 }), up = s({ pOver: 0.5, bookLine: 20.5, targetLine: 24.5 });
  ok(down > 0.5 && up < 0.5, "H: lower line → higher P(over), higher line → lower");
  ok(Math.abs((down - 0.5) - (0.5 - up)) > 0.005, `H: asymmetric (skewed) shift (${down.toFixed(3)} / ${up.toFixed(3)})`);
  const back = s({ pOver: down, bookLine: 16.5, targetLine: 20.5 });
  ok(Math.abs(back - 0.5) < 0.005, `H: shifting back recovers the book price (${back.toFixed(4)})`);
  ok(s({ pOver: 0.45, bookLine: 1.5, targetLine: 0.5 }) > 0.45, "H: low-count goblin shift moves the right way");
  ok(nbShiftOver({ pOver: 0.5, bookLine: 2.5, targetLine: 1.5, r: null }) === null, "H: missing r → null");
}

console.log(`\nsmoke-basketball-dist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
