// Rule: WC Minutes — the soccer analog of the injury/minutes gates
// (WC_FRAMEWORK_SPEC.md §4.2, §6.2, §6.5, §10.3). Minutes are the dominant
// variance source in soccer (subs at ~60–75', group-stage rotation), so:
//
//   • position–stat incoherence (spec §10.3):
//       GK on an outfield-stat prop (shots/SOT/tackles/clearances/fantasy)
//         → hard SKIP (PP posts them; noise)
//       non-GK on Goalie Saves → hard SKIP
//       Passes Attempted is position-agnostic (keepers attempt ~20–35)
//   • OVER with expected minutes < 60         → hard SKIP
//   • expected minutes 60–70 (rotation risk)  → suppressor + A cap (OVER side)
//   • confirmed/expected starter (≥75)        → 1 signal
//
// UNDER picks are not gated on low minutes — sub risk supports the under —
// but get no boost either (v1 logs; calibrate first). WC-only.

import { WC_STAT_MODEL } from "../prop-types.js";

const OVER_MIN_GATE = 60;
const ROTATION_RISK_MAX = 70;
const STARTER_MIN = 75;

export function apply(ctx) {
  const { groundTruth, statType, direction } = ctx;
  if (String(groundTruth?.league ?? "").toUpperCase() !== "WC") {
    return { fired: false, rule_id: "wc-minutes" };
  }

  const position = groundTruth?.info?.position ?? null;
  const gkPolicy = WC_STAT_MODEL[statType]?.gk ?? "skip";
  if (position === "Goalkeeper" && gkPolicy === "skip") {
    return {
      fired: true,
      rule_id: "wc-minutes",
      hard_skip: true,
      tier_cap: "SKIP",
      flag: "⛔ Goalkeeper on an outfield-stat prop — SKIP",
      justification_part: "Goalkeeper on an outfield-stat prop — framework abstains (spec §6.5/§10.3).",
    };
  }
  if (position !== "Goalkeeper" && gkPolicy === "only") {
    return {
      fired: true,
      rule_id: "wc-minutes",
      hard_skip: true,
      tier_cap: "SKIP",
      flag: `⛔ ${statType} requires a Goalkeeper — position is ${position ?? "unknown"}, SKIP`,
      justification_part: `Position–stat incoherence: ${statType} is keeper-only and the player is ${position ?? "unlisted"} (spec §10.3).`,
    };
  }

  const em = groundTruth?.soccer?.expected_minutes;
  const src = groundTruth?.soccer?.minutes_source ?? "unknown";
  if (typeof em !== "number") {
    // Shouldn't happen (soccer-truth always sets it) — treat as rotation risk.
    return {
      fired: true,
      rule_id: "wc-minutes",
      suppressor: true,
      tier_cap: "A",
      flag: "⚠️ Expected minutes unknown — rotation-risk suppressor",
      justification_part: "Minutes: unknown — suppressed.",
    };
  }

  if (direction === "OVER" && em < OVER_MIN_GATE) {
    return {
      fired: true,
      rule_id: "wc-minutes",
      hard_skip: true,
      tier_cap: "SKIP",
      flag: `⛔ Expected minutes ${em} (<${OVER_MIN_GATE}) — OVER gated`,
      justification_part: `Minutes: E[min]=${em} (${src}) below the OVER gate — SKIP.`,
    };
  }

  if (direction === "OVER" && em <= ROTATION_RISK_MAX) {
    return {
      fired: true,
      rule_id: "wc-minutes",
      suppressor: true,
      tier_cap: "A",
      confidence_delta: -3,
      flag: `⚠️ Rotation/sub risk — E[min]=${em}`,
      justification_part: `Minutes: E[min]=${em} (${src}) — rotation-risk suppressor on the OVER.`,
    };
  }

  if (em >= STARTER_MIN) {
    return {
      fired: true,
      rule_id: "wc-minutes",
      signals_added: 1,
      justification_part: `Minutes: expected starter, E[min]=${em} (${src}).`,
    };
  }

  // UNDER with low/medium minutes, or mid-band OVER: neutral note only.
  return {
    fired: true,
    rule_id: "wc-minutes",
    justification_part: `Minutes: E[min]=${em} (${src}).`,
  };
}
