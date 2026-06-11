// Playoff game-number caps.
//   Game 1: VERDICT STILL ISSUED at B-tier max baseline, flags MUST
//           include "⚠️ Game 1 — model recommends SKIP". Exception:
//           UNDER via Mechanism 1 → A-tier max, no SKIP advisory.
//   Game 2: A-tier max ALL props both directions (playoff only).
//   Game 3+: standard playoff rules apply (no cap from this rule).

import { isPlayoffGame } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, direction } = ctx;
  if (!isPlayoffGame(groundTruth)) return { fired: false, rule_id: "game-cap" };
  const gn = groundTruth?.series?.next_game_number ?? null;
  if (gn == null) return { fired: false, rule_id: "game-cap" };

  if (gn === 1) {
    const mech1 = groundTruth?.mechanisms?.mech1?.confirmed === true;
    if (direction === "UNDER" && mech1) {
      // Game 1 exception — UNDER via Mechanism 1.
      return {
        fired: true,
        rule_id: "game-cap-g1-mech1",
        tier_cap: "A",
        confidence_delta: 0,
        flag: null,
        justification_part: "Game 1 — UNDER via confirmed Mechanism 1; A-tier max, no SKIP advisory.",
      };
    }
    return {
      fired: true,
      rule_id: "game-cap-g1",
      tier_cap: "B",
      confidence_delta: -ctx.weights.game1_penalty,
      flag: "⚠️ Game 1 — model recommends SKIP (Game 1 hit 18.8% in v3.3 sample)",
      justification_part: "Game 1 advisory — verdict capped at B-tier; framework recommends SKIP.",
    };
  }
  if (gn === 2) {
    return {
      fired: true,
      rule_id: "game-cap-g2",
      tier_cap: "A",
      confidence_delta: 0,
      flag: "⚠️ Game 2 hard cap (A-tier max both directions)",
      justification_part: "Game 2 — playoff hard cap A-tier max both directions.",
    };
  }
  return { fired: false, rule_id: "game-cap" };
}
