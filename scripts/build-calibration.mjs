// Build data/calibration.json from Axiom graded history.
//
// Joins verdict events (engine confidence + odds_type) against outcome events
// (hit/miss) and computes a calibrated P(hit) per (odds_type × confidence
// bucket) with two-level Bayesian shrinkage:
//
//   odds_type base rate : p_ot   = (hits_ot  + BETA · 0.5 ) / (n_ot  + BETA)
//   bucket cell         : p_cell = (hits_cell + ALPHA · p_ot) / (n_cell + ALPHA)
//
// With only a few hundred graded props, ALPHA/BETA are deliberately large so a
// thin cell sits near its odds_type base (and a thin odds_type near 0.5) — this
// stops the slate builder from seeing fake edge in an n=4 bucket.
//
// Run locally (needs AXIOM_TOKEN in .env.local):
//   node scripts/build-calibration.mjs   |   npm run build-calibration
//
// buildShrunkTable is exported so the backtest can rebuild calibration on a
// train-only split for out-of-sample evaluation.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvLocal } from "./_env.mjs";
import { confidenceBucket } from "../api/_lib/calibration.js";
import { fetchJoinedVerdicts, settledBettable } from "./_axiom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/calibration.json");

// Shrinkage strengths (pseudo-counts). Tune DOWN as graded volume grows.
export const ALPHA = 15; // bucket → odds_type base
export const BETA = 20; // odds_type base → 0.5
export const GLOBAL_PRIOR = 0.5;

const round = (x) => Math.round(x * 1000) / 1000;

/**
 * Build the shrunken calibration table from settled bettable rows.
 * Null odds_type is its OWN "unknown" bucket — never folded into a real line
 * type (that would contaminate the line-type calibration with unknown-type
 * outcomes and manufacture fake edge).
 */
export function buildShrunkTable(settled, { alpha = ALPHA, beta = BETA, globalPrior = GLOBAL_PRIOR } = {}) {
  const otTally = {};
  const cellTally = {};
  let gh = 0, gn = 0;
  for (const r of settled) {
    const ot = r.odds_type ? String(r.odds_type).toLowerCase() : "unknown";
    const b = confidenceBucket(r.confidence);
    const hit = r.hit_or_miss === "hit" ? 1 : 0;
    gh += hit; gn += 1;
    (otTally[ot] ??= { n: 0, h: 0 }); otTally[ot].n++; otTally[ot].h += hit;
    ((cellTally[ot] ??= {})[b] ??= { n: 0, h: 0 }); cellTally[ot][b].n++; cellTally[ot][b].h += hit;
  }
  const byOdds = {};
  for (const [ot, t] of Object.entries(otTally)) {
    const base = (t.h + beta * globalPrior) / (t.n + beta);
    const buckets = {};
    for (const [b, c] of Object.entries(cellTally[ot] || {})) {
      buckets[b] = { p: round((c.h + alpha * base) / (c.n + alpha)), n: c.n, raw_hit_rate: round(c.h / c.n) };
    }
    byOdds[ot] = { base_rate: round(base), n: t.n, raw_hit_rate: round(t.h / t.n), buckets };
  }
  return {
    generated_at: new Date().toISOString(),
    n_total: gn,
    global_prior: globalPrior,
    global_raw_hit_rate: gn ? round(gh / gn) : null,
    params: { alpha, beta },
    note: "Shrunken P(hit). raw_hit_rate fields are unshrunk empirical rates (small-n = noisy). Regenerate as the grader accrues data.",
    by_odds_type: byOdds,
  };
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) {
    console.error("AXIOM_TOKEN not set in .env.local — cannot build calibration.");
    process.exit(1);
  }
  console.log("=== build-calibration ===");
  const { joined, verdictCount, outcomeCount } = await fetchJoinedVerdicts(token, dataset);
  const settled = settledBettable(joined);
  console.log(`Joined ${joined.length}, settled & bettable ${settled.length} (from ${verdictCount} verdicts, ${outcomeCount} outcomes)`);
  if (settled.length === 0) {
    console.error("No settled bettable rows — nothing to calibrate. Is the grader running?");
    process.exit(1);
  }

  const table = buildShrunkTable(settled);
  await fs.writeFile(OUTPUT, JSON.stringify(table, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, OUTPUT)} (n_total=${table.n_total}, global raw ${(table.global_raw_hit_rate * 100).toFixed(1)}%)`);
  for (const [ot, t] of Object.entries(table.by_odds_type)) {
    console.log(`  ${ot.padEnd(9)} base ${(t.base_rate * 100).toFixed(1)}% (raw ${(t.raw_hit_rate * 100).toFixed(1)}%, n=${t.n})`);
    for (const [b, c] of Object.entries(t.buckets)) {
      console.log(`      ${b.padEnd(6)} p=${(c.p * 100).toFixed(1)}%  (raw ${(c.raw_hit_rate * 100).toFixed(1)}%, n=${c.n})`);
    }
  }
}

// Only hit Axiom when run directly — safe to import buildShrunkTable elsewhere.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvLocal();
  main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
