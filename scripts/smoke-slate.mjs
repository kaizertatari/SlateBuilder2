// Smoke test for the slate builder + payout math. No network. Run:
//   node scripts/smoke-slate.mjs
import { buildSlate } from "../api/_lib/slate-builder.js";
import { setCalibrationTable } from "../api/_lib/calibration.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${msg}`); } }

// Candidate helper. prob overrides calibration when set.
const leg = (player, stat, game, prob, odds_type = "standard", direction = "OVER", line = 10) =>
  ({ player, stat_type: stat, game, prob, odds_type, direction, line, confidence: 75 });

// ── A) Standard legs at the real ~48% → must ABSTAIN at ≥3× power ──
{
  const cands = [
    leg("P1", "Points", "G1", 0.48), leg("P2", "Points", "G2", 0.48),
    leg("P3", "Points", "G3", 0.48), leg("P4", "Points", "G4", 0.48),
  ];
  const r = buildSlate(cands, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(r.abstained, `A: standard ~48% should abstain (got ${r.abstained ? "abstain" : "slate ev=" + r.slate?.ev})`);
}

// ── B) Three 80% standard legs → +EV slate at 5× ──
{
  const cands = [
    leg("P1", "Points", "G1", 0.80), leg("P2", "Rebounds", "G2", 0.80),
    leg("P3", "Assists", "G3", 0.80), leg("P4", "Points", "G4", 0.50),
  ];
  const r = buildSlate(cands, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(!r.abstained, "B: three 80% legs should produce a slate");
  ok(r.slate && Math.abs(r.slate.win_multiplier - 5) < 1e-9, `B: 3-pick power = 5× (got ${r.slate?.win_multiplier})`);
  // 0.8^3 * 5 - 1 = 1.56
  ok(r.slate && Math.abs(r.slate.ev - 1.56) < 0.01, `B: EV ≈ 1.56 (got ${r.slate?.ev})`);
  ok(r.slate && r.slate.legs.every((l) => l.prob === 0.8), "B: picks the three 0.80 legs, not the 0.50");
}

// ── C) Diversification: max 1 leg per game ──
{
  const cands = [
    leg("P1", "Points", "GX", 0.90), leg("P2", "Points", "GX", 0.90), // same game
    leg("P3", "Points", "GY", 0.85), leg("P4", "Points", "GZ", 0.85),
  ];
  const r = buildSlate(cands, { targetMultiplier: 3, mode: "power", size: 3, maxPerGame: 1 });
  ok(!r.abstained, "C: should build a 3-leg slate");
  const games = r.slate ? r.slate.legs.map((l) => l.game) : [];
  ok(new Set(games).size === games.length, `C: all legs distinct games (got ${games.join(",")})`);
}

// ── D) Flex partials + target on the all-hit multiplier ──
{
  const cands = [
    leg("P1", "Points", "G1", 0.60), leg("P2", "Rebounds", "G2", 0.60), leg("P3", "Assists", "G3", 0.60),
  ];
  const flex2 = buildSlate(cands, { targetMultiplier: 2, mode: "flex", size: 3 });
  ok(!flex2.abstained, "D: flex at target 2× should qualify (3-pick flex all-hit = 2.25×)");
  // EV = .216*2.25 + .432*1.25 - 1 ≈ 0.026
  ok(flex2.slate && Math.abs(flex2.slate.ev - 0.026) < 0.01, `D: flex EV ≈ 0.026 (got ${flex2.slate?.ev})`);
  const flex3 = buildSlate(cands, { targetMultiplier: 3, mode: "flex", size: 3 });
  ok(flex3.abstained, "D: flex at target 3× abstains (2.25× < 3×)");
}

// ── E) calibratedProb path via injected table: standard & goblin both abstain ──
{
  setCalibrationTable({
    global_prior: 0.5,
    by_odds_type: {
      standard: { base_rate: 0.48, n: 51, buckets: { "70-79": { p: 0.46, n: 25 } } },
      goblin: { base_rate: 0.65, n: 116, buckets: { "70-79": { p: 0.68, n: 57 } } },
    },
  });
  const std = ["G1", "G2", "G3", "G4"].map((g, i) => leg("S" + i, "Points", g, undefined, "standard"));
  const gob = ["G1", "G2", "G3", "G4"].map((g, i) => leg("Gb" + i, "Points", g, undefined, "goblin"));
  const rStd = buildSlate(std, { targetMultiplier: 3, mode: "power", size: 3 });
  const rGob = buildSlate(gob, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(rStd.abstained, "E: calibrated standard (~46%) abstains at ≥3×");
  ok(rGob.abstained, `E: calibrated goblin can't reach 3× (mult ${rGob.best_rejected?.win_multiplier}) → abstain`);
  setCalibrationTable(null); // reset
}

// ── F) market-carried prob drives EV over confidence calibration ──
{
  const support = ["G1", "G2", "G3"].map((g, i) =>
    ({ ...leg("M" + i, "Points", g, undefined, "standard"), market_fair_at_line: 0.80, market_line_delta: -1 }));
  const r = buildSlate(support, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(!r.abstained, "F: market 0.80 legs → +EV slate");
  ok(r.slate && r.slate.legs.every((l) => l.prob_source === "market" && l.prob === 0.8), "F: prob_source=market, prob=0.80");
  const flat = support.map((c) => ({ ...c, market_fair_at_line: 0.50 }));
  const r2 = buildSlate(flat, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(r2.abstained, "F: market 0.50 (coin flip) → abstain at ≥3×");
}

console.log(`\nsmoke-slate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
