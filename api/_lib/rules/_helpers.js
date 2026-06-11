// Shared rule helpers used by both the engine's per-rule modules and the
// fast-path preFilterMechanical in verdict-verifier.js. Lifted out of
// verdict-verifier.js so the engine doesn't depend on the verifier
// (verifier still re-exports preFilterMechanical for the existing call
// sites in analyze.js / analyze-all.js).
//
// These functions are pure: read from groundTruth + statType/direction/
// line/etc., return a structured result. No side effects.

import { PROP_TO_FIELD } from "../prop-types.js";
import { FRAMEWORK_SCALING, ftFloorBaseline } from "../framework.js";
import { BLEND_CURRENT_SERIES_RATIO, BLEND_H2H_RATIO, H2H_MIN_GAMES } from "../weighted-l5.js";

export { PROP_TO_FIELD, FRAMEWORK_SCALING, ftFloorBaseline };

// Props that include points — used both for road deduction (Rule 5a)
// and for the variance addendum (which uses ppg_stddev as a proxy).
export const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
// Props that get the road-deduction adjustment. Fantasy Score is included
// because Points dominates the FanDuel-weighted composite — a 1.5-pt
// road dip translates ~1:1 to Fantasy Score (Points weight = 1.0). The
// variance addendum stays POINTS_CONTAINING-only because we don't have a
// stddev for Fantasy Score (would mix units).
export const ROAD_DEDUCTION_PROPS = new Set([
  "Points", "PR", "PA", "PRA", "Fantasy Score",
]);
// Framework limits Rule 5i to Points/PRA UNDER. Fantasy Score is
// intentionally NOT included — too many non-points components for the
// FT-floor math to remain clean.
export const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);
// Rule R9 (assist win-prob gate) applies to props with an assists
// component. Both directions are gated. Fantasy Score is included
// because the FanDuel weight on assists is 1.5x — outside the band, FS
// becomes unreliable for the same reason raw Assists does.
export const ASSIST_CONTAINING = new Set([
  "Assists", "PA", "RA", "PRA", "Fantasy Score",
]);
// Win-prob bands, regular season vs playoff (R9).
export const ASSIST_WP_BAND_REG = { lo: 0.40, hi: 0.75 };
export const ASSIST_WP_BAND_PLAYOFF = { lo: 0.35, hi: 0.80 };
// Volume/counting props the Stage 2–4 signal rules (game-script, rest,
// usage-shift) apply to — production scales with possessions/usage.
// Defensive stats (Blocks, Steals) and Fantasy Score are excluded: their
// relationship to pace/usage is weaker or mixed-sign.
export const COUNTING_STATS = new Set([
  "Points", "Rebounds", "Assists", "3-Pointers Made", "PRA", "PR", "PA", "RA",
]);

export function scaleFor(groundTruth) {
  const league = String(groundTruth?.league ?? "NBA").toUpperCase();
  return FRAMEWORK_SCALING[league] ?? FRAMEWORK_SCALING.NBA;
}

// l5.type === "Playoffs" + n≥3 = playoff sample size large enough to govern.
export function isPlayoffL5(groundTruth) {
  return groundTruth?.l5?.type === "Playoffs" && (groundTruth?.l5?.n ?? 0) >= 3;
}

export function isPlayoffGame(groundTruth) {
  return !!groundTruth?.series;
}

export function computeAssistWinProbCheck({ groundTruth }) {
  const wp = groundTruth?.win_prob?.player_team_pct;
  if (wp == null || typeof wp !== "number") return null;
  const playoff = isPlayoffGame(groundTruth);
  const band = playoff ? ASSIST_WP_BAND_PLAYOFF : ASSIST_WP_BAND_REG;
  return {
    context: playoff ? "playoff" : "regular_season",
    value: wp,
    lo: band.lo,
    hi: band.hi,
    outside: wp < band.lo || wp > band.hi,
  };
}

export function computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed }) {
  // Baseline governance. Playoff L5 override unchanged from v3.4; default
  // rule is "L5 governs when conflict ≥ 3 pts."
  let baseline;
  let governing;
  const playoffL5 = isPlayoffL5(groundTruth);
  if (seasonAvg != null && l5Avg != null) {
    if (playoffL5) {
      governing = l5WeightedUsed ? "L5_weighted_playoff_override" : "L5_playoff_override";
      baseline = l5Avg;
    } else if (Math.abs(seasonAvg - l5Avg) >= 3) {
      governing = l5WeightedUsed ? "L5_weighted" : "L5";
      baseline = l5Avg;
    } else {
      governing = "season";
      baseline = seasonAvg;
    }
  } else {
    governing = seasonAvg != null ? "season" : (l5WeightedUsed ? "L5_weighted" : "L5");
    baseline = seasonAvg ?? l5Avg;
  }

  // Move 2 — current-series mini-baseline blend. When weighted-L5 exposed
  // a current_series_averages bucket (vsCurrentOpp >= 3 in playoff_series
  // mode) AND we're already in a playoff-L5-governing path, blend it in
  // at the configured ratio. Tilts the baseline toward matchup-specific
  // signal without abandoning the wider playoff-sample stability anchor.
  //
  // We only blend when the path that was already chosen is playoff-L5
  // governing — outside the playoff context, current_series_averages is
  // null anyway, and we don't want to bias non-playoff baselines.
  const field = PROP_TO_FIELD[statType];
  const currentSeriesAvg = field
    ? (groundTruth?.l5?.weighted?.current_series_averages?.[field] ?? null)
    : null;
  if (playoffL5 && currentSeriesAvg != null && baseline === l5Avg) {
    const ratio = BLEND_CURRENT_SERIES_RATIO;
    baseline = ratio * currentSeriesAvg + (1 - ratio) * l5Avg;
    const n = groundTruth?.l5?.weighted?.current_series_n ?? 0;
    governing = `${governing}+current_series_blend(${Math.round(ratio * 100)}/${Math.round((1 - ratio) * 100)},n=${n})`;
  }

  // Move 3 — regular-season H2H blend. Mutually exclusive with the
  // playoff current-series blend: H2H fires only outside playoff_L5
  // context. Gates on H2H_MIN_GAMES so a single-game H2H sample doesn't
  // swing the baseline; 50/50 blend acknowledges that reg-season H2H is
  // a smaller, noisier sample than playoff series (2-4 games vs 4-7).
  const h2hAvg = field
    ? (groundTruth?.h2h?.averages?.[field] ?? null)
    : null;
  const h2hN = groundTruth?.h2h?.n ?? 0;
  if (!playoffL5 && h2hAvg != null && h2hN >= H2H_MIN_GAMES) {
    const ratio = BLEND_H2H_RATIO;
    baseline = ratio * h2hAvg + (1 - ratio) * baseline;
    governing = `${governing}+h2h_blend(${Math.round(ratio * 100)}/${Math.round((1 - ratio) * 100)},n=${h2hN})`;
  }

  // Rule 5a road deduction (per-league). Applies to Points-family +
  // Fantasy Score (FS is Points-dominant in the FanDuel formula).
  const scale = scaleFor(groundTruth);
  let roadDed = 0;
  if (groundTruth.home_away === "away" && ROAD_DEDUCTION_PROPS.has(statType)) {
    roadDed = scale.road_deduction_pts;
  }
  const adjusted = baseline - roadDed;

  // Per-stat buffer + outlier widening + variance addendum + poor-FT extra.
  const statBase = scale.over_buffer_by_stat?.[statType] ?? scale.over_buffer_base;
  const outlierActive = !!groundTruth?.l5?.weighted?.outlier_present;
  const outlierBase = outlierActive ? Math.max(2.5, statBase) : statBase;
  const sigma = groundTruth?.variance?.ppg_stddev ?? null;
  const isPointsFamily = POINTS_CONTAINING.has(statType);
  let varianceBuffer = null;
  if (sigma != null && isPointsFamily && sigma > scale.variance_threshold_ppg) {
    varianceBuffer = 1.5 + 0.25 * (sigma - scale.variance_threshold_ppg);
  }
  const baseBuffer = varianceBuffer != null ? Math.max(outlierBase, varianceBuffer) : outlierBase;
  const ftPct = groundTruth.season?.averages?.ft_pct ?? null;
  const poorFt = (ftPct != null && ftPct < 0.70 && isPointsFamily);
  const buffer = baseBuffer + (poorFt ? 2 : 0);
  const required = adjusted - buffer;

  // Trimmed-baseline sanity check. When weighted-L5 exposes a drop-max
  // trimmed mean for this field, surface the road-adjusted version so
  // Rule 5a can detect cases where one game is doing the heavy lifting
  // (full baseline clears the line, trimmed baseline doesn't).
  const trimmedAvg = field
    ? (groundTruth?.l5?.weighted?.trimmed_averages?.[field] ?? null)
    : null;
  const trimmedAdjusted = trimmedAvg != null ? trimmedAvg - roadDed : null;

  return {
    governing,
    baseline,
    adjusted,
    required,
    buffer,
    passes: line <= required,
    outlierActive,
    poorFt,
    trimmedBaseline: trimmedAvg,
    trimmedAdjusted,
  };
}

export function computeFtFloorCheck({ groundTruth, line }) {
  let fta;
  let ftPct;
  let source;
  if (isPlayoffL5(groundTruth) && groundTruth.l5?.averages?.fta != null
      && groundTruth.l5.averages.ft_pct != null) {
    fta = groundTruth.l5.averages.fta;
    ftPct = groundTruth.l5.averages.ft_pct;
    source = "l5_playoff";
  } else {
    fta = groundTruth.season?.averages?.fta ?? null;
    ftPct = groundTruth.season?.averages?.ft_pct ?? null;
    source = "season";
  }
  if (fta == null || ftPct == null) return null;
  const scale = scaleFor(groundTruth);
  if (fta < scale.ft_floor_gate_fta) return null;

  const fgFloor = groundTruth?.derived?.ft_floor_baseline
    ?? ftFloorBaseline(groundTruth?.league, null);

  let ftFloorPts = fta * ftPct;

  // Mechanism 1 override (confirmed minutes restriction).
  const restriction = groundTruth?.minutes_restriction ?? null;
  const mechanismThresh = Math.floor(scale.game_minutes * 30 / 48);
  const mechanismScaler = Math.floor(scale.game_minutes * 32 / 48);
  if (restriction != null && Number.isFinite(restriction) && restriction < mechanismThresh) {
    ftFloorPts = ftFloorPts * (restriction / mechanismScaler);
    source = `${source}+mech1(R=${restriction})`;
  }

  const totalFloor = ftFloorPts + fgFloor;
  return {
    fta,
    ftPct,
    ftFloorPts,
    totalFloor,
    fgFloor,
    source,
    invalid: totalFloor >= line,
  };
}

// Resolve season/l5/weighted L5 averages for a stat field. Returns the
// trio so rule modules can describe what governed and apply the right
// modifiers. The "governing" tier (weighted > raw L5 > season) is
// determined by computeOverBufferCheck for OVER, but UNDER paths and
// confidence scoring need access to all three.
export function getBaselines({ groundTruth, statType }) {
  const field = PROP_TO_FIELD[statType];
  if (!field) return { seasonAvg: null, l5RawAvg: null, l5WeightedAvg: null, l5Avg: null, l5WeightedUsed: false };
  const seasonAvg = groundTruth.season?.averages?.[field] ?? null;
  const l5RawAvg = groundTruth.l5?.averages?.[field] ?? null;
  const l5WeightedAvg = groundTruth.l5?.weighted?.averages?.[field] ?? null;
  const l5Avg = l5WeightedAvg ?? l5RawAvg;
  return {
    seasonAvg,
    l5RawAvg,
    l5WeightedAvg,
    l5Avg,
    l5WeightedUsed: l5WeightedAvg != null,
  };
}
