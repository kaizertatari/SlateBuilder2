// Rule: Rest / schedule density — Stage 4 fatigue signal.
//
// Schedule density compresses production: a back-to-back, and especially a
// 3-in-4, tends to shave minutes and efficiency off counting-stat OVERs
// (and conversely makes UNDERs a touch safer). composeGroundTruth derives the
// `rest` block from the gamelog dates vs the upcoming game; this rule turns it
// into a small, direction-aware signal — secondary to the market, like
// game-script. No-ops without rest data.
//
// 3-in-4 is weighted heavier than a lone back-to-back (cumulative fatigue).
// Forward-gated: magnitudes are modest and meant to be tuned by calibration.

const COUNTING_STATS = new Set([
  "Points", "Rebounds", "Assists", "3-Pointers Made", "PRA", "PR", "PA", "RA",
]);

export function apply(ctx) {
  const { groundTruth, statType, direction } = ctx;
  if (!COUNTING_STATS.has(statType)) return { fired: false, rule_id: "rest" };

  const rest = groundTruth?.rest;
  if (!rest || rest.rest_days == null) return { fired: false, rule_id: "rest" };

  const threeInFour = !!rest.three_in_four;
  const b2b = !!rest.back_to_back;
  const _rest = { rest_days: rest.rest_days, back_to_back: b2b, three_in_four: threeInFour };
  if (!threeInFour && !b2b) return { fired: false, rule_id: "rest", _rest };

  const isOver = direction === "OVER";
  const note = threeInFour ? "3-in-4 schedule density" : "back-to-back";
  const magnitude = threeInFour ? 4 : 3;

  let suppressor = false;
  let signals_added = 0;
  let confidence_delta;
  if (isOver) {
    suppressor = true;
    confidence_delta = -magnitude;
  } else {
    signals_added = 1;
    confidence_delta = magnitude - 1; // UNDER tailwind, slightly softer
  }

  return {
    fired: true,
    rule_id: "rest",
    confidence_delta,
    suppressor,
    signals_added,
    flag: isOver
      ? `⚠️ Rest — ${note} (${rest.rest_days}d rest) works against OVER`
      : `✅ Rest — ${note} (${rest.rest_days}d rest) favors UNDER`,
    justification_part: `Rest/schedule — ${note}, ${rest.rest_days}d since last game.`,
    _rest,
  };
}
