// Slate builder — turns scored candidate legs into the single best +EV slate,
// or ABSTAINS when nothing clears the bar.
//
// This is the whole point of the pivot: the engine's job is per-leg
// probability; this module's job is to (1) attach the calibrated P(hit),
// (2) assemble the `size`-leg slate that maximizes expected value at the
// requested payout target, under a correlation rule, and (3) refuse to bet
// when no slate is +EV. Given the calibration shows no standard-line edge
// today, "refuse" is the correct — and most profitable — output most days.
//
// EV definitions (stake = 1 unit):
//   Power : EV = winMultiplier · Π p_i − 1          (all legs must hit)
//   Flex  : EV = Σ_k P(exactly k hit)·payout(k) − 1 (partial payouts)
//
// Independence is assumed AFTER the diversification rule (max 1 leg per game,
// which also caps one leg per player). That's why v1 diversifies rather than
// stacks — it keeps Π p_i honest. Same-game correlation is a later upgrade.

import { calibratedProb, calibrationSupport } from "./calibration.js";
import { powerMultiplier, flexMultiplier, POWER_MULTIPLIER, FLEX_PAYOUTS } from "./prizepicks-payouts.js";

const LINE_TYPE_FACTOR = { standard: 1, goblin: 0.76, demon: 1.6, unknown: 1 };

// P(exactly k of n hit) for independent legs — Poisson-binomial DP.
function poissonBinomial(probs) {
  let dp = [1];
  for (const p of probs) {
    const next = new Array(dp.length + 1).fill(0);
    for (let k = 0; k < dp.length; k++) {
      next[k] += dp[k] * (1 - p);
      next[k + 1] += dp[k] * p;
    }
    dp = next;
  }
  return dp; // dp[k] = P(exactly k hit), length n+1
}

// EV + win multiplier for a fully-formed slate.
function evaluateSlate(legs, mode) {
  const n = legs.length;
  const probs = legs.map((l) => l.prob);
  if (mode === "flex") {
    const dist = poissonBinomial(probs);
    let ev = 0;
    let approx = false;
    for (let k = 0; k <= n; k++) {
      const m = flexMultiplier(legs, k);
      approx = approx || m.approx;
      ev += dist[k] * m.multiplier;
    }
    const win = flexMultiplier(legs, n);
    return { ev: ev - 1, win_multiplier: win.multiplier, approx, p_all: dist[n], dist };
  }
  // power
  const pAll = probs.reduce((a, b) => a * b, 1);
  const m = powerMultiplier(legs);
  return { ev: m.multiplier * pAll - 1, win_multiplier: m.multiplier, approx: m.approx, p_all: pAll, dist: null };
}

/**
 * @param {Array<Object>} candidates scored legs: { player, stat_type|statType,
 *   direction, line, odds_type|oddsType, confidence, verdict?, tier?, game?,
 *   player_team?, opponent?, prob?, market_fair_at_line?, market_line_delta? }
 *   per-leg prob preference: prob > market_fair_at_line > confidence calibration
 * @param {Object} [options]
 * @param {number} [options.targetMultiplier=3] minimum win multiplier to bet
 * @param {"power"|"flex"} [options.mode="power"]
 * @param {number} [options.size=3]
 * @param {number} [options.maxPerGame=1] diversification (1 = one leg/game)
 * @param {number} [options.minEdge=0] minimum slate EV to bet (0 = strictly +EV)
 * @param {number} [options.minSupport=0] drop legs whose calibration cell n < this
 * @param {number} [options.topPoolCap=40] cap pool size before enumeration
 * @returns {Object} { abstained, reason, slate, considered, best_rejected, params }
 */
export function buildSlate(candidates, options = {}) {
  const {
    targetMultiplier = 3,
    mode = "power",
    size = 3,
    maxPerGame = 1,
    minEdge = 0,
    minSupport = 0,
    topPoolCap = 40,
  } = options;

  const params = { targetMultiplier, mode, size, maxPerGame, minEdge, minSupport };

  if (POWER_MULTIPLIER[size] == null || (mode === "flex" && !FLEX_PAYOUTS[size])) {
    return { abstained: true, reason: `unsupported slate size ${size} for ${mode}`, slate: null, considered: 0, best_rejected: null, params };
  }

  // 1. Enrich with calibrated probability + a per-(player,stat) key + game.
  const enriched = (candidates || [])
    .filter((c) => c && (c.verdict ? c.verdict !== "SKIP" : true))
    .map((c) => {
      const oddsType = (c.odds_type ?? c.oddsType ?? null);
      const confidence = c.confidence ?? null;
      const stat = c.stat_type ?? c.statType ?? "";
      // Per-leg probability, best signal first:
      //   explicit c.prob  >  sharp-market fair P at the line  >  confidence calibration
      // The market fair_at_line (rule-market-edge / verdict log) is the sharpest
      // estimate on standard lines, where engine confidence is ~noise. It's
      // carried on the candidate (attached by the engine result or the Axiom
      // row) — buildSlate stays pure (no live odds I/O ⇒ no backtest look-ahead).
      const marketP = typeof c.market_fair_at_line === "number" ? c.market_fair_at_line : null;
      let prob, prob_source;
      if (typeof c.prob === "number") { prob = c.prob; prob_source = "explicit"; }
      else if (marketP != null) { prob = marketP; prob_source = "market"; }
      else { prob = calibratedProb({ confidence, oddsType }); prob_source = "calibration"; }
      const support = typeof c.support === "number" ? c.support : calibrationSupport({ confidence, oddsType });
      const game = c.game || c.gameKey || `${c.player_team || ""}@${c.opponent || ""}`;
      return { ...c, oddsType, odds_type: oddsType, confidence, prob, prob_source, support, stat,
        propKey: `${String(c.player || "").toLowerCase()}|${String(stat).toLowerCase()}`,
        game,
        rank: (LINE_TYPE_FACTOR[(oddsType || "standard")] ?? 1) * prob };
    })
    .filter((c) => typeof c.prob === "number" && c.prob > 0 && c.support >= minSupport);

  // 2. One variant per (player, stat): a prop can appear as goblin/standard/
  //    demon and OVER/UNDER, but only one can go on a slate. Keep the variant
  //    with the best EV-contribution proxy (line-type factor × prob).
  const bestByProp = new Map();
  for (const c of enriched) {
    const prev = bestByProp.get(c.propKey);
    if (!prev || c.rank > prev.rank) bestByProp.set(c.propKey, c);
  }
  let pool = [...bestByProp.values()].sort((a, b) => b.rank - a.rank);
  if (pool.length > topPoolCap) pool = pool.slice(0, topPoolCap);

  if (pool.length < size) {
    return { abstained: true, reason: `only ${pool.length} eligible legs (< ${size})`, slate: null, considered: pool.length, best_rejected: null, params };
  }

  // 3. Enumerate size-combinations under the per-game cap; keep the best +EV
  //    slate clearing the target, and (separately) the best-EV slate overall
  //    for diagnostics when we abstain.
  let best = null;
  let bestRejected = null;
  const idx = new Array(size);

  const consider = (legs) => {
    // per-game cap
    const perGame = {};
    for (const l of legs) {
      perGame[l.game] = (perGame[l.game] || 0) + 1;
      if (perGame[l.game] > maxPerGame) return;
    }
    const ev = evaluateSlate(legs, mode);
    if (!bestRejected || ev.ev > bestRejected.ev) bestRejected = { ev: ev.ev, win_multiplier: ev.win_multiplier };
    const qualifies = ev.win_multiplier >= targetMultiplier && ev.ev >= minEdge;
    if (qualifies && (!best || ev.ev > best.evObj.ev)) best = { legs: legs.slice(), evObj: ev };
  };

  // recursive combination generator over pool
  const recurse = (start, depth) => {
    if (depth === size) {
      consider(idx.map((i) => pool[i]));
      return;
    }
    for (let i = start; i < pool.length; i++) {
      idx[depth] = i;
      recurse(i + 1, depth + 1);
    }
  };
  recurse(0, 0);

  if (!best) {
    const why = bestRejected
      ? `no +EV slate at ≥${targetMultiplier}× — best candidate EV ${(bestRejected.ev * 100).toFixed(1)}% at ${bestRejected.win_multiplier}×`
      : "no valid slate under constraints";
    return { abstained: true, reason: why, slate: null, considered: pool.length, best_rejected: bestRejected, params };
  }

  const { legs, evObj } = best;
  return {
    abstained: false,
    reason: null,
    considered: pool.length,
    best_rejected: bestRejected,
    params,
    slate: {
      mode,
      size,
      legs: legs.map((l) => ({
        player: l.player,
        stat_type: l.stat,
        direction: l.direction ?? l.verdict ?? null,
        line: l.line,
        odds_type: l.oddsType,
        confidence: l.confidence,
        prob: round3(l.prob),
        prob_source: l.prob_source,
        market_line_delta: l.market_line_delta ?? null,
        game: l.game,
        support: l.support,
      })),
      win_multiplier: evObj.win_multiplier,
      approx_multiplier: evObj.approx,
      p_all: round3(evObj.p_all),
      ev: round3(evObj.ev),
      expected_return: round3(evObj.ev + 1),
      hit_distribution: evObj.dist ? evObj.dist.map(round3) : undefined,
    },
  };
}

function round3(x) {
  return typeof x === "number" ? Math.round(x * 1000) / 1000 : x;
}
