// S-Tier Promotion Gate (framework lines 241-247).
//
// ALL of the following must pass to qualify for S-tier:
//   1. Line clears the OVER buffer (already enforced by rule5a).
//   2. 3+ independent signals align.
//   3. No active suppressor flag.
//   4. Confidence beats BOTH season avg AND L5 avg (weighted L5 if present).
//   5. Playoff: confidence ≥ 85%.
//   6. Playoff: Game 3+ in series.
//
// This module runs LAST in the engine pipeline — it inspects the
// accumulated results from earlier rule modules to decide whether to
// allow S, or cap to A. It does NOT issue S itself; the engine's tier
// resolver does that based on the cumulative tier_cap chain.

import { isPlayoffGame, getBaselines } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line, _state } = ctx;
  if (direction !== "OVER") return { fired: false, rule_id: "s-tier" };

  // _state is provided by the engine when this rule runs last —
  // contains the accumulated suppressor count + buf result from
  // rule5a. Fail gracefully if absent (treat as no-S).
  const suppressors = _state?.suppressorCount ?? 0;
  const independentSignals = _state?.signalCount ?? 0;
  const hardSkip = _state?.hardSkip ?? false;
  if (hardSkip) {
    return { fired: false, rule_id: "s-tier" };
  }

  const playoff = isPlayoffGame(groundTruth);
  const playoffGN = groundTruth?.series?.next_game_number ?? null;

  const failures = [];
  if (suppressors > 0) failures.push("active suppressor");
  if (independentSignals < 3) failures.push(`only ${independentSignals} independent signal${independentSignals === 1 ? "" : "s"}`);
  if (playoff && playoffGN != null && playoffGN < 3) failures.push("playoff Game <3");

  // Item 4: line must beat both season and L5 baselines.
  const { seasonAvg, l5Avg } = getBaselines({ groundTruth, statType });
  if (seasonAvg != null && line >= seasonAvg) failures.push(`line ${line} not below season ${seasonAvg.toFixed(2)}`);
  if (l5Avg != null && line >= l5Avg) failures.push(`line ${line} not below L5 ${l5Avg.toFixed(2)}`);

  if (failures.length > 0) {
    // Cap to A so the engine's tier resolver doesn't promote to S.
    return {
      fired: true,
      rule_id: "s-tier",
      tier_cap: "A",
      confidence_delta: 0,
      flag: null,
      justification_part: `S-tier gate not satisfied: ${failures.join("; ")}; capped at A.`,
    };
  }

  // All items pass — allow the tier resolver to consider S.
  return {
    fired: true,
    rule_id: "s-tier",
    tier_cap: null,
    confidence_delta: ctx.weights.signal_bonus,
    flag: null,
    justification_part: "S-tier gate satisfied — 3+ independent signals, no suppressors, line clears both baselines.",
    s_eligible: true,
  };
}
