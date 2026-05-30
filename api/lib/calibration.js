// Confidence → true-hit-probability calibration.
//
// The engine emits a `confidence` (0-100) and an `odds_type`
// (goblin/standard/demon). Neither is, by itself, a probability — the Axiom
// audit showed `confidence` is monotonic but overconfident, and that its
// reliability depends heavily on line type (a goblin at "80" ≠ a standard at
// "80"). This module maps (odds_type × confidence-bucket) → a calibrated
// P(hit), learned from graded outcomes by scripts/build-calibration.mjs.
//
// The table bakes in Bayesian shrinkage toward the odds_type base rate (and
// that toward 0.5), so thin/absent cells return something close to the prior
// rather than a noisy empirical rate. With only a few hundred graded props
// today, that conservatism is the point — the slate builder must NOT see fake
// edge from an n=4 cell. As the daily grader accrues data, regenerate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PRIOR = 0.5;

// SINGLE SOURCE OF TRUTH for bucketing — imported by both the generator and
// the runtime lookup so the keys always agree. If you change these edges,
// regenerate data/calibration.json.
export function confidenceBucket(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return "unknown";
  if (c < 60) return "<60";
  if (c < 70) return "60-69";
  if (c < 80) return "70-79";
  if (c < 90) return "80-89";
  return "90+";
}

let _table = null;

function loadTable() {
  if (_table) return _table;
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/calibration.json");
    _table = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    // No artifact yet (fresh checkout / unconfigured) — degrade to priors so
    // the engine and builder still run. Everything resolves to 0.5.
    _table = { global_prior: DEFAULT_PRIOR, by_odds_type: {} };
  }
  return _table;
}

// Inject a table (backtest train/test splits, unit tests) without disk I/O.
export function setCalibrationTable(table) {
  _table = table;
}

export function loadCalibration() {
  return loadTable();
}

/**
 * Calibrated P(hit) for one scored leg.
 *
 * Fallback chain (each step already shrunk in the artifact):
 *   (odds_type × confidence bucket).p → odds_type.base_rate → global_prior
 *
 * @param {Object} a
 * @param {number} a.confidence  engine confidence 0-100
 * @param {string} [a.oddsType]  "goblin" | "standard" | "demon" | null
 * @returns {number} probability in [0,1]
 */
export function calibratedProb({ confidence, oddsType } = {}) {
  const t = loadTable();
  // Missing odds_type maps to its own "unknown" bucket — never folded into a
  // real line type (that would contaminate the line-type calibration). Slate
  // candidates always carry a real odds_type from the scrape, so this only
  // affects the single-prop path.
  const ot = oddsType ? String(oddsType).toLowerCase() : "unknown";
  const otTable = t.by_odds_type?.[ot];
  const bucket = confidenceBucket(confidence);
  const cell = otTable?.buckets?.[bucket];
  if (cell && typeof cell.p === "number") return cell.p;
  if (otTable && typeof otTable.base_rate === "number") return otTable.base_rate;
  return typeof t.global_prior === "number" ? t.global_prior : DEFAULT_PRIOR;
}

/**
 * Per-cell sample size backing a calibratedProb lookup — lets the builder
 * down-weight or distrust cells fit on too little data.
 */
export function calibrationSupport({ confidence, oddsType } = {}) {
  const t = loadTable();
  const ot = oddsType ? String(oddsType).toLowerCase() : "unknown";
  const otTable = t.by_odds_type?.[ot];
  const bucket = confidenceBucket(confidence);
  return otTable?.buckets?.[bucket]?.n ?? otTable?.n ?? 0;
}
