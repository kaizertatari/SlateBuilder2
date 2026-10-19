// Basketball probability pipeline, step 2: model + market → probability →
// tier, on the shared contract (api/_lib/pick-policy.js) that EPL and NFL
// already use. Pure. SHADOW: logged as pipe_* on every basketball verdict;
// the rules engine still issues the real tier.
//
//   model    calibrated NB P(over) (dist.js) at the PrizePicks line
//   market   de-vigged sportsbook consensus P(over) shifted to that line
//            (odds.js lookupMarket → result.market.no_vig_prob)
//   blend    log-odds pool, 50/50. On the 74 graded standard WNBA lines with
//            a market (2026-10-19): engine 0.7303, calibrated 0.6974, market
//            0.6927, blend 0.6876 at 50% market (flat 40–70%) — too few lines
//            to tune, so the EPL weight is reused; refit on graded NBA lines
//            during shadow (eval-opp-factor section 4).
//   no market → model-only: logged and priced, never tiered (EPL lesson:
//            model-only picks lost; basketball has no evidence either way yet)

import { blendProb, tierForEdge } from "../pick-policy.js";

export const BASKETBALL_POLICY = {
  version: 1,
  blend: { model: 0.5, market: 0.5 },
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
