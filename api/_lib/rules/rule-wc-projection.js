// Rule: WC Projection — the model leg of the market-led WC framework
// (WC_FRAMEWORK_SPEC.md §5). The exposure-scaled Poisson model
// (λ = per-90 × minutes × opponent env, composed in soccer-truth.js) acts as
// CONFIRMER of the ladder-priced market, never as the spine:
//
//   • model agrees with the bet side (≥3pts same direction) → confidence + signal
//   • model conflicts hard (≥8pts against)                  → suppressor + A cap
//   • position-prior-only rates (no FBref row)              → A cap
//     (the provenance-guard analog: a prior-only λ is too weak for S)
//
// Never SKIPs — market-edge owns the WC hard gates. WC-only: no-ops for
// basketball leagues.

import { projectProb } from "../projection.js";
import { lookupMarket } from "../odds.js";

const AGREE_PTS = 0.03;
const CONFLICT_PTS = 0.08;

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (String(groundTruth?.league ?? "").toUpperCase() !== "WC") {
    return { fired: false, rule_id: "wc-projection" };
  }

  const proj = projectProb({ groundTruth, statType, direction, line });
  const ratesSource = groundTruth?.soccer?.rates?.source ?? "position_prior";
  const priorOnly = ratesSource.startsWith("position_prior");

  if (!proj) {
    // No λ for this stat — cap at A on provenance grounds and surface why.
    return {
      fired: true,
      rule_id: "wc-projection",
      tier_cap: "A",
      flag: "⚠️ No model λ for this stat — market-only verdict, A-tier cap",
      justification_part: "Model: no λ available (missing rates) — market-only, capped at A.",
      _projection: { model_prob: null, dir_prob: null, lambda_model: null, rates_source: ratesSource, agree: null },
    };
  }

  const player = groundTruth?.info?.full_name ?? groundTruth?.player;
  const m = player ? lookupMarket({ player, stat: statType, line, league: "WC" }) : null;
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
    just = `Model agrees — Poisson λ=${proj.mean} → ${pct}% for ${direction}.`;
  } else if (marketDir != null && modelEdge <= -CONFLICT_PTS && marketDir > 0.5) {
    suppressor = true;
    tier_cap = "A";
    confidence_delta = -4;
    flag = `⚠️ Model conflicts with market — Poisson ${pct}% for ${direction}`;
    just = `Model conflict — Poisson λ=${proj.mean} gives only ${pct}% for ${direction} vs market support.`;
  } else {
    just = `Model neutral — Poisson λ=${proj.mean} → ${pct}% for ${direction}.`;
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
    _projection: {
      model_prob: proj.model_prob,
      dir_prob: proj.dir_prob,
      lambda_model: proj.mean,
      market_dir_prob: marketDir != null ? Number(marketDir.toFixed(4)) : null,
      agree: marketDir != null ? (proj.dir_prob > 0.5) === (marketDir > 0.5) : null,
      rates_source: ratesSource,
      expected_minutes: groundTruth?.soccer?.expected_minutes ?? null,
      a_opp: groundTruth?.soccer?.a_opp ?? null,
    },
  };
}
