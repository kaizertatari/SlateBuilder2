// Smoke for projection.js (native P(over)) + rule-projection. No network.
//   node scripts/smoke-projection.mjs
import { apply } from "../api/_lib/rules/rule-projection.js";
import { normCdf, probOver, sigmaFor, projectProb } from "../api/_lib/projection.js";
import { setOdds } from "../api/_lib/odds.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// Baseline = ppg (season governs; l5 matches), home so no road deduction.
const gt = ({ ppg = 30, league = "NBA", home_away = "home" } = {}) => ({
  league, home_away, info: { full_name: "P" }, player: "P",
  season: { averages: { ppg } },
  l5: { n: 5, type: "Regular", averages: { ppg }, weighted: { averages: { ppg } } },
});
const ctx = ({ ppg, line, direction = "OVER" }) => ({ groundTruth: gt({ ppg }), statType: "Points", direction, line });

// ── projection.js math ──
ok(Math.abs(normCdf(0) - 0.5) < 1e-6, "normCdf(0)=0.5");
ok(normCdf(1) > normCdf(0) && normCdf(0) > normCdf(-1), "normCdf monotonic");
ok(Math.abs(probOver({ mean: 20, sigma: 6, line: 20 }) - 0.5) < 1e-6, "probOver mean==line → 0.5");
ok(probOver({ mean: 24, sigma: 6, line: 20 }) > probOver({ mean: 20, sigma: 6, line: 20 }), "probOver rises with mean");
ok(probOver({ mean: 5, sigma: 0, line: 4 }) === null, "probOver σ=0 → null");
ok(sigmaFor("Points", "NBA") > sigmaFor("Points", "WNBA"), "NBA Points σ > WNBA");
ok(sigmaFor("Points", "NBA", { variance: { ppg_stddev: 11 } }) === 11, "live ppg_stddev used for Points");
ok(sigmaFor("PRA", "NBA") > sigmaFor("Points", "NBA"), "PRA σ > Points σ");

// ── projectProb ──
{
  const g = gt({ ppg: 30 });
  const po = projectProb({ groundTruth: g, statType: "Points", direction: "OVER", line: 30.5 });
  const pu = projectProb({ groundTruth: g, statType: "Points", direction: "UNDER", line: 30.5 });
  ok(po && pu && Math.abs(po.dir_prob + pu.dir_prob - 1) < 1e-6, "OVER+UNDER dir_prob sum to 1");
  const hi = projectProb({ groundTruth: g, statType: "Points", direction: "OVER", line: 34.5 });
  ok(hi.model_prob < po.model_prob, "higher line → lower P(over)");
  ok(projectProb({ groundTruth: { league: "NBA" }, statType: "Points", direction: "OVER", line: 20 }) === null, "no baseline → null");
}

// ── rule-projection ──
// A) model + market agree → confirmation signal; never caps/skips
setOdds({ by_player: { P: [{ stat: "Points", league: "NBA", line: 26.5, fair_over: 0.60, sources: [{ book: "dk", line: 26.5, fair_over: 0.60 }] }] }, games: {} });
{
  const r = apply(ctx({ ppg: 30, line: 26.5 }));
  ok(r.fired && r.signals_added >= 1 && !r.suppressor && r.confidence_delta > 0, "A: model+market agree → signal");
  ok(r._projection && r._projection.market_agree === true, "A: market_agree true");
  ok(!r.tier_cap && !r.hard_skip, "A: never caps/skips");
}

// B) model says OVER, market prices a dog → conflict suppressor
setOdds({ by_player: { P: [{ stat: "Points", league: "NBA", line: 26.5, fair_over: 0.35, sources: [{ book: "dk", line: 26.5, fair_over: 0.35 }] }] }, games: {} });
{
  const r = apply(ctx({ ppg: 32, line: 26.5 }));
  ok(r.fired && r.suppressor && r._projection.market_agree === false, "B: model⟂market conflict → suppressor");
  ok(!r.tier_cap && !r.hard_skip, "B: never caps/skips");
}

// C) no market, strong model → model-only signal
setOdds({ by_player: {}, games: {} });
{
  const r = apply(ctx({ ppg: 32, line: 26.5 }));
  ok(r.fired && r.signals_added >= 1 && !r.suppressor, "C: model-only support");
}

// D) no market, weak model → model-only fade
{
  const r = apply(ctx({ ppg: 22, line: 26.5 }));
  ok(r.fired && r.suppressor, "D: model-only fade");
}

// E) no baseline → no fire
{
  const r = apply({ groundTruth: { league: "NBA", info: { full_name: "P" } }, statType: "Points", direction: "OVER", line: 20 });
  ok(!r.fired, "E: no baseline → no fire");
}

setOdds(null);
console.log(`\nsmoke-projection: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
