// Deterministic PrizePicks v3.5 verdict engine.
//
// Applies the framework's rule modules in canonical suppressor-priority
// order, resolves the most-restrictive tier cap, computes a confidence
// score via the Bayesian-style weights in rule-weights.js, and renders
// an operator-facing justification string. Returns the same shape the
// LLM used to return: { verdict, tier, confidence, flags, justification,
// rules_fired }.
//
// The engine is pure — no fetches, no LLM, no side effects beyond the
// returned object. preFilterMechanical (verdict-verifier.js) still
// runs ahead of it as a fast-path that short-circuits on the three
// arithmetic hard-gates before engine setup; this module is what runs
// when the pre-filter passes.

import * as rule5a from "./rules/rule5a.js";
import * as rule5b from "./rules/rule5b.js";
import * as rule5f from "./rules/rule5f.js";
import * as rule5h from "./rules/rule5h.js";
import * as rule5i from "./rules/rule5i.js";
import * as rule5j from "./rules/rule5j.js";
import * as rule4 from "./rules/rule4.js";
import * as rule4i from "./rules/rule4i.js";
import * as rule6 from "./rules/rule6.js";
import * as ruleR9 from "./rules/ruleR9.js";
import * as ruleGameCap from "./rules/rule-game-cap.js";
import * as ruleProvenance from "./rules/rule-provenance.js";
import * as ruleUnderMechanism from "./rules/rule-under-mechanism.js";
import * as ruleMarketEdge from "./rules/rule-market-edge.js";
import * as ruleGameScript from "./rules/rule-game-script.js";
import * as ruleProjection from "./rules/rule-projection.js";
import * as ruleRest from "./rules/rule-rest.js";
import * as ruleSTier from "./rules/rule-s-tier.js";

import { scaleFor } from "./rules/_helpers.js";
import { RULE_WEIGHTS, TIER_RANK, tierMin, snapToBand, TIER_BAND, shadowTierFor } from "./rule-weights.js";

// Pre-S-tier rules in canonical order. Suppressor priority from
// framework line 237: Rule 6 → 4c → 4i → 5f → 5c (R9). 5a/5i are
// hard-gates (run early); 5b/5h are stat-specific suppressors that
// also run early so their tier caps participate in suppressor stacking.
// rule-game-cap runs late so playoff caps don't get over-ridden by
// earlier passes. rule-s-tier MUST run last — it inspects the
// accumulated state to decide whether S is reachable.
const RULES_PRE_S = [
  ["5a", rule5a],
  ["5j", rule5j],
  ["5i", rule5i],
  ["R9", ruleR9],
  ["6", rule6],
  ["4", rule4],
  ["4i", rule4i],
  ["5f", rule5f],
  ["5h", rule5h],
  ["5b", rule5b],
  // Market-edge — the sharp-line signal (Stage 1). Runs after the box-score
  // rules so its suppressor/SKIP reflects the market's view of THIS pick.
  // No-ops when there's no matching odds (a player the books don't price), so
  // behavior is unchanged where odds aren't covered.
  ["market-edge", ruleMarketEdge],
  // Game-script — Vegas total/spread tailwind/headwind on counting stats
  // (Stage 2). Secondary to market-edge; no-ops without odds coverage.
  ["game-script", ruleGameScript],
  // Projection — native model P(over) confirm/deny vs the market (Stage 3).
  // Additive; never SKIPs (market-edge owns the hard skip). No-ops without a
  // baseline to project from.
  ["projection", ruleProjection],
  // Rest/schedule density — B2B / 3-in-4 fatigue suppressor (Stage 4).
  // Counting stats only; no-ops without gamelog dates.
  ["rest", ruleRest],
  ["provenance", ruleProvenance],
  ["game-cap", ruleGameCap],
  // UNDER mechanism gate runs late so it sees the fully-populated
  // mechanisms object. It hard-SKIPs UNDER props without a named
  // mechanism — the framework explicitly forbids UNDER without one.
  ["under-mechanism", ruleUnderMechanism],
];

/**
 * Run the deterministic v3.5 framework on a single (player, prop, line)
 * task. Returns the verdict shape the rest of the app expects.
 *
 * @param {Object} args
 * @param {Object} args.groundTruth - composed ground truth (must include
 *   mechanisms + injury_regions; see api/lib/ground-truth.js)
 * @param {string} args.statType
 * @param {"OVER"|"UNDER"} args.direction
 * @param {number} args.line
 * @returns {{
 *   verdict: "OVER" | "UNDER" | "SKIP",
 *   tier: "S" | "A" | "B" | "SKIP",
 *   confidence: number,
 *   flags: string[],
 *   justification: string,
 *   rules_fired: string[],
 * }}
 */
export function applyEngine({ groundTruth, statType, direction, line }) {
  const scale = scaleFor(groundTruth);
  const weights = RULE_WEIGHTS;
  const ctx = { groundTruth, statType, direction, line, scale, weights };

  // Accumulators.
  let tierCap = "S"; // start optimistic; rules narrow it down
  let hardSkip = false;
  let score = weights.base;
  let suppressorCount = 0;
  let signalCount = 0;
  const flags = [];
  const justParts = [];
  const rulesFired = [];

  // Track rule5a/5j buffer results so we can compute edge bonuses once
  // after the loop (avoids each rule independently re-deriving margin).
  let rule5aBuf = null;
  let rule5jBuf = null;
  let marketInfo = null;
  let vegasInfo = null;
  let projectionInfo = null;
  let restInfo = null;

  for (const [id, mod] of RULES_PRE_S) {
    const out = mod.apply(ctx);
    if (!out || !out.fired) {
      // Still surface a justification fragment if the rule cared enough
      // to emit one (e.g., "rule disabled, suppressor off" notes from 5f).
      if (out?.justification_part) justParts.push(out.justification_part);
      // Capture the neutral Vegas context even when game-script doesn't fire,
      // so calibration sees the game-script inputs on every covered pick.
      if (id === "game-script" && out?._vegas) vegasInfo = out._vegas;
      if (id === "projection" && out?._projection) projectionInfo = out._projection;
      if (id === "rest" && out?._rest) restInfo = out._rest;
      continue;
    }
    rulesFired.push(out.rule_id);
    if (out.flag) flags.push(out.flag);
    if (out.justification_part) justParts.push(out.justification_part);
    if (typeof out.confidence_delta === "number") score += out.confidence_delta;
    if (out.tier_cap) tierCap = tierMin(tierCap, out.tier_cap);
    if (out.hard_skip || out.tier_cap === "SKIP") hardSkip = true;
    if (out.suppressor) suppressorCount += 1;
    if (typeof out.signals_added === "number") signalCount += out.signals_added;
    if (id === "5a") {
      rule5aBuf = out._buf ?? null;
      // Clean OVER buffer pass counts as one independent signal.
      if (out._buf && out._buf.passes) signalCount += 1;
    }
    if (id === "5j") {
      rule5jBuf = out._buf_under ?? null;
      // UNDER baseline gate ISSUE branch counts as one signal.
      if (out._buf_under) signalCount += 1;
    }
    if (id === "market-edge") marketInfo = out._market ?? null;
    if (id === "game-script") vegasInfo = out._vegas ?? vegasInfo;
    if (id === "projection") projectionInfo = out._projection ?? projectionInfo;
    if (id === "rest") restInfo = out._rest ?? restInfo;
  }

  // Edge bonus — applied once based on rule5a's road-adjusted margin.
  if (direction === "OVER" && rule5aBuf && rule5aBuf.passes) {
    const edge = rule5aBuf.adjusted - line;
    if (edge > 0) score += edge * weights.edge_unit_bonus;
    // Additional signal: large edge (>3pts) counts as a bonus signal.
    if (edge >= 3) signalCount += 1;
  }

  // Mirror for UNDER — rule5j ISSUE branch sets _buf_under with the edge.
  if (direction === "UNDER" && rule5jBuf && rule5jBuf.edge > 0) {
    score += rule5jBuf.edge * weights.edge_unit_bonus;
    if (rule5jBuf.edge >= 3) signalCount += 1;
  }

  // Win-prob in healthy band (non-suppressor case) counts as a signal.
  const wp = groundTruth?.win_prob?.player_team_pct;
  if (typeof wp === "number" && wp >= 0.45 && wp <= 0.65) {
    signalCount += 1;
  }
  // L5 sample size ≥ 5 counts as a signal (small samples are riskier).
  if ((groundTruth?.l5?.n ?? 0) >= 5) signalCount += 1;

  // S-tier gate runs last with the accumulated state visible.
  const sOut = ruleSTier.apply({
    ...ctx,
    _state: { suppressorCount, signalCount, hardSkip },
  });
  if (sOut?.fired) {
    rulesFired.push(sOut.rule_id);
    if (sOut.flag) flags.push(sOut.flag);
    if (sOut.justification_part) justParts.push(sOut.justification_part);
    if (typeof sOut.confidence_delta === "number") score += sOut.confidence_delta;
    if (sOut.tier_cap) tierCap = tierMin(tierCap, sOut.tier_cap);
  }

  // Suppressor stacking — 2+ suppressors drops one additional tier
  // beyond the highest-priority cap, never going below B (no auto-SKIP
  // from stacking alone).
  if (!hardSkip && suppressorCount >= 2 && tierCap !== "SKIP") {
    const ranks = ["S", "A", "B"];
    const idx = ranks.indexOf(tierCap);
    if (idx >= 0 && idx < ranks.length - 1) {
      tierCap = ranks[idx + 1];
      flags.push(`⚠️ Suppressor stacking — ${suppressorCount} suppressors active, tier dropped to ${tierCap}`);
    }
  }

  // Strong-suppressor thin-edge gate. 5b (foul-prone/slump) and 5h
  // (FT-leak / elite defense) flag a scoring/rebounding suppressant the
  // baseline doesn't capture. Calibration (2026-05, n≈40): OVER picks
  // where they fire hit ~38-40% when issued. When one fired on an OVER
  // that cleared the line by less than suppressor_thin_edge_mult× its own
  // Rule 5a buffer, SKIP rather than issue a coin-flip-minus pick; a
  // genuinely large edge still issues. OVER-only — on UNDER these
  // suppressants support the bet, so that path is left untouched.
  if (!hardSkip && direction === "OVER" && rule5aBuf?.passes
      && (rulesFired.includes("5b") || rulesFired.includes("5h"))) {
    const edge = rule5aBuf.adjusted - line;
    const minEdge = rule5aBuf.buffer * weights.suppressor_thin_edge_mult;
    if (edge < minEdge) {
      hardSkip = true;
      flags.push(`⚠️ 5b/5h suppressor + thin edge (${edge.toFixed(1)} < ${minEdge.toFixed(1)}) — SKIP`);
    }
  }

  // Resolve final verdict + tier.
  let verdict, tier;
  if (hardSkip || tierCap === "SKIP") {
    verdict = "SKIP";
    tier = "SKIP";
  } else {
    verdict = direction;
    tier = tierCap;
    // Game-2 hard ceiling — never higher than A.
    if (groundTruth?.series?.next_game_number === 2 && TIER_RANK[tier] > TIER_RANK.A) {
      tier = "A";
    }
  }

  // SHADOW telemetry (TEMPORARY — retire when the snapToBand fix flips on).
  // The tier the raw pre-snap score WOULD resolve to once score-driven
  // demote/SKIP is enabled (currently dead code — see the snap block below).
  // Does NOT affect the live verdict/tier/confidence; logged so
  // calibration-report can size that change before we ship it.
  const shadow_tier = shadowTierFor(tier, score);

  // Snap confidence into the tier's band.
  let confidence;
  if (tier === "SKIP") {
    confidence = 0;
  } else {
    confidence = snapToBand(score, tier);
    // If the raw score doesn't reach the tier's floor, demote the tier
    // until it fits (e.g., score=64 with tier="A" → demote to B). Keeps
    // confidence and tier internally consistent.
    while (confidence < (TIER_BAND[tier]?.lo ?? 0) && tier !== "B") {
      if (tier === "S") tier = "A";
      else if (tier === "A") tier = "B";
      else break;
      confidence = snapToBand(score, tier);
    }
    // If even B's floor isn't reached, the verdict downgrades to SKIP
    // (framework: "<62% confidence → SKIP").
    if (confidence < TIER_BAND.B.lo) {
      verdict = "SKIP";
      tier = "SKIP";
      confidence = 0;
    }
  }

  const justification = justParts.length
    ? justParts.join(" ").slice(0, 800)
    : `Engine — no rules fired; default ${direction} at ${tier} based on baseline math.`;

  return {
    verdict,
    tier,
    confidence,
    // Raw pre-band-snap score (telemetry only — does NOT affect verdict,
    // tier, or confidence). Confidence is snapped into the tier band, so
    // the logged confidence has only three effective levels; raw_score
    // preserves the underlying spread for a finer reliability curve.
    // See scripts/calibration-report.mjs.
    raw_score: Math.round(score * 10) / 10,
    // SHADOW (telemetry only; see above) — retire with the snapToBand flip.
    shadow_tier,
    // Sharp-market signal (Stage 1) when odds covered this pick; null otherwise.
    // Consumed by verdict-logger (calibration) and the slate builder (EV).
    market: marketInfo,
    // Vegas game-script context (Stage 2) when odds covered the player's game;
    // null otherwise. Logged for calibration slicing.
    vegas: vegasInfo,
    // Native model P(over) + market agreement (Stage 3). Logged for
    // calibration; the market stays the spine until the model grades out.
    projection: projectionInfo,
    // Rest / schedule-density context (Stage 4). Null without gamelog dates.
    rest: restInfo,
    flags,
    justification,
    rules_fired: rulesFired,
  };
}
