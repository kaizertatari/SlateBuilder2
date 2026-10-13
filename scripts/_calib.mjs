// Cross-league calibration helpers over the durable graded store
// (scripts/_graded.mjs). Pure — the report script does the I/O.
//
// Every league's rows are normalized to one shape so the same metrics apply:
//   p_engine  the probability the engine stands behind for the bet side
//             (EPL: blended epl_prob; basketball: the projection's
//             model_dir_prob — basketball's tier/confidence is a rule score)
//   p_model   model-only P(bet side)       p_market  de-vigged book P(bet side)
//   p_conf    confidence / 100 — scored so a score posing as a % is exposed
//   break_even  per-leg break-even for the line type

import { breakEven } from "../api/_lib/pick-policy.js";
import { scoreProbs, reliability, wilson } from "../api/_lib/epl/grading.js";

export { scoreProbs, reliability, wilson };

const num = (x) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const prob = (x) => { const p = num(x); return p != null && p > 0 && p < 1 ? p : null; };

export const statOf = (r) => r.epl_stat ?? (r.prop_type ? String(r.prop_type).replace(/\s+(OVER|UNDER)\s*$/i, "").trim() : null);

/** Why a row is left out of calibration, or null when it counts. */
export function exclusionOf(r) {
  if (r.logged_after_kickoff) return "logged after kickoff";
  const hm = r.outcome?.hit_or_miss;
  if (hm !== "hit" && hm !== "miss") return hm || "ungraded";
  return null;
}

export function normalizeRow(r) {
  const isEpl = r.league === "EPL";
  const oddsType = r.odds_type || "standard";
  return {
    league: r.league,
    tier: r.tier || "SKIP",
    bettable: !!r.tier && r.tier !== "SKIP" && !r.pre_filtered,
    pre_filtered: !!r.pre_filtered,
    odds_type: oddsType,
    direction: r.direction,
    stat: statOf(r),
    game_start_time: r.game_start_time,
    excluded: exclusionOf(r),
    y: r.outcome?.hit_or_miss === "hit" ? 1 : r.outcome?.hit_or_miss === "miss" ? 0 : null,
    p_engine: prob(isEpl ? r.epl_prob : r.model_dir_prob),
    p_model: prob(isEpl ? r.epl_p_model : r.model_dir_prob),
    p_market: prob(isEpl ? r.epl_p_market : r.market_fair_at_line),
    p_conf: prob(num(r.confidence) != null ? num(r.confidence) / 100 : null),
    break_even: num(r.epl_break_even) ?? breakEven(oddsType),
    mean: num(isEpl ? r.epl_mean : r.model_mean),
    sigma: num(r.model_sigma),
    actual: num(r.outcome?.actual_value),
  };
}

/** Hit rate + Wilson CI + mean predicted/break-even for a group of settled rows. */
export function hitSummary(rows) {
  const n = rows.length;
  const hits = rows.reduce((a, r) => a + r.y, 0);
  const ci = wilson(hits, n);
  const mean = (f) => { const v = rows.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  return { n, hits, hit: n ? hits / n : null, lo: ci.lo, hi: ci.hi, predicted: mean((r) => r.p_engine), break_even: mean((r) => r.break_even) };
}

export function groupBy(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return [...g.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * Score probability sources on the SAME rows (only rows where every named
 * source is present), plus coin-flip and base-rate baselines — so a source is
 * judged against "knowing nothing" on identical lines.
 */
export function compareSources(rows, sources) {
  const common = rows.filter((r) => sources.every((s) => r[s] != null));
  if (!common.length) return { n: 0, scores: [] };
  const y = common.map((r) => r.y);
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  const scores = sources.map((s) => ({ source: s, ...scoreProbs(common.map((r) => r[s]), y) }));
  scores.push({ source: "coin flip (0.5)", ...scoreProbs(common.map(() => 0.5), y) });
  scores.push({ source: `base rate (${(base * 100).toFixed(1)}%)`, ...scoreProbs(common.map(() => base), y) });
  return { n: common.length, scores };
}

/**
 * σ calibration: spread of the realized z = (actual − mean)/σ. A well-sized
 * σ gives sd(z) ≈ 1; sd(z) = 1.5 means σ should be 1.5× wider. mean(z) < 0
 * means the projected mean runs high.
 */
export function sigmaCheck(rows) {
  const z = rows.filter((r) => r.mean != null && r.sigma > 0 && r.actual != null).map((r) => (r.actual - r.mean) / r.sigma);
  if (z.length < 2) return null;
  const m = z.reduce((a, b) => a + b, 0) / z.length;
  const sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1));
  return { n: z.length, sd_z: sd, mean_z: m };
}

export const UNLOCK = { minStandardPicks: 150, maxCalibrationGap: 0.03 };

/**
 * Shadow-mode unlock: standard-line picks only (their payout is exact).
 * Needs ≥ minStandardPicks, hit rate ≥ break-even, and the engine's mean
 * predicted P within maxCalibrationGap of the realized hit rate.
 */
export function unlockChecklist(settledPicks) {
  const std = settledPicks.filter((r) => r.odds_type === "standard");
  const s = hitSummary(std);
  const gap = s.predicted != null && s.hit != null ? Math.abs(s.predicted - s.hit) : null;
  const checks = [
    { label: `≥ ${UNLOCK.minStandardPicks} graded standard picks`, ok: s.n >= UNLOCK.minStandardPicks, value: String(s.n) },
    { label: "standard picks hit ≥ break-even", ok: s.n > 0 && s.hit >= s.break_even, value: s.n ? `${(s.hit * 100).toFixed(1)}% vs ${(s.break_even * 100).toFixed(1)}%` : "—" },
    { label: `predicted vs realized within ${UNLOCK.maxCalibrationGap * 100} pts`, ok: gap != null && gap <= UNLOCK.maxCalibrationGap, value: gap == null ? "no engine probability" : `${(gap * 100).toFixed(1)} pts` },
  ];
  return { checks, unlocked: checks.every((c) => c.ok) };
}

/**
 * Same-game over/over correlation from graded rows (raw store rows): φ of the
 * "went over the line" indicators for every pair of distinct props in one
 * game, split by same player / teammate / opponent (side from player_team,
 * or opponent+home_away for basketball rows). These are the measurements
 * behind api/_lib/correlation.js CORRELATION_PRIORS.
 * @returns {Array<{ relation:string, pairs:number, phi:number|null }>}
 */
export function overCorrelation(raw) {
  const ok = raw.filter((r) => !r.logged_after_kickoff && Number.isFinite(Number(r.outcome?.actual_value)) && r.outcome?.hit_or_miss !== "void");
  // One leg per (game, player, stat) — prefer the standard line.
  const legs = new Map();
  for (const r of ok) {
    const k = `${r.game_start_time}|${r.fotmob_match_id ?? ""}|${r.player}|${statOf(r)}`;
    const prev = legs.get(k);
    if (!prev || (r.odds_type === "standard" && prev.odds_type !== "standard")) legs.set(k, r);
  }
  const games = new Map();
  for (const r of legs.values()) {
    const g = `${r.game_start_time}|${r.fotmob_match_id ?? ""}`;
    if (!games.has(g)) games.set(g, []);
    games.get(g).push({ r, over: Number(r.outcome.actual_value) > Number(r.line) ? 1 : 0, side: r.player_team ?? r.team ?? (r.opponent ? `${r.opponent}|${r.home_away ?? ""}` : null) });
  }
  const acc = new Map();
  for (const ls of games.values()) {
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
      const a = ls[i], b = ls[j];
      const rel = a.r.player === b.r.player ? "same player" : a.side && b.side ? (a.side === b.side ? "teammate" : "opponent") : "other player, same game";
      const s = acc.get(rel) ?? { n: 0, a: 0, b: 0, ab: 0 };
      s.n++; s.a += a.over; s.b += b.over; s.ab += a.over * b.over;
      acc.set(rel, s);
    }
  }
  return [...acc.entries()].map(([relation, s]) => {
    const ma = s.a / s.n, mb = s.b / s.n;
    const den = Math.sqrt(ma * (1 - ma) * mb * (1 - mb));
    return { relation, pairs: s.n, phi: den > 0 ? (s.ab / s.n - ma * mb) / den : null };
  }).sort((x, y) => y.pairs - x.pairs);
}
