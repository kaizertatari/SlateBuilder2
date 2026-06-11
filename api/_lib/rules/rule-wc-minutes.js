// Rule: WC Minutes — the soccer analog of the injury/minutes gates
// (WC_FRAMEWORK_SPEC.md §4.2, §6.2, §6.5). Minutes are the dominant variance
// source in soccer (subs at ~60–75', group-stage rotation), so:
//
//   • Goalkeeper on a Shots/SOT prop          → hard SKIP (PP posts them; noise)
//   • OVER with expected minutes < 60         → hard SKIP
//   • expected minutes 60–70 (rotation risk)  → suppressor + A cap (OVER side)
//   • confirmed/expected starter (≥75)        → 1 signal
//
// UNDER picks are not gated on low minutes — sub risk supports the under —
// but get no boost either (v1 logs; calibrate first). WC-only.

const OVER_MIN_GATE = 60;
const ROTATION_RISK_MAX = 70;
const STARTER_MIN = 75;

export function apply(ctx) {
  const { groundTruth, direction } = ctx;
  if (String(groundTruth?.league ?? "").toUpperCase() !== "WC") {
    return { fired: false, rule_id: "wc-minutes" };
  }

  const position = groundTruth?.info?.position ?? null;
  if (position === "Goalkeeper") {
    return {
      fired: true,
      rule_id: "wc-minutes",
      hard_skip: true,
      tier_cap: "SKIP",
      flag: "⛔ Goalkeeper shots prop — SKIP",
      justification_part: "Goalkeeper on a shots-family prop — framework abstains (spec §6.5).",
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
