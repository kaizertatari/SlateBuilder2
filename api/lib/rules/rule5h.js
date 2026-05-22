// Rule 5h — FT-leak / elite-defense modifier.
//
// Scoring-family path (Points / PR / PA / PRA / Fantasy Score):
//   Applies when the player's FTA volume is high enough (≥ ft_floor_gate_fta).
//   TIER 1: confirmed primary_defender (share ≥ 0.40, ≥ 2 GP). 20-25% FG
//           reduction. Same authority regular + playoff.
//   TIER 2: no Tier 1 + opponent.def_rank ≤ scale.def_rank_tier2.
//           10-15% reduction; capped 10% in playoff (reg-season aggregate
//           is a weaker signal). Fantasy Score uses the same tier-2 path
//           since it's Points-dominant under the FanDuel formula.
//
// 3-Pointers Attempted (light path):
//   Tier-2 only (no named-defender data for shot-volume defense).
//   Volume-gated by season fg3a ≥ 3 — must actually be an active 3pt
//   shooter for elite perimeter defense to suppress volume. 10-15% cap
//   (10% in playoff). No Tier 1 — defender match-ups discipline FG
//   pct, not attempts.
//
// DO NOT INVOKE outside these stat families.

import { scaleFor, isPlayoffGame } from "./_helpers.js";

const SCORING_PROPS = new Set(["Points", "PR", "PA", "PRA", "Fantasy Score"]);
const THREEPA_PROPS = new Set(["3-Pointers Attempted"]);
// Minimum season fg3a to consider perimeter-defense suppression
// meaningful — same numeric floor for NBA + WNBA (a 3-attempt shooter
// is "active" in either league).
const THREEPA_VOLUME_GATE = 3;

export function apply(ctx) {
  const { groundTruth, statType } = ctx;
  const scale = scaleFor(groundTruth);
  const opp = groundTruth?.opponent_defense ?? null;
  const defRank = opp?.def_rank ?? null;
  const playoff = isPlayoffGame(groundTruth);

  // 3PA-only light path — tier-2 perimeter defense, volume-gated by fg3a.
  if (THREEPA_PROPS.has(statType)) {
    const fg3a = groundTruth?.season?.averages?.fg3a ?? null;
    if (fg3a == null || fg3a < THREEPA_VOLUME_GATE) {
      return { fired: false, rule_id: "5h" };
    }
    if (defRank == null || defRank > scale.def_rank_tier2) {
      return { fired: false, rule_id: "5h" };
    }
    const flag = playoff
      ? "⚠️ 5h TIER 2 (3PA, playoff — reg-season perimeter def_rank may not reflect playoff scheme)"
      : "⚠️ 5h applied via perimeter def_rank proxy (3PA volume)";
    return {
      fired: true,
      rule_id: "5h",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag,
      justification_part: `Rule 5h Tier 2 (3PA) — opponent def_rank ${defRank} (top tier ${scale.def_rank_tier2}); 3PT volume suppressed 10-15%${playoff ? " (capped at 10% in playoff context)" : ""}.`,
      suppressor: true,
    };
  }

  if (!SCORING_PROPS.has(statType)) return { fired: false, rule_id: "5h" };
  const fta = groundTruth?.season?.averages?.fta ?? null;
  if (fta == null || fta < scale.ft_floor_gate_fta) {
    return { fired: false, rule_id: "5h" };
  }

  const defender = opp?.primary_defender ?? null;
  const confirmedDef = defender && defender.confirmed === true
    && (defender.share_pct ?? 0) >= 0.40
    && (defender.n_games ?? 0) >= 2;

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
