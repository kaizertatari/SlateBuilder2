// Rule 5h — FT-leak modifier (named defender Tier 1, team-rank Tier 2).
// Applies to scoring props when player's FTA volume is high enough
// (≥ ft_floor_gate_fta) regardless of direction. FT scoring is gated
// separately by Rule 5i — this rule modifies the FG side only.
//
// TIER 1: primary_defender confirmed (share_pct ≥ 0.40, n_games ≥ 2).
//         Apply 20-25% FG output reduction. Same authority regular + playoff.
// TIER 2: primary_defender null/unconfirmed AND opponent.def_rank ≤
//         scale.def_rank_tier2. Apply 10-15% FG reduction. In playoff
//         games, cap at 10% (regular-season aggregate is a weaker signal).
// DO NOT INVOKE when neither tier 1 nor tier 2 conditions hold.

import { scaleFor, isPlayoffGame } from "./_helpers.js";

const SCORING_PROPS = new Set(["Points", "PR", "PA", "PRA"]);

export function apply(ctx) {
  const { groundTruth, statType } = ctx;
  if (!SCORING_PROPS.has(statType)) return { fired: false, rule_id: "5h" };
  const scale = scaleFor(groundTruth);
  const fta = groundTruth?.season?.averages?.fta ?? null;
  if (fta == null || fta < scale.ft_floor_gate_fta) {
    return { fired: false, rule_id: "5h" };
  }

  const opp = groundTruth?.opponent_defense ?? null;
  const defender = opp?.primary_defender ?? null;
  const confirmedDef = defender && defender.confirmed === true
    && (defender.share_pct ?? 0) >= 0.40
    && (defender.n_games ?? 0) >= 2;
  const defRank = opp?.def_rank ?? null;
  const playoff = isPlayoffGame(groundTruth);

  if (confirmedDef) {
    // Tier 1 — full strength.
    return {
      fired: true,
      rule_id: "5h",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag: `⚠️ Rule 5h Tier 1 — ${defender.player} as primary defender (${(defender.share_pct * 100).toFixed(0)}% over ${defender.n_games} GP)`,
      justification_part: `Rule 5h Tier 1 — confirmed primary defender ${defender.player}; FG output suppressed 20-25%.`,
      suppressor: true,
    };
  }

  if (defRank != null && defRank <= scale.def_rank_tier2) {
    // Tier 2 — proxy.
    const tier2Flag = playoff
      ? "⚠️ 5h TIER 2 in playoff context (reg-season def_rank may not reflect playoff gameplan)"
      : "⚠️ 5h applied via team-rank proxy (no named-defender data)";
    return {
      fired: true,
      rule_id: "5h",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag: tier2Flag,
      justification_part: `Rule 5h Tier 2 — opponent def_rank ${defRank} (top tier ${scale.def_rank_tier2}); FG output suppressed 10-15%${playoff ? " (capped at 10% in playoff context)" : ""}.`,
      suppressor: true,
    };
  }

  return { fired: false, rule_id: "5h" };
}
