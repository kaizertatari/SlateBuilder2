// Rule: Projection — the Stage-3 native-model confirm/deny.
//
// rule-market-edge makes the sharp no-vig market the spine. This rule adds the
// engine's OWN probability (api/_lib/projection.js: P(over) from the adjusted
// baseline + per-league σ) as a second, independent opinion:
//
//   • model agrees with the market AND both like the bet → confirmation signal
//   • model and market disagree on direction (a real gap) → conflict suppressor
//   • no market coverage → the model stands alone, with a smaller effect
//
// It never SKIPs — rule-market-edge owns the hard skip; this is a softer
// confirm/deny so an unvalidated model can't veto the market spine. Emits
// _projection telemetry (logged for calibration: "is the model predictive,
// and does model+market agreement beat market alone?"). No-ops when there's no
// baseline to project from.

import { lookupMarket } from "../odds.js";
import { projectProb } from "../projection.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  const player = groundTruth?.info?.full_name ?? groundTruth?.player;
  if (!player) return { fired: false, rule_id: "projection" };

  const proj = projectProb({ groundTruth, statType, direction, line });
  if (!proj) return { fired: false, rule_id: "projection" };

  const modelDir = proj.dir_prob;          // model P(bet side)
  const modelEdge = modelDir - 0.5;

  let signals_added = 0;
  let suppressor = false;
  let confidence_delta = 0;
  const notes = [`model ${(modelDir * 100).toFixed(0)}% ${direction}`];

  let market_agree = null;
  const m = lookupMarket({ player, stat: statType, line, league: groundTruth?.league });
  if (m && typeof m.fair_over === "number") {
    const marketDir = direction === "UNDER" ? 1 - m.fair_over : m.fair_over;
    market_agree = Math.sign(modelEdge || 0) === Math.sign((marketDir - 0.5) || 0);
    notes.push(`market ${(marketDir * 100).toFixed(0)}%`);
    if (market_agree && modelDir >= 0.55 && marketDir >= 0.55) {
      signals_added += 1; confidence_delta += 4; notes.push("model+market agree");
    } else if (!market_agree && Math.abs(modelEdge) >= 0.08) {
      suppressor = true; confidence_delta -= 4; notes.push("model⟂market conflict");
    }
  } else {
    // No market: the model is the only opinion — weaker thresholds, smaller delta.
    if (modelDir >= 0.62) { signals_added += 1; confidence_delta += 3; notes.push("model-only support"); }
    else if (modelDir <= 0.40) { suppressor = true; confidence_delta -= 3; notes.push("model-only fade"); }
  }

  const _projection = {
    model_prob: proj.model_prob,
    dir_prob: proj.dir_prob,
    mean: proj.mean,
    sigma: proj.sigma,
    market_agree,
  };

  const fired = signals_added > 0 || suppressor;
  if (!fired) return { fired: false, rule_id: "projection", _projection };

  return {
    fired: true,
    rule_id: "projection",
    confidence_delta: Math.max(-8, Math.min(6, confidence_delta)),
    suppressor,
    signals_added,
    flag: suppressor ? `⚠️ Projection — ${notes.join("; ")}` : `✅ Projection — ${notes.join("; ")}`,
    justification_part: `Projection (model P) — ${notes.join("; ")}.`,
    _projection,
  };
}
