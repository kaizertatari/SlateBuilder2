// Basketball probability pipeline, step 2: model + market → probability →
// tier, on the shared contract (api/_lib/pick-policy.js) that EPL and NFL
// already use. Pure. SHADOW: logged as pipe_* on every basketball verdict;
// the rules engine still issues the real tier.
//
//   model    calibrated NB P(over) (dist.js) at the PrizePicks line
//   market   de-vigged sportsbook consensus P(over) shifted to that line
//            (odds.js lookupMarket → result.market.no_vig_prob)
//   blend    log-odds pool, 20% model / 80% market (version 2, 2026-11-03).
//            Version 1 was 50/50 (EPL weight, 74 graded WNBA lines). Refit on
//            14,183 graded NBA lines with a market: P(over) log loss falls
//            monotonically toward the market (0.6779 at 50/50, 0.6424 market
//            only) with the unshrunk mean; with the early-season shrunk mean
//            the in-sample best is 0.2 (0.6507 vs market 0.6518), though
//            leave-one-day-out (5 days) still favours the market. The model is
//            the shrunk mean on NBA (verdict-logger pipe_model_src).
//   no market → model-only: logged and priced, never tiered (EPL lesson:
//            model-only picks lost; basketball has no evidence either way yet)

import { blendProb, tierForEdge } from "../pick-policy.js";

// Shown on every basketball ENGINE pick on a standard line (user decision
// 2026-10-19: keep standard picks, warn; goblins left unchanged). Remove when
// the pipeline replaces the engine's tiers.
export const ENGINE_STANDARD_WARNING =
  "⚠️ Unvalidated: basketball engine picks on standard lines hit 52.5% vs the 57.7% break-even on 2,218 graded NBA picks (14 game days, as of 2026-11-03). A probability pipeline is still being validated in shadow.";

export const BASKETBALL_POLICY = {
  version: 2,
  blend: { model: 0.2, market: 0.8 },
  modelOnlyShrink: 0.5,
  tierEdge: { A: 0.05, B: 0.015 },
  maxTier: "A",
  modelOnlyMaxTier: "SKIP",
  approxPayoutMaxTier: "B",
};

/**
 * @param {{ pModelOver:number, pMarketOver?:number|null, direction:"OVER"|"UNDER", oddsType?:string }} a
 * @returns {null | { prob:number, tier:string, edge:number, break_even:number, model_only:boolean, version:number }}
 *   prob = P(the bet side) after the blend
 */
export function pipelineVerdict({ pModelOver, pMarketOver = null, direction, oddsType = "standard" }, policy = BASKETBALL_POLICY) {
  if (typeof pModelOver !== "number" || !Number.isFinite(pModelOver)) return null;
  const side = (p) => (direction === "UNDER" ? 1 - p : p);
  const { prob, modelOnly } = blendProb({
    pModel: side(pModelOver),
    pMarket: typeof pMarketOver === "number" ? side(pMarketOver) : null,
    blend: policy.blend, modelOnlyShrink: policy.modelOnlyShrink,
  });
  const t = tierForEdge(prob, oddsType || "standard", policy, { modelOnly });
  return { prob, tier: t.tier, edge: t.edge, break_even: t.break_even, model_only: modelOnly, version: policy.version };
}
