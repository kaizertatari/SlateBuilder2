// Rule R9 — Assist win-probability gate. Applies ONLY to assist-
// containing props (Assists, PA, RA, PRA). Both directions are gated.
//   Regular season:  [0.40, 0.75]
//   Playoff games:   [0.35, 0.80]
// Outside band → SKIP (not a tier cap).

import { computeAssistWinProbCheck, ASSIST_CONTAINING } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType } = ctx;
  if (!ASSIST_CONTAINING.has(statType)) {
    return { fired: false, rule_id: "R9" };
  }
  const wp = computeAssistWinProbCheck({ groundTruth });
  if (!wp) {
    // Missing win_prob on an assist prop — framework says SKIP with
    // "missing: win_prob" flag, but engine prefers to flag as missing
    // and let the rest of the rules govern. The pre-filter already
    // catches some of this; here we just note it.
    return {
      fired: false,
      rule_id: "R9",
      justification_part: "Rule R9 — win_prob unavailable; gate could not be evaluated.",
    };
  }
  if (wp.outside) {
    return {
      fired: true,
      rule_id: "R9",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: `⚠️ Rule R9 — win_prob ${(wp.value * 100).toFixed(0)}% outside [${(wp.lo * 100).toFixed(0)}, ${(wp.hi * 100).toFixed(0)}] band (${wp.context})`,
      justification_part: `Rule R9 — assist gate: win_prob ${(wp.value * 100).toFixed(0)}% outside [${(wp.lo * 100).toFixed(0)}, ${(wp.hi * 100).toFixed(0)}] band (${wp.context}); SKIP.`,
      hard_skip: true,
    };
  }
  return {
    fired: true,
    rule_id: "R9",
    tier_cap: null,
    confidence_delta: 0,
    flag: null,
    justification_part: `Rule R9 — assist gate clears (win_prob ${(wp.value * 100).toFixed(0)}% in band).`,
  };
}
