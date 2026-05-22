// PrizePicks Model v3.5 framework — scaling constants shared by the
// deterministic rule engine (api/lib/engine.js + api/lib/rules/*) and
// the legacy fast-path preFilterMechanical in verdict-verifier.js.
//
// Two league variants share the same rule structure. The WNBA variant
// scales numeric thresholds for 40-minute games and ~13-team league
// size; recency-based gates (post-injury 5-game window, game-number
// modifier, assist win-prob bands) are unchanged.
//
// v3.5 deltas vs v3.4:
//   • Variance-adjusted OVER buffer (Rule 5a addendum)
//   • Per-position FT floor (Rule 5i): G/F/C lookup, fallback to F
//   • Weighted L5 baseline (recency × opponent/series × outlier)
//   • Pre-tip blowout-projection override on series-tied playoff games
//   • UNDER via Mechanism 1 carved out of the Game-1 B-tier cap
//
// LLM prompt builders (frameworkBody, getFramework, MODEL_FRAMEWORK)
// were removed on the experiment/no-llm-engine branch — the engine
// applies these rules directly in JavaScript instead of via prompt
// text.
export const FRAMEWORK_SCALING = {
  NBA: {
    league_label: "NBA",
    game_minutes: 48,
    teams: 30,
    road_deduction_pts: 1.5,
    over_buffer_base: 1.5,
    // Per-stat OVER buffer overrides. Stats not listed fall back to
    // over_buffer_base. Mild scaling — low-volume props (3PM, BLK, STL) get
    // a smaller absolute buffer so the rule doesn't kill props where a 1.5
    // buffer is disproportionate to the natural increment. Points-family
    // stays at the 1.5 baseline so variance/outlier addenda land where the
    // framework expects.
    over_buffer_by_stat: {
      "Points": 1.5,
      "PR": 1.5,
      "PA": 1.5,
      "PRA": 1.5,
      "Rebounds": 1.0,
      "Assists": 1.0,
      "RA": 1.0,
      "3-Pointers Made": 0.75,
      "FG Attempted": 1.5,
      "Blocks": 0.5,
      "Steals": 0.5,
    },
    variance_threshold_ppg: 6,
    // Per-position worst-case FG floor vs elite D for Rule 5i. The verifier
    // selects via groundTruth.derived.ft_floor_baseline (which the data
    // composer fills from player position; falls back to F when unknown).
    ft_floor_by_position: { G: 6, F: 8, C: 10 },
    ft_floor_default_position: "F",
    ft_floor_gate_fta: 5,
    multi_star_ppg_threshold: 15,
    def_rank_top_tier: 5,
    def_rank_tier2: 3,
    series_round_summary: "best-of-7 (rounds 1-4)",
  },
  WNBA: {
    league_label: "WNBA",
    game_minutes: 40,
    teams: 13,
    // Per v3.5 spec §13. ~83% scaling vs NBA, rounded to the published value.
    road_deduction_pts: 1.2,
    over_buffer_base: 1.5,
    // Same per-stat overrides as NBA — the natural increments of these
    // stats don't change between leagues. See NBA.over_buffer_by_stat for
    // rationale.
    over_buffer_by_stat: {
      "Points": 1.5,
      "PR": 1.5,
      "PA": 1.5,
      "PRA": 1.5,
      "Rebounds": 1.0,
      "Assists": 1.0,
      "RA": 1.0,
      "3-Pointers Made": 0.75,
      "FG Attempted": 1.5,
      "Blocks": 0.5,
      "Steals": 0.5,
    },
    variance_threshold_ppg: 5,
    ft_floor_by_position: { G: 4, F: 6, C: 8 },
    ft_floor_default_position: "F",
    ft_floor_gate_fta: 4,
    multi_star_ppg_threshold: 12,
    // 12 teams: def_rank ≤ 2 is roughly the same proportion as NBA top-5,
    // and def_rank ≤ 1 mirrors NBA top-3 for the Tier-2 5h proxy.
    def_rank_top_tier: 2,
    def_rank_tier2: 1,
    series_round_summary: "best-of-3 (R1), best-of-5 (semis/conf-finals), best-of-7 (finals)",
  },
};

// Convenience for callers that only need the FT-floor value once they
// know the player position (and league). Falls back cleanly to F when
// position is unknown — per v3.5 spec §6 Rule 5i.
export function ftFloorBaseline(league, position) {
  const c = FRAMEWORK_SCALING[String(league).toUpperCase()] ?? FRAMEWORK_SCALING.NBA;
  const table = c.ft_floor_by_position;
  const pos = position && table[position] != null ? position : c.ft_floor_default_position;
  return table[pos];
}
