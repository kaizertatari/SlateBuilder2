// Rule: WC Projection — the model leg of the WC framework
// (WC_FRAMEWORK_SPEC.md §5, §10.2). Two modes:
//
// ANCHORED stats (a DK ladder priced the pick): the exposure-scaled model
// (λ = per-90 × minutes × env, composed in soccer-truth.js) acts as
// CONFIRMER of the market, never as the spine:
//   • model agrees with the bet side (≥3pts same direction) → confidence + signal
//   • model conflicts hard (≥8pts against)                  → suppressor + A cap
//   • position-prior-only rates (no FBref row)              → A cap
//
// MODEL-LED stats (Passes Attempted / Clearances / Fantasy — no sharp
// anchor exists; market-edge already applied the B cap): the model IS the
// spine, with stricter gates than the market-led 0.53 (an unproven model
// needs more edge):
//   • prior-only rates for the stat → hard SKIP (a prior as the sole spine
//     is no spine)
//   • p_dir < 0.55 → hard SKIP; 0.55–0.60 → 1 signal; ≥0.60 → 2 signals
//
// WC-only: no-ops for basketball leagues.

import { projectProb } from "../projection.js";
import { lookupMarket } from "../odds.js";
import { WC_STAT_MODEL } from "../prop-types.js";

const AGREE_PTS = 0.03;
const CONFLICT_PTS = 0.08;

// Model-led spine thresholds (spec §10.2).
const MODEL_LED_SKIP_BELOW = 0.55;
const MODEL_LED_SIG2 = 0.60;

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (String(groundTruth?.league ?? "").toUpperCase() !== "WC") {
    return { fired: false, rule_id: "wc-projection" };
  }

  const cfg = WC_STAT_MODEL[statType];
  const proj = projectProb({ groundTruth, statType, direction, line });
  const rates = groundTruth?.soccer?.rates;
  const ratesSource = rates?.source ?? "position_prior";
  // Prior-only for THIS stat: either no FBref row at all, or the row predates
  // the field (older snapshot) — tracked per-stat by soccer-truth.js.
  const priorOnly = ratesSource.startsWith("position_prior")
    || (cfg?.field != null && Array.isArray(rates?.prior_only_fields) && rates.prior_only_fields.includes(cfg.field));

  const player = groundTruth?.info?.full_name ?? groundTruth?.player;
  const m = player ? lookupMarket({ player, stat: statType, line, league: "WC" }) : null;
  const modelLed = !m && cfg?.modelLed === true;

  const telemetry = (extra = {}) => ({
    model_prob: proj?.model_prob ?? null,
    dir_prob: proj?.dir_prob ?? null,
    lambda_model: proj?.mean ?? null,
    sigma_model: proj?.sigma ?? null,
    model_led: modelLed,
    rates_source: ratesSource,
    prior_only_stat: priorOnly,
    expected_minutes: groundTruth?.soccer?.expected_minutes ?? null,
    a_opp: groundTruth?.soccer?.a_opp_by_field?.[cfg?.field] ?? groundTruth?.soccer?.a_opp ?? null,
    ...extra,
  });

  // ── Model-led spine (spec §10.2) ──────────────────────────────────────────
  if (modelLed) {
    if (!proj || priorOnly) {
      return {
        fired: true,
        rule_id: "wc-projection",
        hard_skip: true,
        tier_cap: "SKIP",
        flag: priorOnly
          ? "⛔ Model-led prop with prior-only rates — no spine, SKIP"
          : "⛔ Model-led prop with no model — SKIP",
        justification_part: priorOnly
          ? "Model-led: rates are position-prior-only for this stat — a prior can't carry the spine (spec §10.2)."
          : "Model-led: no model probability available — SKIP.",
        _projection: telemetry({ agree: null }),
      };
    }
    const pct = (proj.dir_prob * 100).toFixed(0);
    if (proj.dir_prob < MODEL_LED_SKIP_BELOW) {
      return {
        fired: true,
        rule_id: "wc-projection",
        hard_skip: true,
        tier_cap: "SKIP",
        flag: `⛔ Model-led edge too thin — model ${pct}% for ${direction}`,
        justification_part: `Model-led spine: ${pct}% for ${direction} at ${line} (< ${MODEL_LED_SKIP_BELOW * 100}%) — abstain.`,
        _projection: telemetry({ agree: null }),
      };
    }
    const modelEdge = proj.dir_prob - 0.5;
    const signals_added = proj.dir_prob >= MODEL_LED_SIG2 ? 2 : 1;
    const confidence_delta = Math.max(-15, Math.min(12, Math.round(modelEdge * 80)));
    return {
      fired: true,
      rule_id: "wc-projection",
      confidence_delta,
      signals_added,
      flag: proj.dir_prob >= MODEL_LED_SIG2 ? `✅ Model-led edge — μ=${proj.mean}, ${pct}% for ${direction}` : null,
      justification_part: `Model-led spine: μ=${proj.mean}, σ=${proj.sigma} → ${pct}% for ${direction} at ${line}.`,
      _projection: telemetry({ agree: null }),
    };
  }

  // ── Anchored stats: model as confirmer (spec §5) ─────────────────────────
  if (!proj) {
    // No λ for this stat — cap at A on provenance grounds and surface why.
    return {
      fired: true,
      rule_id: "wc-projection",
      tier_cap: "A",
      flag: "⚠️ No model λ for this stat — market-only verdict, A-tier cap",
      justification_part: "Model: no λ available (missing rates) — market-only, capped at A.",
      _projection: telemetry({ agree: null }),
    };
  }

  const marketDir = m ? (direction === "OVER" ? m.fair_over : 1 - m.fair_over) : null;

  let confidence_delta = 0;
  let tier_cap = null;
  let suppressor = false;
  let signals_added = 0;
  let flag = null;
  let just;

  const modelEdge = proj.dir_prob - 0.5;
  const pct = (proj.dir_prob * 100).toFixed(0);

  if (marketDir != null && modelEdge >= AGREE_PTS && marketDir > 0.5) {
    signals_added = 1;
    confidence_delta = 3;
    just = `Model agrees — μ=${proj.mean} → ${pct}% for ${direction}.`;
  } else if (marketDir != null && modelEdge <= -CONFLICT_PTS && marketDir > 0.5) {
    suppressor = true;
    tier_cap = "A";
    confidence_delta = -4;
    flag = `⚠️ Model conflicts with market — model ${pct}% for ${direction}`;
    just = `Model conflict — μ=${proj.mean} gives only ${pct}% for ${direction} vs market support.`;
  } else {
    just = `Model neutral — μ=${proj.mean} → ${pct}% for ${direction}.`;
  }

  // Prior-only λ can still confirm, but it can't carry an S-tier pick.
  if (priorOnly) {
    tier_cap = tier_cap ?? "A";
    flag = flag ?? "⚠️ Rates from position prior only — A-tier cap";
  }

  return {
    fired: true,
    rule_id: "wc-projection",
    confidence_delta,
    tier_cap,
    suppressor,
    signals_added,
    flag,
    justification_part: just,
    _projection: telemetry({
      market_dir_prob: marketDir != null ? Number(marketDir.toFixed(4)) : null,
      agree: marketDir != null ? (proj.dir_prob > 0.5) === (marketDir > 0.5) : null,
    }),
  };
}
