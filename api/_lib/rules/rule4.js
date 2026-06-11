// Rule 4 — alpha + multi-star compression.
//   4b "sole alpha boost" — when active on a player, UNDER is invalid
//      regardless of mechanism. Today's framework expresses "active"
//      qualitatively; engine version: player's season.averages.ppg is
//      >= 1.6× the next-highest scorer on their team's known roster
//      AND no other teammate exceeds multi_star_ppg_threshold. Since
//      we lack a full roster ppg map, fall back to a simple rule:
//      player.ppg ≥ 2× multi_star_ppg_threshold (e.g., NBA ≥30, WNBA
//      ≥24) AND no own-team OUT/DOUBTFUL teammate at threshold. Tunable.
//   4c "multi-star compression" — 3rd/4th scorer on a team with 3+
//      players at multi_star_ppg_threshold+ PPG, favored 10+ pts =
//      A-tier max OVER. Compounds with 5f → B-tier max with SKIP
//      advisory. Without a per-teammate ppg map, approximate by
//      counting OUT/DOUBTFUL teammates above threshold (mechanism 2's
//      teammate field). If ≥1 such teammate exists AND win_prob ≥ 0.70
//      (favored), assume compression is active.

import { scaleFor, isPlayoffGame } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, direction } = ctx;
  const scale = scaleFor(groundTruth);
  const ppg = groundTruth?.season?.averages?.ppg ?? null;
  const wp = groundTruth?.win_prob?.player_team_pct ?? null;
  const playoff = isPlayoffGame(groundTruth);

  // 4b sole-alpha — UNDER invalid.
  const teammateOut = groundTruth?.mechanisms?.mech2?.confirmed === true;
  const isSoleAlpha = ppg != null
    && ppg >= 2 * scale.multi_star_ppg_threshold
    && !teammateOut;

  if (direction === "UNDER" && isSoleAlpha) {
    return {
      fired: true,
      rule_id: "4b",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: "⚠️ Rule 4b — sole alpha boost active, UNDER invalid",
      justification_part: `Rule 4b — sole-alpha boost (season ppg ${ppg.toFixed(1)} ≥ ${2 * scale.multi_star_ppg_threshold}); UNDER invalid.`,
      hard_skip: true,
    };
  }

  // 4c multi-star compression on OVER.
  if (direction === "OVER" && teammateOut && wp != null && wp >= 0.70) {
    if (playoff) {
      // Playoff context flag — framework line 137 acknowledges reg-season
      // counts may not reflect playoff rotation.
      return {
        fired: true,
        rule_id: "4c",
        tier_cap: "A",
        confidence_delta: -ctx.weights.suppressor_penalty,
        flag: "⚠️ 4c applied via reg-season scoring counts (playoff rotation may differ)",
        justification_part: `Rule 4c — teammate OUT/DOUBTFUL at multi-star threshold + favored ${(wp * 100).toFixed(0)}%; OVER capped at A-tier (playoff caveat).`,
        suppressor: true,
      };
    }
    return {
      fired: true,
      rule_id: "4c",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag: "⚠️ Rule 4c — multi-star compression",
      justification_part: `Rule 4c — teammate OUT/DOUBTFUL at multi-star threshold + favored ${(wp * 100).toFixed(0)}%; OVER capped at A-tier.`,
      suppressor: true,
    };
  }

  return { fired: false, rule_id: "4" };
}
