// Rule 5j — UNDER baseline gate (two-way mirror of 5a's OVER buffer
// check). Reads the same baseline math computeOverBufferCheck produces
// (weighted-L5, playoff override, current-series blend, H2H blend,
// road-adjusted) and decides whether the player's expected output
// supports or contradicts UNDER on this line.
//
//   adjusted > line + under_buffer  → hard-SKIP UNDER  (baseline says OVER)
//   adjusted < line - under_buffer  → ISSUE UNDER, edge-sized cap
//     edge ≥ 5  → no cap (S possible)
//     edge ≥ 3  → no cap (S possible via signal stacking)
//     buffer ≤ edge < 3 → A max
//   otherwise → fall through (marginal lines still need a mechanism)
//
// Mechanisms (rule-under-mechanism.js) become additive signals when this
// rule's ISSUE branch fires; they're not required for UNDER issuance
// once the baseline carries the verdict. When this rule SKIPs, no
// mechanism can override it.

import { computeOverBufferCheck, getBaselines, scaleFor } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (direction !== "UNDER") return { fired: false, rule_id: "5j" };

  const { seasonAvg, l5Avg, l5WeightedUsed } = getBaselines({ groundTruth, statType });
  if (seasonAvg == null && l5Avg == null) return { fired: false, rule_id: "5j" };

  const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed });
  if (!buf) return { fired: false, rule_id: "5j" };

  const scale = scaleFor(groundTruth);
  const underBuffer = scale.over_buffer_by_stat?.[statType] ?? scale.over_buffer_base;

  // SKIP case: baseline is above line by a full buffer → UNDER not supported.
  if (buf.adjusted - line >= underBuffer) {
    return {
      fired: true,
      rule_id: "5j",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: `⚠️ Rule 5j UNDER baseline gate — baseline ${buf.adjusted.toFixed(2)} ≥ line ${line} + ${underBuffer} buffer`,
      justification_part: `Rule 5j — governing=${buf.governing} baseline=${buf.baseline.toFixed(2)}${buf.adjusted !== buf.baseline ? `, road-adjusted=${buf.adjusted.toFixed(2)}` : ""}; baseline above line by ${(buf.adjusted - line).toFixed(2)} pts. UNDER not supported by baseline.`,
      hard_skip: true,
    };
  }

  // ISSUE case: baseline is below line by a full buffer → UNDER supported.
  const edge = line - buf.adjusted;
  if (edge >= underBuffer) {
    // Small-edge insurance: edges between buffer and 3pts can only reach
    // A max on baseline alone. Edges ≥3 leave the cap open; S-tier gate
    // decides promotion via signal stacking.
    const tierCap = edge < 3 ? "A" : null;
    return {
      fired: true,
      rule_id: "5j",
      tier_cap: tierCap,
      confidence_delta: 0, // engine applies edge × edge_unit_bonus once
      flag: null,
      justification_part: `Rule 5j — governing=${buf.governing} baseline=${buf.baseline.toFixed(2)}${buf.adjusted !== buf.baseline ? `, road-adjusted=${buf.adjusted.toFixed(2)}` : ""}; line ${line} above baseline by ${edge.toFixed(2)} pts. UNDER supported by baseline.`,
      _buf_under: { baseline: buf.baseline, adjusted: buf.adjusted, edge, governing: buf.governing },
    };
  }

  // Marginal: defer to mechanism gate.
  return {
    fired: false,
    rule_id: "5j",
    justification_part: `Rule 5j — baseline ${buf.adjusted.toFixed(2)} within ${underBuffer} of line ${line}; deferring to mechanism gate.`,
  };
}
