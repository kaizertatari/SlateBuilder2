// Tunable weights for the Bayesian-ish confidence scoring in the
// rule engine. Lives in its own module so weights can be calibrated
// against grade-outcomes historical data without touching engine
// logic. Defaults are reasonable starting points — expect to refine
// them after a few days of shadow-grading.

export const RULE_WEIGHTS = {
  // Starting confidence before any signals or suppressors apply.
  // 70 = mid-A band so a clean prop with no suppressors lands in A
  // by default.
  base: 70,

  // Per clean independent signal (baseline clears OVER buffer by
  // >3 pts, win_prob in healthy band, recent form trending up, etc).
  // Engine increments confidence by this amount per fired signal.
  signal_bonus: 5,

  // Per fired suppressor (5b foul-prone/slump, 5f blowout, 5h FT-leak,
  // 4c multi-star compression). Engine decrements by this amount.
  suppressor_penalty: 8,

  // Strong-suppressor (5b/5h) thin-edge SKIP multiplier. A suppressor-
  // flagged OVER must clear the line by ≥ this × its Rule 5a buffer to
  // still issue; thinner edges SKIP (these hit ~38-40% when issued —
  // calibration 2026-05). Starting value — tune via calibration-report.
  suppressor_thin_edge_mult: 1.5,

  // Per point of margin between the road-adjusted baseline and the
  // line, on the favorable side. Bigger edge → more confidence.
  // Multiplier is applied to abs(adjusted - line).
  edge_unit_bonus: 1.5,

  // Hard SKIP gates (5a buffer fail, 5i FT-floor violation, R9 outside
  // band, no UNDER mechanism) short-circuit to 0 confidence.
  hard_skip: 0,

  // Game 1 advisory drops confidence into the B band (the framework
  // requires B-tier max baseline + mandatory SKIP advisory flag).
  game1_penalty: 12,

  // Game 2 hard cap = A-tier max both directions. Used as an
  // upper bound after scoring.
  game2_cap: 75,

  // Tier-band floors (also referenced by the framework prompt today).
  // Engine snaps the final score to the tier band of the most-
  // restrictive cap.
  s_tier_floor_reg: 82,
  s_tier_floor_playoff: 85,
  a_tier_floor: 70,
  b_tier_floor: 62,
};

// Tier ordering (most restrictive first). Used by the engine when
// reconciling multiple tier caps emitted by different rules.
export const TIER_RANK = { SKIP: 0, B: 1, A: 2, S: 3 };

export function tierMin(a, b) {
  if (TIER_RANK[a] == null) return b;
  if (TIER_RANK[b] == null) return a;
  return TIER_RANK[a] < TIER_RANK[b] ? a : b;
}

// Tier band edges. Final confidence snaps into the chosen tier's
// inclusive band.
export const TIER_BAND = {
  S: { lo: 82, hi: 90 },
  A: { lo: 70, hi: 81 },
  B: { lo: 62, hi: 69 },
  SKIP: { lo: 0, hi: 0 },
};

export function snapToBand(score, tier) {
  const band = TIER_BAND[tier];
  if (!band) return Math.max(0, Math.min(100, Math.round(score)));
  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  return Math.max(band.lo, Math.min(band.hi, rounded));
}
