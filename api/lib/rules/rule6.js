// Rule 6 — Post-Injury Return Gate + Injury-Type Modulation.
//   Base gate: first 5 games back = A-tier max. Lower-leg / Achilles
//   defer ALL picks first 10 games back (hard SKIP).
//   Body-region modulation (framework 218-225):
//     rib / oblique / back:  -20% reb expectation, reb OVER A-tier max
//     shoulder / elbow:      +25% variance, 3PM SKIP
//     hand / wrist:          treat FT% as L5; 3PM SKIP
//     knee:                  -1 reb floor
//
// We don't have a games-since-return counter today — composeGroundTruth's
// player_recent.is_listed_injured boolean is the only structured signal.
// When is_listed_injured is true we conservatively assume "within first
// 5 games back" (the post-injury gate). Achilles/lower-leg trigger the
// 10-game SKIP regardless of count.

// (No helpers imported — rule6 reads injuries / regions / player_recent directly.)

const REBOUND_FAMILY = new Set(["Rebounds", "PR", "RA", "PRA"]);
const THREE_PT = "3-Pointers Made";

export function apply(ctx) {
  const { groundTruth, statType } = ctx;
  const isInjured = !!groundTruth?.player_recent?.is_listed_injured;
  const regions = groundTruth?.injury_regions?.[groundTruth?.info?.full_name] ?? null;

  // Achilles / lower-leg: 10-game hard SKIP regardless of direction.
  if (regions && (regions.achilles || regions.lower_leg)) {
    return {
      fired: true,
      rule_id: "6",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: "⚠️ Rule 6 — Achilles/lower-leg injury, defer all picks first 10 games back",
      justification_part: `Rule 6 — ${regions.achilles ? "Achilles" : "lower-leg"} injury history; hard SKIP.`,
      hard_skip: true,
    };
  }

  if (!isInjured) return { fired: false, rule_id: "6" };

  // Body-region modulation when post-injury gate is active.
  if (regions) {
    if (statType === THREE_PT && (regions.shoulder || regions.elbow || regions.hand || regions.wrist)) {
      return {
        fired: true,
        rule_id: "6",
        tier_cap: "SKIP",
        confidence_delta: 0,
        flag: "⚠️ Rule 6 — upper-body injury affecting shot; 3PM SKIP",
        justification_part: `Rule 6 — ${regions.shoulder ? "shoulder" : regions.elbow ? "elbow" : regions.hand ? "hand" : "wrist"} injury affects shooting; 3PM picks deferred.`,
        hard_skip: true,
      };
    }
    if (REBOUND_FAMILY.has(statType) && (regions.rib || regions.oblique || regions.back || regions.knee)) {
      return {
        fired: true,
        rule_id: "6",
        tier_cap: "A",
        confidence_delta: -ctx.weights.suppressor_penalty,
        flag: "⚠️ Rule 6 — body-region modulation reduces rebound expectation",
        justification_part: `Rule 6 — ${regions.rib ? "rib" : regions.oblique ? "oblique" : regions.back ? "back" : "knee"} injury suppresses rebounds; A-tier max.`,
        suppressor: true,
      };
    }
  }

  // Base post-injury gate.
  return {
    fired: true,
    rule_id: "6",
    tier_cap: "A",
    confidence_delta: -ctx.weights.suppressor_penalty,
    flag: "⚠️ Rule 6 — post-injury return gate (first 5 games back, A-tier max)",
    justification_part: "Rule 6 — player listed injured / in post-return window; A-tier max.",
    suppressor: true,
  };
}
