// DATA-PROVENANCE GUARD (framework line 142).
// When groundTruth.data_warnings contains any "prior_season_*" entry,
// cap the verdict at A-tier max and add a flag listing the entries.
// Each prior-season entry counts as one independent signal MISSING for
// the S-tier gate (S-tier requires 3+ independent signals).

export function apply(ctx) {
  const { groundTruth } = ctx;
  const warnings = groundTruth?.data_warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) {
    return { fired: false, rule_id: "provenance" };
  }
  const priorEntries = warnings.filter((w) => typeof w === "string" && w.startsWith("prior_season_"));
  if (priorEntries.length === 0) {
    return { fired: false, rule_id: "provenance" };
  }
  return {
    fired: true,
    rule_id: "provenance",
    tier_cap: "A",
    confidence_delta: -ctx.weights.suppressor_penalty * 0.5,
    flag: `⚠️ prior-season baseline (${priorEntries.join(", ")})`,
    justification_part: `Data-provenance guard — prior-season fallback active for ${priorEntries.join(", ")}; A-tier max.`,
    missing_signals: priorEntries.length,
  };
}
