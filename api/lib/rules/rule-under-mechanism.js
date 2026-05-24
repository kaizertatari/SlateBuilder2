// UNDER mechanism gate.
//
// Mechanisms (Mech 1 / 2 / 3) are additive evidence for UNDER. They are
// REQUIRED only when the baseline does NOT corroborate UNDER. Rule 5j
// (UNDER baseline gate) hard-SKIPs when baseline > line + buffer and
// issues UNDER when baseline < line - buffer. This gate covers the
// remaining marginal band (within ±buffer of line) plus contributes
// signal/confidence when the baseline already issues.
//
// Tier caps by mechanism count + baseline corroboration:
//
//                            baseline supports    baseline neutral
//   3 mechanisms             no cap, +3 sig       no cap, +3 sig
//   2 mechanisms             no cap, +2 sig       A max, +2 sig
//   Mech 1 alone             no cap, +1 sig       A max, +1 sig
//   Mech 2 or 3 alone        A max,  +1 sig       B max, +1 sig (SKIP advisory)
//   zero mechanisms          fire:false (5j fires)  hard-SKIP
//
// Outlier demote (L5 weighted.outlier_present) still applies on top.
// The framework spec's "Mech 2/3 alone → SKIP advisory" stays only on
// the baseline-neutral path; with baseline corroboration the advisory
// is relaxed because the numeric foundation removes the single-signal
// risk that motivated the advisory.

import { computeOverBufferCheck, getBaselines, scaleFor } from "./_helpers.js";

// Symmetric one-tier demote when the L5 sample has an outlier vs the
// player's relevant points reference. Preserved from the prior rule —
// outlier signals usage/role volatility and is direction-agnostic.
function demoteForOutlier(result) {
  if (!result.fired) return result;
  const append = " Outlier present in L5 → demoted one tier.";
  if (result.tier_cap == null) {
    return {
      ...result,
      tier_cap: "A",
      flag: (result.flag ? result.flag + " " : "") + "⚠️ L5 outlier — S→A",
      justification_part: (result.justification_part ?? "") + append,
    };
  }
  if (result.tier_cap === "A") {
    return {
      ...result,
      tier_cap: "B",
      flag: (result.flag ? result.flag + " " : "") + "⚠️ L5 outlier — A→B",
      justification_part: (result.justification_part ?? "") + append,
    };
  }
  if (result.tier_cap === "B") {
    return {
      ...result,
      tier_cap: "SKIP",
      hard_skip: true,
      flag: (result.flag ? result.flag + " " : "") + "⚠️ L5 outlier + low-tier mechanism — SKIP",
      justification_part: (result.justification_part ?? "") + " Outlier present + single low-tier mechanism → SKIP.",
    };
  }
  return result;
}

function baselineSupports(ctx) {
  const { groundTruth, statType, line } = ctx;
  const { seasonAvg, l5Avg, l5WeightedUsed } = getBaselines({ groundTruth, statType });
  if (seasonAvg == null && l5Avg == null) return false;
  const buf = computeOverBufferCheck({ groundTruth, statType, line, seasonAvg, l5Avg, l5WeightedUsed });
  if (!buf) return false;
  const scale = scaleFor(groundTruth);
  const underBuffer = scale.over_buffer_by_stat?.[statType] ?? scale.over_buffer_base;
  return (line - buf.adjusted) >= underBuffer;
}

export function apply(ctx) {
  const { groundTruth, direction, weights } = ctx;
  if (direction !== "UNDER") return { fired: false, rule_id: "under-mechanism" };

  const mechs = groundTruth?.mechanisms ?? {};
  const m1 = !!mechs.mech1?.confirmed;
  const m2 = !!mechs.mech2?.confirmed;
  const m3 = !!mechs.mech3?.confirmed;
  const count = (m1 ? 1 : 0) + (m2 ? 1 : 0) + (m3 ? 1 : 0);
  const outlierPresent = !!groundTruth?.l5?.weighted?.outlier_present;
  const baselineOk = baselineSupports(ctx);

  // Zero mechanisms: defer to 5j entirely. If baseline supports, 5j
  // already fired with its own justification; if baseline is neutral,
  // hard-SKIP (no evidence for UNDER from either source).
  if (count === 0) {
    if (baselineOk) {
      // 5j carries the verdict — emit no flag, no cap, no signal.
      return { fired: false, rule_id: "under-mechanism" };
    }
    return {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: "⚠️ no named UNDER mechanism (Mech 1/2/3 all unconfirmed) and baseline doesn't support UNDER",
      justification_part: "UNDER mechanism gate — no Mechanism 1, 2, or 3 confirmed and baseline doesn't carry UNDER; SKIP.",
      hard_skip: true,
    };
  }

  const fragments = [];
  if (m1) fragments.push("Mech 1 (minutes)");
  if (m2) fragments.push("Mech 2 (role)");
  if (m3) fragments.push("Mech 3 (matchup)");

  const baselineNote = baselineOk ? " (baseline-corroborated)" : "";
  let result;
  if (count >= 3) {
    result = {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: null,
      confidence_delta: weights.signal_bonus * 3,
      signals_added: 3,
      flag: null,
      justification_part: `UNDER mechanism gate — 3 mechanisms confirmed (${fragments.join(", ")})${baselineNote}; S possible.`,
    };
  } else if (count === 2) {
    result = {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: baselineOk ? null : "A",
      confidence_delta: weights.signal_bonus * 2,
      signals_added: 2,
      flag: null,
      justification_part: `UNDER mechanism gate — 2 mechanisms confirmed (${fragments.join(", ")})${baselineNote}; ${baselineOk ? "S possible" : "A-tier max"}.`,
    };
  } else if (m1) {
    result = {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: baselineOk ? null : "A",
      confidence_delta: weights.signal_bonus,
      signals_added: 1,
      flag: null,
      justification_part: `UNDER mechanism gate — Mech 1 (minutes) confirmed${baselineNote}; ${baselineOk ? "S possible" : "A-tier max"}.`,
    };
  } else {
    // Mech 2 alone or Mech 3 alone.
    const which = m2 ? "Mech 2 (role)" : "Mech 3 (matchup)";
    if (baselineOk) {
      result = {
        fired: true,
        rule_id: "under-mechanism",
        tier_cap: "A",
        confidence_delta: weights.signal_bonus,
        signals_added: 1,
        flag: null,
        justification_part: `UNDER mechanism gate — ${which} confirmed (baseline-corroborated); A-tier max.`,
      };
    } else {
      result = {
        fired: true,
        rule_id: "under-mechanism",
        tier_cap: "B",
        confidence_delta: -weights.suppressor_penalty,
        signals_added: 0,
        flag: `⚠️ UNDER mechanism single-signal (${m2 ? "Mech 2" : "Mech 3"} only) — B-tier max, SKIP advisory`,
        justification_part: `UNDER mechanism gate — only ${which} confirmed; B-tier max with SKIP advisory.`,
      };
    }
  }

  return outlierPresent ? demoteForOutlier(result) : result;
}
