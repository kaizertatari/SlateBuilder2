// Shared pick policy — the one contract every probability-based league
// follows (EPL now; NFL and the basketball port next):
//
//   1. the league produces P(bet side) for the exact line
//   2. blendProb pools model + market in log-odds; with no book price the
//      model is shrunk toward 50/50 (≈ the PrizePicks line, posted near the
//      median) — model-only edges lost money in every graded league
//   3. tierForEdge: tier from P − the line type's per-leg break-even, then
//      ceilings (approximate goblin/demon payouts, model-only, league maxTier)
//   4. confidence = round(P × 100), so it reads as the probability it is
//
// Pure. Leagues add their own situational caps (lineups, injuries, thin
// samples) on top with capTier.

import { POWER_MULTIPLIER, LINE_TYPE_FACTOR } from "./prizepicks-payouts.js";

export const TIER_RANK = { SKIP: 0, B: 1, A: 2, S: 3 };
export const capTier = (tier, cap) => (TIER_RANK[tier] > TIER_RANK[cap] ? cap : tier);

export const clampP = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
export const logit = (p) => Math.log(p / (1 - p));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Per-leg break-even: 2-pick power (3×) reference × the app's line-type
// factor. Exact for standard (57.7%); goblin/demon are approximate until the
// scrape captures PrizePicks' per-pick multipliers.
export function breakEven(oddsType = "standard") {
  return 1 / (Math.sqrt(POWER_MULTIPLIER[2]) * (LINE_TYPE_FACTOR[oddsType] ?? 1));
}

/**
 * Pool model and market P(bet side) in log-odds.
 * @param {{ pModel:number, pMarket?:number|null, blend:{model:number,market:number}, modelOnlyShrink:number }} a
 * @returns {{ prob:number, modelOnly:boolean }}
 */
export function blendProb({ pModel, pMarket = null, blend, modelOnlyShrink }) {
  const modelOnly = pMarket == null;
  const x = modelOnly
    ? modelOnlyShrink * logit(clampP(pModel))
    : blend.model * logit(clampP(pModel)) + blend.market * logit(clampP(pMarket));
  return { prob: sigmoid(x), modelOnly };
}

/**
 * Tier from edge over the line type's break-even, with the shared ceilings.
 * @param {number} prob
 * @param {string} oddsType  standard | goblin | demon
 * @param {{ tierEdge:{A:number,B:number,S?:number}, maxTier:string, approxPayoutMaxTier:string, modelOnlyMaxTier:string }} policy
 * @param {{ modelOnly?:boolean }} [o]
 * @returns {{ tier:string, edge:number, break_even:number, rules:string[], flags:string[] }}
 */
export function tierForEdge(prob, oddsType, policy, { modelOnly = false } = {}) {
  const be = breakEven(oddsType);
  const edge = prob - be;
  const { tierEdge } = policy;
  let tier = tierEdge.S != null && edge >= tierEdge.S ? "S" : edge >= tierEdge.A ? "A" : edge >= tierEdge.B ? "B" : "SKIP";
  const rules = [];
  const flags = [];
  tier = capTier(tier, policy.maxTier);
  if (tier !== "SKIP") {
    if (oddsType !== "standard") {
      tier = capTier(tier, policy.approxPayoutMaxTier);
      rules.push("cap:approx-payout");
      flags.push(`⚠️ ${oddsType} payout is approximate — capped at ${policy.approxPayoutMaxTier}`);
    }
    if (modelOnly) {
      tier = capTier(tier, policy.modelOnlyMaxTier);
      rules.push("cap:model-only");
      flags.push(`⚠️ No sportsbook market for this stat — model only, capped at ${policy.modelOnlyMaxTier}`);
    }
  }
  return { tier, edge, break_even: be, rules, flags };
}
