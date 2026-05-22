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

export { PROP_TO_FIELD, FRAMEWORK_SCALING, ftFloorBaseline };

// Props that include points — road deduction (Rule 5a) and the FT-shooter
// extra buffer apply to these.
export const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
// Framework limits Rule 5i to Points/PRA UNDER.
export const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);
// Rule R9 (assist win-prob gate) applies to props with an assists
// component. Both directions are gated.
export const ASSIST_CONTAINING = new Set(["Assists", "PA", "RA", "PRA"]);
// Win-prob bands, regular season vs playoff (R9).
export const ASSIST_WP_BAND_REG = { lo: 0.40, hi: 0.75 };
export const ASSIST_WP_BAND_PLAYOFF = { lo: 0.35, hi: 0.80 };

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

  // Rule 5a road deduction (per-league, points-family only).
  const scale = scaleFor(groundTruth);
  let roadDed = 0;
  if (groundTruth.home_away === "away" && POINTS_CONTAINING.has(statType)) {
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

  return {
    governing,
    baseline,
    adjusted,
    required,
    buffer,
    passes: line <= required,
    outlierActive,
    poorFt,
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
