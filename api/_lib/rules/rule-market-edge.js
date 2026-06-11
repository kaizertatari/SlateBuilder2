// Rule: Market Edge — the Stage-1 sharp-line signal.
//
// The calibration audit showed the engine's box-score projection is a coin
// flip on standard lines. Pros beat standard lines by catching when the line
// disagrees with the sharp market, not by out-projecting it. This rule pulls
// the de-vigged DraftKings fair P(over) (data/odds.json), shifts it to the
// PrizePicks line, and turns it into the dominant confidence/tier signal:
//
//   • market strongly disagrees with the bet side  → SKIP (don't bet a dog)
//   • market mildly disagrees                       → suppressor, cap tier
//   • market agrees / supports                      → confidence + signal(s)
//
// Self-contained: it looks the market up directly (no ground-truth plumbing).
// No-ops (fired:false) when there's no matching market — so props the books
// don't cover, and the existing smokes, are unaffected.

import { lookupMarket } from "../odds.js";

// Stage 5 — WNBA is a softer market: PrizePicks lines lag the sharp consensus
// more, books disagree more, and a 3-pt line gap is real edge (vs noise in the
// efficient NBA market). So WNBA acts on smaller market edges (looser signal
// thresholds) and tolerates a larger line gap before down-trusting it. The
// dog-protection thresholds (skip/cap below) stay league-agnostic — they ride
// the SHARP market, which is trustworthy in both leagues. Tunable; forward-measured.
const MARKET_TUNING = {
  NBA: { sig1: 0.56, sig2: 0.62, bigShiftPts: 3 },
  WNBA: { sig1: 0.54, sig2: 0.60, bigShiftPts: 4 },
  // WC (soccer): pricing comes from the ladder-fitted Poisson, so there is no
  // line-shift error — bigShiftPts effectively disabled. Signal thresholds
  // per WC_FRAMEWORK_SPEC.md §5 (edge ≥5pts → 1 signal, ≥8pts → 2).
  WC: { sig1: 0.55, sig2: 0.58, bigShiftPts: 99 },
};

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  const player = groundTruth?.info?.full_name ?? groundTruth?.player;
  if (!player) return { fired: false, rule_id: "market-edge" };
  const isWC = String(groundTruth?.league ?? "").toUpperCase() === "WC";

  const m = lookupMarket({ player, stat: statType, line, league: groundTruth?.league });
  if (!m) {
    // WC is market-LED (spec §6.1): no sharp ladder ⇒ nothing to price the
    // pick against ⇒ hard abstain. Basketball keeps its no-op (the box-score
    // rules carry those picks).
    if (isWC) {
      return {
        fired: true,
        rule_id: "market-edge",
        hard_skip: true,
        tier_cap: "SKIP",
        flag: "⛔ No DK ladder for this prop — WC framework is market-led, abstaining",
        justification_part: "No sharp ladder covers this player-stat; WC v1 abstains without a market spine.",
      };
    }
    return { fired: false, rule_id: "market-edge" };
  }

  // Stage 5 — per-league market tuning (WNBA looser; see MARKET_TUNING).
  const league = String(groundTruth?.league ?? m.league ?? "NBA").toUpperCase();
  const tune = MARKET_TUNING[league] ?? MARKET_TUNING.NBA;

  // lookupMarket returns the no-vig CONSENSUS fair P(over), already shifted to
  // this PrizePicks line and averaged across whichever books cover it (DK, FD).
  const fairAtLine = m.fair_over;

  // Market-implied fair probability for the SIDE we'd bet.
  const pDir = direction === "OVER" ? fairAtLine : 1 - fairAtLine;
  const edge = pDir - 0.5;

  // Large line shifts make the linear approximation unreliable — trust less.
  const bigShift = Math.abs(m.line_delta ?? 0) > tune.bigShiftPts;
  const trust = bigShift ? 0.5 : 1;
  let confidence_delta = Math.max(-15, Math.min(12, Math.round(edge * 80 * trust)));

  let tier_cap = null;
  let hard_skip = false;
  let suppressor = false;
  let signals_added = 0;

  if (isWC) {
    // Market-led tiering (spec §5): the fair edge at the PP line IS the
    // pick. <3pts edge → abstain (PP's 0.5-implied pricing leaves nothing);
    // 3–5pts → B-grade; 5–8pts → A-grade; ≥8pts → S reachable (wc-projection
    // and wc-minutes still must not cap it).
    if (pDir < 0.53) {
      hard_skip = true;
      tier_cap = "SKIP";
    } else if (pDir < tune.sig1) {
      tier_cap = "B";
      signals_added = 1;
    } else if (pDir < tune.sig2) {
      tier_cap = "A";
      signals_added = 1;
    } else {
      signals_added = 2;
    }
  } else if (pDir < 0.40) {
    // Market says the bet side is a clear dog — don't issue a −EV pick.
    hard_skip = true;
    tier_cap = "SKIP";
  } else if (pDir < 0.43) {
    suppressor = true;
    tier_cap = "B";
  } else if (pDir < 0.47) {
    suppressor = true;
    tier_cap = "A";
  } else if (pDir >= tune.sig2) {
    signals_added = 2;
  } else if (pDir >= tune.sig1) {
    signals_added = 1;
  }

  const pct = (pDir * 100).toFixed(0);
  const bookTag = `${m.books}-book`;
  const deltaNote = m.line_delta ? `, Δ${m.line_delta} vs book ${m.book_line}` : "";
  const flag = pDir < 0.43
    ? `⚠️ Market disagrees — ${bookTag} no-vig ${pct}% for ${direction}${deltaNote}`
    : pDir >= 0.58
      ? `✅ Market edge — ${bookTag} no-vig ${pct}% for ${direction}${deltaNote}`
      : null;

  return {
    fired: true,
    rule_id: "market-edge",
    confidence_delta,
    tier_cap,
    hard_skip,
    suppressor,
    signals_added,
    flag,
    justification_part: `Market(${m.source}) — no-vig ${pct}% for ${direction} at ${line}${bigShift ? " (large line gap, low trust)" : ""}; edge ${(edge * 100).toFixed(0)}%.`,
    // Surfaced for telemetry (verdict-logger) + the slate builder's EV.
    _market: {
      no_vig_prob: m.fair_over,
      fair_at_line: Number(pDir.toFixed(4)),
      line_delta: m.line_delta,
      edge: Number(edge.toFixed(4)),
      book_line: m.book_line,
      books: m.books,
      source: m.source,
      // WC ladder diagnostics (null/absent for basketball) — calibration
      // slices the reliability curve by fit quality.
      ...(m.lambda_fair != null ? { lambda_fair: m.lambda_fair, ladder_rmse: m.ladder_rmse } : {}),
    },
  };
}
