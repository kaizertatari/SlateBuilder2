// PrizePicks payout tables + slate multiplier helpers.
//
// ACCURACY NOTE — read before trusting a non-standard multiplier:
//   • The Power/Flex tables below are EXACT for all-STANDARD slates and are
//     the well-known PrizePicks values. (VERIFY against the live board — they
//     shift with promos/region.)
//   • goblin/demon legs change the multiplier by a per-pick amount that
//     PrizePicks prices PER LINE (how far the line was moved), NOT by a fixed
//     factor. We cannot reproduce it exactly without the board's per-pick
//     multiplier, which the projections scrape does not yet capture. So any
//     slate containing a goblin/demon leg returns `approx: true` and uses the
//     coarse LINE_TYPE_FACTOR below. The slate builder targets ≥3×, which
//     standard legs satisfy and goblins generally do not, so v1 EV on the
//     intended target is exact; mixed-slate EV is indicative only.
//
//   TODO(accuracy): capture each projection's payout multiplier in
//   scripts/scrape-prizepicks.mjs and thread it onto candidates, then replace
//   LINE_TYPE_FACTOR with the real per-pick multiplier here.

// Power Play — all legs must hit. n → win multiplier.
export const POWER_MULTIPLIER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 };

// Flex Play — partial payouts. n → { correctLegs → multiplier }. Outcomes
// below the lowest listed key pay 0 (lose stake).
export const FLEX_PAYOUTS = {
  3: { 3: 2.25, 2: 1.25 },
  4: { 4: 5, 3: 1.5 },
  5: { 5: 10, 4: 2, 3: 0.4 },
  6: { 6: 25, 5: 2, 4: 0.4 },
};

export const SUPPORTED_SIZES = Object.keys(POWER_MULTIPLIER).map(Number);

// Coarse per-pick multiplier relative to a standard pick. APPROXIMATE — see
// the accuracy note. Loosely back-fit from observed entries (≈3 goblins paid
// ~2.2× vs a standard 3-pick 5× ⇒ ~0.76 each); demon is the rough inverse.
const LINE_TYPE_FACTOR = { standard: 1, goblin: 0.76, demon: 1.6, unknown: 1 };

function legFactorProduct(legs) {
  let prod = 1;
  let approx = false;
  for (const l of legs) {
    const ot = (l.odds_type || l.oddsType || "standard").toLowerCase();
    if (ot !== "standard") approx = true;
    prod *= LINE_TYPE_FACTOR[ot] ?? 1;
  }
  return { prod, approx };
}

/**
 * Win multiplier for a Power slate (all legs hit). Exact for all-standard;
 * `approx: true` when any goblin/demon leg is present.
 * @returns {{ multiplier: number, approx: boolean }}
 */
export function powerMultiplier(legs) {
  const n = legs.length;
  const base = POWER_MULTIPLIER[n];
  if (base == null) return { multiplier: 0, approx: false };
  const { prod, approx } = legFactorProduct(legs);
  return { multiplier: round2(base * prod), approx };
}

/**
 * Flex multiplier for exactly `hits` correct of `legs.length`. Exact for
 * all-standard; `approx` when goblin/demon present.
 * @returns {{ multiplier: number, approx: boolean }}
 */
export function flexMultiplier(legs, hits) {
  const n = legs.length;
  const table = FLEX_PAYOUTS[n];
  if (!table) return { multiplier: 0, approx: false };
  const base = table[hits] ?? 0;
  const { prod, approx } = legFactorProduct(legs);
  return { multiplier: round2(base * prod), approx };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
