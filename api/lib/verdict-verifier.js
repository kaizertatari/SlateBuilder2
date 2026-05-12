// Deterministic framework checker. Re-derives a small set of mechanical
// rules from groundTruth and either:
//   • PRE-LLM: short-circuits to SKIP without calling the LLM (saves
//     ~6800 tokens / call when the rule is going to fail anyway).
//   • POST-LLM: downgrades an LLM verdict to SKIP when it violated the
//     same rule. Catches qualitative-mode drift.
//
// Both modes share the same internal check functions, so pre and post
// can never disagree.
//
// Intentionally conservative — only handles rules the framework defines
// as hard, mechanical disqualifiers:
//   • OVER 1.5pt buffer (framework: "OVER BUFFER RULES" + Rule 5a road)
//   • Rule 5i FT-Floor Insurance Guard (UNDER on Points/PRA)
//
// Does NOT adjudicate suppressor stacking, mechanism naming, S-tier gate
// promotion, or any qualitative call — those stay with the LLM.

import { PROP_TO_FIELD } from "./prop-types.js";

// Props that include points — road deduction (Rule 5a) and the FT-shooter
// extra buffer apply to these.
const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
// Framework limits Rule 5i to Points/PRA UNDER.
const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);

/**
 * Pre-LLM mechanical filter. Returns a SKIP verdict object if the
 * framework would reject this task on arithmetic grounds, null otherwise.
 *
 * Use this before calling the LLM to avoid spending tokens on tasks that
 * are already mechanically dead.
 *
 * @param {Object} params
 * @param {Object} params.groundTruth
 * @param {string} params.statType   canonical stat (e.g., "Points")
 * @param {string} params.direction  "OVER" | "UNDER"
 * @param {number} params.line
 * @returns {Object|null} SKIP verdict object or null
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
 *
 * @param {Object} params
 * @param {Object} params.groundTruth
 * @param {string} params.statType
 * @param {string} params.direction
 * @param {number} params.line
 * @param {Object} params.llmResult  parsed LLM verdict object
 * @returns {Object} (possibly overridden) result plus `overridden: bool`
 */
export function verifyVerdict({ groundTruth, statType, direction, line, llmResult }) {
  // SKIPs from the LLM stand — the verifier only tightens, never loosens.
  if (llmResult.verdict === "SKIP" || llmResult.tier === "SKIP") {
    return { ...llmResult, overridden: false };
  }

  // Only check OVER outputs against OVER buffer, UNDER outputs against 5i.
  // (collectMechanicalFailures keys off `direction`, so passing the LLM's
  // own verdict prevents false-overriding e.g. an LLM UNDER with the
  // OVER buffer rule.)
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

/**
 * Runs the mechanical checks and returns an array of failures.
 * Each failure has { reason, detail }. Empty array = checks passed.
 *
 * Shared by preFilterMechanical (no LLM result) and verifyVerdict
 * (with LLM result). Behavior is identical in both modes — there is one
 * source of truth for what "mechanical SKIP" means.
 */
function collectMechanicalFailures({ groundTruth, statType, direction, line }) {
  const field = PROP_TO_FIELD[statType];
  if (!field) return [];

  const seasonAvg = groundTruth.season?.averages?.[field] ?? null;
  const l5Avg = groundTruth.l5?.averages?.[field] ?? null;
  // Without a baseline, upstream should have SKIPped on missing data.
  if (seasonAvg == null && l5Avg == null) return [];

  const out = [];

  if (direction === "OVER") {
    const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg });
    if (buf && !buf.passes) {
      out.push({
        reason: "over_buffer_failed",
        detail: `governing=${buf.governing} (baseline ${buf.baseline.toFixed(2)}, adjusted ${buf.adjusted.toFixed(2)}); required line ≤ ${buf.required.toFixed(2)}, got ${line}`,
      });
    }
  }

  if (direction === "UNDER" && FT_FLOOR_PROPS.has(statType)) {
    const ft = computeFtFloorCheck({ groundTruth, line });
    if (ft && ft.invalid) {
      out.push({
        reason: "rule_5i_ft_floor_violation",
        detail: `source=${ft.source} fta=${ft.fta}, ft_pct=${ft.ftPct}, ft_floor_pts=${ft.ftFloorPts.toFixed(2)}, total_floor=${ft.totalFloor.toFixed(2)} ≥ line=${line}`,
      });
    }
  }

  return out;
}

// Playoff context = "today's game is a playoff game". Set by the data
// layer: ESPN tags the scoreboard event with series state, which composes
// into groundTruth.series. l5.type === "Playoffs" means the L5 sample
// itself is playoff games (the player has accumulated 1+ playoff games
// this postseason); l5.n is the sample size.
function isPlayoffL5(groundTruth) {
  return groundTruth?.l5?.type === "Playoffs" && (groundTruth?.l5?.n ?? 0) >= 3;
}
function isPlayoffGame(groundTruth) {
  return !!groundTruth?.series;
}

function computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg }) {
  // R1 — playoff L5 governance override:
  // When today's L5 sample is 3+ playoff games, L5 governs regardless of
  // conflict size. season.averages is regular-season data in playoff games
  // (a different population), so the 3-pt drift threshold doesn't apply.
  // Falls back to the default rule (conflict ≥ 3 → L5) otherwise.
  let baseline;
  let governing;
  const playoffL5 = isPlayoffL5(groundTruth);
  if (seasonAvg != null && l5Avg != null) {
    if (playoffL5) {
      governing = "L5_playoff_override";
      baseline = l5Avg;
    } else {
      governing = Math.abs(seasonAvg - l5Avg) >= 3 ? "L5" : "season";
      baseline = governing === "L5" ? l5Avg : seasonAvg;
    }
  } else {
    governing = seasonAvg != null ? "season" : "L5";
    baseline = seasonAvg ?? l5Avg;
  }

  // Rule 5a road deduction: -1.5 to scoring baselines on road games.
  // Applies to props containing points. Rebounds/Assists/RA/3PM/FGA unaffected.
  const roadDed = (groundTruth.home_away === "away" && POINTS_CONTAINING.has(statType)) ? 1.5 : 0;
  const adjusted = baseline - roadDed;

  // R6 — playoff variance buffer:
  // Regular season: 1.5pt OVER buffer.
  // Playoff games (groundTruth.series non-null): 2.0pt buffer — reflects
  // higher playoff game-to-game variance.
  // Poor FT shooters (<70%) stack an extra 2pt on top, regardless of season.
  const baseBuffer = isPlayoffGame(groundTruth) ? 2.0 : 1.5;
  const ftPct = groundTruth.season?.averages?.ft_pct ?? null;
  const poorFt = (ftPct != null && ftPct < 0.70 && POINTS_CONTAINING.has(statType));
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
  // R2 — playoff FT-floor override:
  // Use l5 FTA/FT% when in playoff context with sufficient sample; otherwise
  // fall back to season averages. l5 fields may be absent on older data —
  // if missing, drop back to season cleanly rather than skipping the check.
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
  if (fta < 5) return null;
  const ftFloorPts = fta * ftPct;
  const totalFloor = ftFloorPts + 8;
  return {
    fta,
    ftPct,
    ftFloorPts,
    totalFloor,
    source,
    invalid: totalFloor >= line,
  };
}
