// EPL calibration report — joins graded EPL verdicts (Axiom) and answers:
//   1. How are the picks doing? hit rate by tier / odds type / stat / lineup
//      state vs the break-even, with Wilson intervals.
//   2. Are the probabilities calibrated? reliability of the blended P, and
//      log loss / Brier of model vs market vs blend on the same lines.
//   3. What should EPL_POLICY be? refit (suggest-only, ridge toward the
//      current policy): blend weights on book-priced lines, the shrink on
//      model-only lines.
//   4. Can the slate come out of shadow mode? explicit unlock checklist.
//
// Uses the last verdict priced before kickoff per line (closest to the
// confirmed lineup). Pushes and voids are excluded from hit rates.
//
// Usage: npm run epl-calibration-report  [-- --lookback 120]

import { loadEnvLocal } from "./_env.mjs";
import { queryAxiom } from "./_axiom.mjs";
import { EPL_POLICY } from "../api/_lib/epl/verdict.js";
import { latestBeforeKickoff, joinKey, fitLogit, logit, sigmoid, scoreProbs, reliability, wilson } from "../api/_lib/epl/grading.js";

loadEnvLocal();
const args = process.argv.slice(2);
const lbIdx = args.indexOf("--lookback");
const LOOKBACK_DAYS = lbIdx >= 0 ? Number(args[lbIdx + 1]) : 120;
export const UNLOCK = { minStandardPicks: 150, maxCalibrationGap: 0.03 };

const pct = (x) => (x == null ? "  —  " : `${(x * 100).toFixed(1)}%`);

function hitTable(title, rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  console.log(`\n${title}`);
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const hits = g.filter((r) => r.y).length;
    const ci = wilson(hits, g.length);
    const be = g.reduce((a, r) => a + (r.epl_break_even ?? 0), 0) / g.length;
    const pred = g.reduce((a, r) => a + (r.epl_prob ?? 0), 0) / g.length;
    console.log(`  ${String(k).padEnd(24)} n=${String(g.length).padStart(4)}  hit ${pct(hits / g.length).padStart(6)} [${pct(ci.lo)}–${pct(ci.hi)}]  predicted ${pct(pred)}  break-even ${pct(be)}`);
  }
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) throw new Error("AXIOM_TOKEN not set");
  const D = `['${dataset}']`;
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const verdicts = await queryAxiom(token, `${D} | where event_type == "verdict" and league == "EPL" and pre_filtered == false | limit 100000`, { start });
  const outcomes = await queryAxiom(token, `${D} | where event_type == "outcome" and league == "EPL" | limit 100000`, { start });
  const outByKey = new Map(outcomes.map((o) => [joinKey(o), o]));
  const latest = latestBeforeKickoff(verdicts);
  const joined = latest.map((v) => ({ ...v, outcome: outByKey.get(joinKey(v)) })).filter((r) => r.outcome);
  const settled = joined
    .filter((r) => r.outcome.hit_or_miss === "hit" || r.outcome.hit_or_miss === "miss")
    .map((r) => ({ ...r, y: r.outcome.hit_or_miss === "hit" ? 1 : 0 }));
  const counts = {};
  for (const r of joined) counts[r.outcome.hit_or_miss] = (counts[r.outcome.hit_or_miss] || 0) + 1;

  console.log(`EPL calibration report — lookback ${LOOKBACK_DAYS}d, policy v${EPL_POLICY.version}`);
  console.log(`  ${verdicts.length} verdict events → ${latest.length} lines (last before kickoff) → ${joined.length} graded ${JSON.stringify(counts)}`);
  if (!settled.length) {
    console.log("\n  No settled EPL lines yet — run `npm run grade-epl-outcomes` after matches finish.");
    return;
  }

  // 1. Picks.
  const picks = settled.filter((r) => r.tier === "A" || r.tier === "B");
  const stdPicks = picks.filter((r) => r.odds_type === "standard");
  hitTable("Picks by tier", picks, (r) => r.tier);
  hitTable("Picks by odds type", picks, (r) => r.odds_type);
  hitTable("Picks by stat", picks, (r) => r.epl_stat);
  hitTable("Picks by lineup state", picks, (r) => r.epl_lineup ?? "none");
  hitTable("Picks: book-priced vs model-only", picks, (r) => (r.epl_model_only ? "model-only" : "blend"));

  // 2. Calibration on every settled priced line (both sides are separate lines).
  const pB = settled.map((r) => r.epl_prob), y = settled.map((r) => r.y);
  console.log("\nReliability — blended P, all settled priced lines:");
  for (const b of reliability(pB, y)) console.log(`  ${b.range.padEnd(9)} n=${String(b.n).padStart(5)}  predicted ${pct(b.predicted)}  realized ${pct(b.realized)}`);
  const mk = settled.filter((r) => !r.epl_model_only && r.epl_p_market != null && r.epl_p_model != null);
  const mo = settled.filter((r) => r.epl_model_only && r.epl_p_model != null);
  const sc = (rows, f) => scoreProbs(rows.map(f), rows.map((r) => r.y));
  console.log("\nScores (lower = better):");
  if (mk.length) {
    for (const [name, f] of [["model", (r) => r.epl_p_model], ["market", (r) => r.epl_p_market], ["blend (policy)", (r) => r.epl_prob]]) {
      const s = sc(mk, f);
      console.log(`  book-priced  ${name.padEnd(15)} n=${s.n}  log loss ${s.logloss.toFixed(4)}  Brier ${s.brier.toFixed(4)}`);
    }
  }
  if (mo.length) {
    for (const [name, f] of [["model raw", (r) => r.epl_p_model], ["shrunk (policy)", (r) => r.epl_prob]]) {
      const s = sc(mo, f);
      console.log(`  model-only   ${name.padEnd(15)} n=${s.n}  log loss ${s.logloss.toFixed(4)}  Brier ${s.brier.toFixed(4)}`);
    }
  }

  // 3. Refit (suggest-only). Ridge toward the current policy; λ = 20 keeps
  //    early samples from swinging the weights.
  console.log("\nRefit (suggest-only — edit EPL_POLICY in api/_lib/epl/verdict.js after review):");
  const proposals = {};
  if (mk.length >= 50) {
    const X = mk.map((r) => [logit(r.epl_p_model), logit(r.epl_p_market)]);
    const f = fitLogit(X, mk.map((r) => r.y), { prior: [EPL_POLICY.blend.model, EPL_POLICY.blend.market], lambda: 20 });
    const biasFit = fitLogit(mk.map((r, i) => [1, ...X[i]]), mk.map((r) => r.y), { prior: [0, EPL_POLICY.blend.model, EPL_POLICY.blend.market], lambda: 20 });
    proposals.blend = { model: Number(f.coef[0].toFixed(3)), market: Number(f.coef[1].toFixed(3)) };
    const refit = scoreProbs(X.map((x) => sigmoid(f.coef[0] * x[0] + f.coef[1] * x[1])), mk.map((r) => r.y));
    console.log(`  blend weights: model ${f.coef[0].toFixed(3)} ± ${f.se[0]?.toFixed(3)}, market ${f.coef[1].toFixed(3)} ± ${f.se[1]?.toFixed(3)} (policy ${EPL_POLICY.blend.model}/${EPL_POLICY.blend.market}); in-sample log loss ${refit.logloss.toFixed(4)}; bias term ${biasFit.coef[0].toFixed(3)} (≈0 ⇒ no systematic over/under lean)`);
  } else {
    console.log(`  blend weights: need ≥ 50 settled book-priced lines (have ${mk.length})`);
  }
  if (mo.length >= 50) {
    const f = fitLogit(mo.map((r) => [logit(r.epl_p_model)]), mo.map((r) => r.y), { prior: [EPL_POLICY.modelOnlyShrink], lambda: 20 });
    proposals.modelOnlyShrink = Number(f.coef[0].toFixed(3));
    console.log(`  model-only shrink: ${f.coef[0].toFixed(3)} ± ${f.se[0]?.toFixed(3)} (policy ${EPL_POLICY.modelOnlyShrink})`);
  } else {
    console.log(`  model-only shrink: need ≥ 50 settled model-only lines (have ${mo.length})`);
  }
  if (Object.keys(proposals).length) console.log(`  proposed: ${JSON.stringify(proposals)}`);

  // 4. Unlock checklist.
  const stdHits = stdPicks.filter((r) => r.y).length;
  const stdRate = stdPicks.length ? stdHits / stdPicks.length : null;
  const stdPred = stdPicks.length ? stdPicks.reduce((a, r) => a + r.epl_prob, 0) / stdPicks.length : null;
  const gap = stdRate != null ? Math.abs(stdPred - stdRate) : null;
  const be = 1 / Math.sqrt(3);
  const checks = [
    [`≥ ${UNLOCK.minStandardPicks} graded standard picks`, stdPicks.length >= UNLOCK.minStandardPicks, `${stdPicks.length}`],
    ["standard picks hit ≥ break-even (57.7%)", stdRate != null && stdRate >= be, pct(stdRate)],
    [`predicted vs realized within ${UNLOCK.maxCalibrationGap * 100} pts`, gap != null && gap <= UNLOCK.maxCalibrationGap, gap != null ? `${(gap * 100).toFixed(1)} pts` : "—"],
  ];
  console.log("\nSlate unlock checklist (SLATE_PENDING_LEAGUES.EPL):");
  for (const [label, ok, val] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label.padEnd(46)} ${val}`);
  console.log(checks.every((c) => c[1])
    ? "  → READY: move EPL from SLATE_PENDING_LEAGUES to SLATE_CALIBRATED_LEAGUES (api/_lib/prop-types.js)."
    : "  → keep EPL in shadow mode.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
