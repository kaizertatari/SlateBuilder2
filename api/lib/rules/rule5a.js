// Rule 5a — OVER buffer (per-stat scaling, road deduction, variance
// addendum, post-outlier widening, FT-shooter extra).
// Hard SKIP on OVER when the buffer check fails. No effect on UNDER.

import { computeOverBufferCheck, getBaselines, scaleFor } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (direction !== "OVER") {
    return { fired: false, rule_id: "5a" };
  }
  const { seasonAvg, l5Avg, l5WeightedUsed } = getBaselines({ groundTruth, statType });
  if (seasonAvg == null && l5Avg == null) {
    // Missing baseline — engine's hard-gate path will catch it via Rule 5a,
    // but report it here cleanly so the verdict gets a usable flag.
    return {
      fired: true,
      rule_id: "5a",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: "⚠️ missing: baseline (5a)",
      justification_part: "Rule 5a — no baseline available; cannot evaluate OVER buffer.",
      hard_skip: true,
    };
  }
  const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed });
  if (!buf) return { fired: false, rule_id: "5a" };

  const scale = scaleFor(groundTruth);
  if (!buf.passes) {
    return {
      fired: true,
      rule_id: "5a",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: `⚠️ Rule 5a OVER buffer failed (line ${line} > required ${buf.required.toFixed(2)})`,
      justification_part: `Rule 5a — governing=${buf.governing} baseline=${buf.baseline.toFixed(2)}, road-adjusted=${buf.adjusted.toFixed(2)}, buffer=${buf.buffer.toFixed(2)}; line ${line} exceeds required ${buf.required.toFixed(2)}.`,
      hard_skip: true,
    };
  }

  // Pass — emit a justification fragment describing the math.
  // Signal bonus is computed by the engine when the buffer clears
  // cleanly (>3 pts of edge); rule5a itself just reports.
  const edge = buf.adjusted - line;
  const parts = [`Rule 5a — governing=${buf.governing} baseline=${buf.baseline.toFixed(2)}`];
  if (buf.adjusted !== buf.baseline) parts.push(`road-adjusted=${buf.adjusted.toFixed(2)} (-${scale.road_deduction_pts} away)`);
  parts.push(`line=${line}, edge=${edge.toFixed(2)} (buffer ${buf.buffer.toFixed(2)})`);
  if (buf.outlierActive) parts.push("post-outlier widening active");
  if (buf.poorFt) parts.push("poor FT shooter +2 buffer");

  return {
    fired: true,
    rule_id: "5a",
    tier_cap: null,
    confidence_delta: 0, // engine handles edge bonus globally
    flag: null,
    justification_part: parts.join("; "),
    // Surface buf so engine can compute edge_unit_bonus once at the
    // top level instead of every rule redoing the math.
    _buf: buf,
  };
}
