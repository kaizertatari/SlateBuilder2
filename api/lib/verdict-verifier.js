// Deterministic framework checker (v3.5). Re-derives a small set of
// mechanical rules from groundTruth and either:
//   • PRE-LLM: short-circuits to SKIP without calling the LLM (saves
//     ~7K tokens / call when the rule is going to fail anyway).
//   • POST-LLM: downgrades an LLM verdict to SKIP when it violated the
//     same rule. Catches qualitative-mode drift.
//
// Both modes share the same internal check functions, so pre and post
// can never disagree.
//
// Intentionally conservative — only handles rules the framework defines
// as hard, mechanical disqualifiers:
//   • OVER buffer (Rule 5a baseline + variance-adjusted + outlier-window
//     widening + FT-shooter extra)
//   • Rule 5i FT-Floor Insurance Guard (UNDER on Points/PRA, with the
//     Mechanism 1 minutes-restriction override)
//   • Rule R9 assist win-prob gate
//
// Does NOT adjudicate suppressor stacking, mechanism naming (beyond
// Mechanism 1 for 5i), S-tier gate promotion, or any qualitative call —
// those stay with the LLM.

import { PROP_TO_FIELD } from "./prop-types.js";
import { FRAMEWORK_SCALING, ftFloorBaseline } from "./framework.js";

// Pulls the per-league scaled constants the verifier shares with the
// framework prompt. Defaults to NBA so any pre-league callsite still works.
function scaleFor(groundTruth) {
  const league = String(groundTruth?.league ?? "NBA").toUpperCase();
  return FRAMEWORK_SCALING[league] ?? FRAMEWORK_SCALING.NBA;
}

// Props that include points — road deduction (Rule 5a) and the FT-shooter
// extra buffer apply to these.
const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
// Framework limits Rule 5i to Points/PRA UNDER.
const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);
// Rule R9 (assist win-prob gate) applies to props with an assists
// component. Both directions are gated.
const ASSIST_CONTAINING = new Set(["Assists", "PA", "RA", "PRA"]);
// Win-prob bands, regular season vs playoff (R9).
const ASSIST_WP_BAND_REG = { lo: 0.40, hi: 0.75 };
const ASSIST_WP_BAND_PLAYOFF = { lo: 0.35, hi: 0.80 };

/**
 * Pre-LLM mechanical filter. Returns a SKIP verdict object if the
 * framework would reject this task on arithmetic grounds, null otherwise.
 */
export function preFilterMechanical({ groundTruth, statType, direction, line }) {
  const overrides = collectMechanicalFailures({ groundTruth, statType, direction, line });
  if (overrides.length === 0) return null;

  const flags = overrides.map((o) => `⚠️ pre-filter SKIP: ${o.reason} (${o.detail})`);
  const reasons = overrides.map((o) => o.reason).join(", ");
  return {
    verdict: "SKIP",
    tier: "SKIP",
    confidence: 0,
    justification: `Pre-filter mechanical SKIP (no LLM call): ${reasons}.`,
    flags,
    data_used: null,
    overridden: true,
    override_reasons: overrides.map((o) => o.reason),
    pre_filtered: true,
  };
}

/**
 * Post-LLM verifier. Takes the LLM's verdict and downgrades to SKIP if
 * a mechanical check it skipped is violated. Pass-through on LLM SKIPs.
 */
export function verifyVerdict({ groundTruth, statType, direction, line, llmResult }) {
  if (llmResult.verdict === "SKIP" || llmResult.tier === "SKIP") {
    return { ...llmResult, overridden: false };
  }

  const effective = llmResult.verdict === "OVER" ? "OVER"
                  : llmResult.verdict === "UNDER" ? "UNDER"
                  : direction;
  const overrides = collectMechanicalFailures({
    groundTruth,
    statType,
    direction: effective,
    line,
  });
  if (overrides.length === 0) return { ...llmResult, overridden: false };

  const overrideFlags = overrides.map((o) => `⚠️ verifier override: ${o.reason} (${o.detail})`);
  const origJust = typeof llmResult.justification === "string" ? llmResult.justification : "";
  const overrideJust = `Verifier override: LLM returned ${llmResult.verdict}/${llmResult.tier} but mechanical framework check failed (${overrides.map((o) => o.reason).join(", ")}). Original: ${origJust}`;

  return {
    verdict: "SKIP",
    tier: "SKIP",
    confidence: 0,
    justification: overrideJust.slice(0, 800),
    flags: [...(Array.isArray(llmResult.flags) ? llmResult.flags : []), ...overrideFlags],
    data_used: llmResult.data_used ?? null,
    overridden: true,
    override_reasons: overrides.map((o) => o.reason),
  };
}

// --- shared core ----------------------------------------------------------

function collectMechanicalFailures({ groundTruth, statType, direction, line }) {
  const field = PROP_TO_FIELD[statType];
  if (!field) return [];

  const seasonAvg = groundTruth.season?.averages?.[field] ?? null;
  // v3.5 — weighted L5 governs when present; raw l5 is the fallback. Game-
  // level reads still pull raw values from l5.games[] elsewhere.
  const l5WeightedAvg = groundTruth.l5?.weighted?.averages?.[field] ?? null;
  const l5RawAvg = groundTruth.l5?.averages?.[field] ?? null;
  const l5Avg = l5WeightedAvg ?? l5RawAvg;
  const hasBaseline = seasonAvg != null || l5Avg != null;

  // No baseline = no math is defensible. Without season or L5 averages the
  // OVER buffer and FT-floor checks can't run, which would let the LLM's
  // hallucinated numbers slip through verification. Hard-SKIP here so both
  // the pre-filter and the post-LLM verifier paths short-circuit before any
  // qualitative call is trusted.
  if (!hasBaseline) {
    return [{
      reason: "missing_baseline",
      detail: `no season.averages.${field} and no l5.averages.${field}`,
    }];
  }

  const out = [];

  if (direction === "OVER") {
    const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed: l5WeightedAvg != null });
    if (buf && !buf.passes) {
      out.push({
        reason: "over_buffer_failed",
        detail: `governing=${buf.governing} (baseline ${buf.baseline.toFixed(2)}, adjusted ${buf.adjusted.toFixed(2)}); required line ≤ ${buf.required.toFixed(2)}, got ${line}, buffer ${buf.buffer.toFixed(2)}`,
      });
    }
  }

  if (direction === "UNDER" && FT_FLOOR_PROPS.has(statType)) {
    const ft = computeFtFloorCheck({ groundTruth, line });
    if (ft && ft.invalid) {
      out.push({
        reason: "rule_5i_ft_floor_violation",
        detail: `source=${ft.source} fta=${ft.fta}, ft_pct=${ft.ftPct}, ft_floor_pts=${ft.ftFloorPts.toFixed(2)}, total_floor=${ft.totalFloor.toFixed(2)} ≥ line=${line} (fg_floor=${ft.fgFloor})`,
      });
    }
  }

  if (ASSIST_CONTAINING.has(statType)) {
    const wp = computeAssistWinProbCheck({ groundTruth });
    if (wp && wp.outside) {
      out.push({
        reason: "rule_r9_assist_winprob_outside_band",
        detail: `context=${wp.context} band=[${wp.lo.toFixed(2)}, ${wp.hi.toFixed(2)}], got win_prob=${wp.value.toFixed(3)}`,
      });
    }
  }

  return out;
}

function computeAssistWinProbCheck({ groundTruth }) {
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

// l5.type === "Playoffs" + n≥3 = playoff sample size large enough to govern.
function isPlayoffL5(groundTruth) {
  return groundTruth?.l5?.type === "Playoffs" && (groundTruth?.l5?.n ?? 0) >= 3;
}
function isPlayoffGame(groundTruth) {
  return !!groundTruth?.series;
}

function computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed }) {
  // Baseline governance. Playoff L5 override unchanged from v3.4; default
  // rule is "L5 governs when conflict ≥ 3 pts." l5Avg here is already the
  // weighted value when present (per collectMechanicalFailures).
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

  // Rule 5a road deduction. v3.5 collapses regular/playoff to a single
  // per-league value (NBA=1.5, WNBA=1.2 per spec §13). Variance and
  // outlier-window widening on the buffer carry the playoff-specific
  // tightening responsibility instead.
  const scale = scaleFor(groundTruth);
  let roadDed = 0;
  if (groundTruth.home_away === "away" && POINTS_CONTAINING.has(statType)) {
    roadDed = scale.road_deduction_pts;
  }
  const adjusted = baseline - roadDed;

  // v3.5 OVER buffer:
  //   base = 2.5 when l5.weighted.outlier_present  else 1.5
  //   variance widens: when σ > league threshold and prop is points-family,
  //                    buffer becomes 1.5 + 0.25 × (σ − threshold). When
  //                    the outlier base (2.5) is larger, the larger of the
  //                    two governs (spec §5a: "variance addendum applies
  //                    to whichever base is larger").
  //   poor FT shooter (<70%): +2 on points-containing props.
  const outlierActive = !!groundTruth?.l5?.weighted?.outlier_present;
  const outlierBase = outlierActive ? 2.5 : scale.over_buffer_base;
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
  };
}

function computeFtFloorCheck({ groundTruth, line }) {
  // v3.4 playoff FT-floor override carries forward to v3.5: use l5 FTA/FT%
  // when in playoff L5 with sufficient sample; otherwise season averages.
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

  // v3.5 per-position FG floor. composeGroundTruth fills derived.ft_floor_baseline
  // from player position (falls back to F when unknown). Honor whatever the
  // composer produced; if absent, recompute the same default (F).
  const fgFloor = groundTruth?.derived?.ft_floor_baseline
    ?? ftFloorBaseline(groundTruth?.league, null);

  let ftFloorPts = fta * ftPct;

  // Mechanism 1 override: confirmed minutes restriction R below the league
  // threshold scales FT volume proportionally. Use a structured field on
  // groundTruth (set by analyze.js based on injury/rest reports). When not
  // set the override is a no-op.
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
