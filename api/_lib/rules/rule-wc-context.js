// Rule: WC Context — tournament-structure gates and flags
// (WC_FRAMEWORK_SPEC.md §6.3, §6.4):
//
//   • Dead rubber (group match 3, nothing at stake): SKIP OVERs when the
//     gatherer flags it; v1's gatherer emits null (ESPN standings
//     enrichment pending), in which case nothing fires.
//   • Knockout settlement: PrizePicks settles soccer on 90' + stoppage —
//     extra time is EXCLUDED. No numeric adjustment (books price 90' too);
//     mandatory advisory flag from the Round of 32 on.
//
// WC-only; no-ops for basketball leagues.

export function apply(ctx) {
  const { groundTruth, direction } = ctx;
  if (String(groundTruth?.league ?? "").toUpperCase() !== "WC") {
    return { fired: false, rule_id: "wc-context" };
  }

  const deadRubber = groundTruth?.game?.dead_rubber === true;
  if (deadRubber && direction === "OVER") {
    return {
      fired: true,
      rule_id: "wc-context",
      hard_skip: true,
      tier_cap: "SKIP",
      flag: "⛔ Dead rubber — rotation/motivation risk, OVER gated",
      justification_part: "Context: dead-rubber group match — OVER gated (spec §6.3).",
    };
  }

  if (groundTruth?.game?.knockout === true) {
    return {
      fired: true,
      rule_id: "wc-context",
      flag: "ℹ️ Knockout match — settles on 90' + stoppage only (no extra time)",
      justification_part: "Context: knockout — PrizePicks settles on regulation only.",
    };
  }

  return { fired: false, rule_id: "wc-context" };
}
