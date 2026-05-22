// Pre-engine mechanical fast-path. On the experiment/no-llm-engine
// branch, the deterministic rule engine in api/lib/engine.js handles
// every framework rule. This module keeps `preFilterMechanical` as a
// short-circuit that catches the three arithmetic hard-gates (5a OVER
// buffer, 5i FT-floor, R9 assist win-prob) before engine setup —
// saves a few microseconds and emits a smaller verdict shape for
// genuinely impossible props.
//
// All helpers live in ./rules/_helpers.js and are shared with the
// engine's per-rule modules so the fast-path and the engine never
// disagree.

import {
  PROP_TO_FIELD,
  FT_FLOOR_PROPS,
  ASSIST_CONTAINING,
  computeOverBufferCheck,
  computeFtFloorCheck,
  computeAssistWinProbCheck,
} from "./rules/_helpers.js";

/**
 * Pre-engine mechanical filter. Returns a SKIP verdict object if the
 * framework would reject this task on arithmetic grounds, null
 * otherwise. Callers (analyze.js, analyze-all.js) skip the engine when
 * this returns non-null.
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
    justification: `Pre-filter mechanical SKIP: ${reasons}.`,
    flags,
    overridden: true,
    override_reasons: overrides.map((o) => o.reason),
    pre_filtered: true,
    rules_fired: overrides.map((o) => `pre-filter:${o.reason}`),
  };
}

function collectMechanicalFailures({ groundTruth, statType, direction, line }) {
  const field = PROP_TO_FIELD[statType];
  if (!field) return [];

  const seasonAvg = groundTruth.season?.averages?.[field] ?? null;
  // v3.5 — weighted L5 governs when present; raw l5 is the fallback.
  const l5WeightedAvg = groundTruth.l5?.weighted?.averages?.[field] ?? null;
  const l5RawAvg = groundTruth.l5?.averages?.[field] ?? null;
  const l5Avg = l5WeightedAvg ?? l5RawAvg;
  const hasBaseline = seasonAvg != null || l5Avg != null;

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
