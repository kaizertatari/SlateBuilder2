// Market-probability calibration report.
//
// The slate builder bets on `market_fair_at_line` — the de-vigged DK/FD
// consensus probability at the PrizePicks line (rule-market-edge → verdict
// log). Unlike engine confidence (which build-calibration.mjs already maps to a
// hit rate), this probability is taken at FACE VALUE: buildSlate's EV assumes
// the market's fair P(hit) IS the true P(hit). This script is the measurement
// rig that tests that assumption against graded outcomes — it bins the
// predicted market prob and compares it to the realized hit rate (a reliability
// curve), plus a Brier score.
//
// If the market is well-calibrated (predicted ≈ actual, gap ≈ 0), the builder's
// EV is trustworthy. If it's optimistic (actual < predicted), the +EV the
// builder shows is a de-vig artifact and EV must be discounted before betting.
//
// IMPORTANT — this is data-gated. The market prob is only logged when odds
// covered the pick at verdict time; today almost no SETTLED rows carry it, so
// the report will show n≈0 until production verdicts log market coverage at
// scale and those games settle. The rig is correct regardless of sample size;
// read the coverage line it prints before trusting any bin.
//
// Run locally (needs AXIOM_TOKEN in .env.local):
//   node scripts/calibrate-market.mjs   |   npm run calibrate-market
//
// marketReliability is exported (pure) for the smoke + future backtest reuse.

import { pathToFileURL } from "node:url";
import { loadEnvLocal } from "./_env.mjs";
import { fetchJoinedVerdicts, settledBettable } from "./_axiom.mjs";

// Reliability bins over predicted P(hit). Coarser in the tails (sparse) and
// where the builder actually bets (≥0.55 is where a 3-leg power clears +EV).
export const DEFAULT_BINS = [
  [0, 0.5], [0.5, 0.55], [0.55, 0.6], [0.6, 0.65],
  [0.65, 0.7], [0.7, 0.75], [0.75, 0.8], [0.8, 0.9], [0.9, 1.0001],
];

const round = (x, d = 3) => (typeof x === "number" ? Math.round(x * 10 ** d) / 10 ** d : x);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Reliability of a predicted probability against binary outcomes.
 *
 * @param {Array<{market_fair_at_line:number, hit_or_miss:string, league?:string, odds_type?:string}>} settled
 * @param {Object} [opts]
 * @param {Array<[number,number]>} [opts.bins=DEFAULT_BINS]
 * @returns {{
 *   n:number, pred_avg:number|null, actual_hit:number|null, brier:number|null,
 *   bins:Array<{lo:number,hi:number,n:number,pred_avg:number,actual_hit:number,gap:number}>,
 *   by_league:Object, by_odds_type:Object
 * }}
 */
export function marketReliability(settled, { bins = DEFAULT_BINS } = {}) {
  const rows = (settled || []).filter(
    (r) => typeof r.market_fair_at_line === "number" && (r.hit_or_miss === "hit" || r.hit_or_miss === "miss"),
  );
  const isHit = (r) => (r.hit_or_miss === "hit" ? 1 : 0);

  const slice = (subset) => {
    if (!subset.length) return { n: 0, pred_avg: null, actual_hit: null };
    return {
      n: subset.length,
      pred_avg: round(mean(subset.map((r) => r.market_fair_at_line))),
      actual_hit: round(mean(subset.map(isHit))),
    };
  };

  const binned = [];
  for (const [lo, hi] of bins) {
    const b = rows.filter((r) => r.market_fair_at_line >= lo && r.market_fair_at_line < hi);
    if (!b.length) continue;
    const pred = mean(b.map((r) => r.market_fair_at_line));
    const act = mean(b.map(isHit));
    binned.push({ lo, hi, n: b.length, pred_avg: round(pred), actual_hit: round(act), gap: round(act - pred) });
  }

  const groupBy = (keyFn) => {
    const out = {};
    for (const r of rows) {
      const k = keyFn(r) || "?";
      (out[k] ??= []).push(r);
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, slice(v)]));
  };

  const brier = rows.length
    ? round(mean(rows.map((r) => (r.market_fair_at_line - isHit(r)) ** 2)), 4)
    : null;

  return {
    n: rows.length,
    pred_avg: rows.length ? round(mean(rows.map((r) => r.market_fair_at_line))) : null,
    actual_hit: rows.length ? round(mean(rows.map(isHit))) : null,
    brier,
    bins: binned,
    by_league: groupBy((r) => r.league),
    by_odds_type: groupBy((r) => (r.odds_type ? String(r.odds_type).toLowerCase() : "unknown")),
  };
}

function printSlice(label, s) {
  if (!s || !s.n) { console.log(`  ${label.padEnd(12)} n=0`); return; }
  const gap = s.actual_hit - s.pred_avg;
  console.log(`  ${label.padEnd(12)} n=${String(s.n).padStart(4)}  pred ${(s.pred_avg * 100).toFixed(1)}%  actual ${(s.actual_hit * 100).toFixed(1)}%  gap ${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`);
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) {
    console.error("AXIOM_TOKEN not set in .env.local — cannot read graded history.");
    process.exit(1);
  }
  console.log("=== calibrate-market (reliability of the de-vig prob the slate builder bets on) ===");
  const { joined, verdictCount, outcomeCount } = await fetchJoinedVerdicts(token, dataset);
  const settled = settledBettable(joined);
  const withMkt = settled.filter((r) => typeof r.market_fair_at_line === "number");

  // Coverage FIRST — every bin below is meaningless without it.
  console.log(`\nCOVERAGE: ${withMkt.length}/${settled.length} settled bettable rows carry market_fair_at_line ` +
    `(of ${verdictCount} verdicts, ${outcomeCount} outcomes).`);
  if (withMkt.length < 30) {
    console.log("  ⚠️  Too few market-priced settled rows to calibrate. The slate builder is\n" +
      "      betting on UN-VALIDATED de-vig probs. Root cause: market_fair_at_line is only\n" +
      "      logged when odds cover the pick at verdict time — confirm production analyze-all\n" +
      "      seeds a populated odds store, then let the daily grader accrue the sample.");
  }

  const rel = marketReliability(withMkt);
  if (rel.n) {
    console.log(`\nOVERALL: n=${rel.n}  pred ${(rel.pred_avg * 100).toFixed(1)}%  actual ${(rel.actual_hit * 100).toFixed(1)}%  ` +
      `Brier ${rel.brier}  (gap ${rel.actual_hit - rel.pred_avg >= 0 ? "+" : ""}${((rel.actual_hit - rel.pred_avg) * 100).toFixed(1)}% — ` +
      `${Math.abs(rel.actual_hit - rel.pred_avg) < 0.03 ? "calibrated" : rel.actual_hit < rel.pred_avg ? "OPTIMISTIC (discount EV)" : "conservative"})`);
    console.log("\nRELIABILITY (predicted-prob bin → realized hit rate):");
    console.log("  bin          n     pred    actual   gap");
    for (const b of rel.bins) {
      console.log(`  ${(b.lo.toFixed(2) + "-" + b.hi.toFixed(2)).padEnd(11)} ${String(b.n).padStart(4)}   ${(b.pred_avg * 100).toFixed(1)}%   ${(b.actual_hit * 100).toFixed(1)}%   ${b.gap >= 0 ? "+" : ""}${(b.gap * 100).toFixed(1)}%`);
    }
    console.log("\nBY LEAGUE:");
    for (const [k, s] of Object.entries(rel.by_league)) printSlice(k, s);
    console.log("BY ODDS TYPE:");
    for (const [k, s] of Object.entries(rel.by_odds_type)) printSlice(k, s);
  }
  console.log("\nCAVEAT: face-value de-vig assumes the market prob IS the true P(hit). This rig\n" +
    "tests that. A persistent negative gap ⇒ discount EV in buildSlate before betting.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvLocal();
  main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
