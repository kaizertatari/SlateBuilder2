// Deterministic post-LLM checker. Re-derives a small set of mechanical
// framework rules from groundTruth and downgrades the verdict to SKIP when
// the LLM clearly violated one. The goal is parity: /api/analyze and
// /api/analyze-all should never disagree on a check that's a pure
// arithmetic comparison against the same shared ground truth.
//
// Intentionally conservative — only overrides verdicts the framework
// defines as hard, mechanical disqualifiers:
//   • OVER 1.5pt buffer (framework: "OVER BUFFER RULES" + Rule 5a road)
//   • Rule 5i FT-Floor Insurance Guard (UNDER on Points/PRA)
//
// Does NOT adjudicate suppressor stacking, mechanism naming, S-tier gate
// promotion, or any qualitative call — those stay with the LLM. The
// verifier never promotes a verdict; it only downgrades to SKIP.

import { PROP_TO_FIELD } from "./prop-types.js";

// Props that include points — road deduction (Rule 5a) and the FT-shooter
// extra buffer apply to these.
const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
// Framework limits Rule 5i to Points/PRA UNDER.
const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);

/**
 * @param {Object} params
 * @param {Object} params.groundTruth  shared ground truth for this player
 * @param {string} params.statType     canonical stat (e.g., "Points", "PRA")
 * @param {string} params.direction    "OVER" | "UNDER"
 * @param {number} params.line         line value
 * @param {Object} params.llmResult    parsed LLM verdict (verdict/tier/confidence/justification/flags/data_used)
 * @returns {Object} the (possibly overridden) result plus `overridden: bool` and `override_reasons?: string[]`
 */
export function verifyVerdict({ groundTruth, statType, direction, line, llmResult }) {
  // SKIPs from the LLM stand — the verifier only tightens, never loosens.
  if (llmResult.verdict === "SKIP" || llmResult.tier === "SKIP") {
    return { ...llmResult, overridden: false };
  }

  const field = PROP_TO_FIELD[statType];
  if (!field) return { ...llmResult, overridden: false };

  const seasonAvg = groundTruth.season?.averages?.[field] ?? null;
  const l5Avg = groundTruth.l5?.averages?.[field] ?? null;
  // No baselines means upstream should have SKIPped on missing data; if
  // it didn't, the verifier has nothing mechanical to assert.
  if (seasonAvg == null && l5Avg == null) return { ...llmResult, overridden: false };

  const overrides = [];

  if (direction === "OVER" && llmResult.verdict === "OVER") {
    const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg });
    if (buf && !buf.passes) {
      overrides.push({
        reason: "over_buffer_failed",
        detail: `governing=${buf.governing} (baseline ${buf.baseline.toFixed(2)}, adjusted ${buf.adjusted.toFixed(2)}); required line ≤ ${buf.required.toFixed(2)}, got ${line}`,
      });
    }
  }

  if (direction === "UNDER" && llmResult.verdict === "UNDER" && FT_FLOOR_PROPS.has(statType)) {
    const ft = computeFtFloorCheck({ groundTruth, line });
    if (ft && ft.invalid) {
      overrides.push({
        reason: "rule_5i_ft_floor_violation",
        detail: `fta=${ft.fta}, ft_pct=${ft.ftPct}, ft_floor_pts=${ft.ftFloorPts.toFixed(2)}, total_floor=${ft.totalFloor.toFixed(2)} ≥ line=${line}`,
      });
    }
  }

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

// --- helpers ---------------------------------------------------------------

function computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg }) {
  // Governing baseline per framework: "When L5 and season avg conflict by
  // 3+ pts, L5 governs". We extend "3+ pts" to "3+ units of the prop's
  // natural scale" so the rule covers PRA, Rebounds, etc., not just PPG.
  let baseline;
  let governing;
  if (seasonAvg != null && l5Avg != null) {
    governing = Math.abs(seasonAvg - l5Avg) >= 3 ? "L5" : "season";
    baseline = governing === "L5" ? l5Avg : seasonAvg;
  } else {
    governing = seasonAvg != null ? "season" : "L5";
    baseline = seasonAvg ?? l5Avg;
  }

  // Rule 5a road deduction: -1.5 to scoring baselines on road games.
  // Applies to props containing points (Points/PR/PA/PRA). Rebounds,
  // Assists, RA, 3PM, FGA are unaffected.
  const roadDed = (groundTruth.home_away === "away" && POINTS_CONTAINING.has(statType)) ? 1.5 : 0;
  const adjusted = baseline - roadDed;

  // "Poor FT shooters (<70%): extra 2pt buffer" — applies to points-
  // containing props where FT volume drives the points floor.
  const ftPct = groundTruth.season?.averages?.ft_pct ?? null;
  const poorFt = (ftPct != null && ftPct < 0.70 && POINTS_CONTAINING.has(statType));
  const buffer = 1.5 + (poorFt ? 2 : 0);
  const required = adjusted - buffer;

  return {
    governing,
    baseline,
    adjusted,
    required,
    passes: line <= required,
  };
}

function computeFtFloorCheck({ groundTruth, line }) {
  const fta = groundTruth.season?.averages?.fta ?? null;
  const ftPct = groundTruth.season?.averages?.ft_pct ?? null;
  if (fta == null || ftPct == null) return null;
  // Framework gate: only fires for season.averages.fta >= 5.
  if (fta < 5) return null;
  const ftFloorPts = fta * ftPct;
  const totalFloor = ftFloorPts + 8; // 8 = worst-case FG floor vs elite D
  return {
    fta,
    ftPct,
    ftFloorPts,
    totalFloor,
    invalid: totalFloor >= line,
  };
}
