// NFL counterpart of /api/analyze-all's per-player loop: same line selection
// (select-lines.js), same response shape as EPL/basketball so the UI renders
// it unchanged, priced by the NFL verdict engine.

import { selectLinesForStat } from "../select-lines.js";
import { logNflVerdicts } from "../verdict-logger.js";
import { getNflContext } from "./store.js";
import { nflVerdict, mapNflStat, NFL_STAT_LABEL } from "./verdict.js";

/**
 * @param {Object} a
 * @param {string} a.player           lines-snapshot by_player key
 * @param {Array<Object>} a.props     that player's NFL props
 * @param {Set<string>|null} a.allowedStats  display labels (NFL_STATS), null = all
 * @param {Array<"OVER"|"UNDER">} a.directions
 * @param {string[]|null} a.oddsTypes
 * @param {number} [a.maxLines=60]
 * @param {Object} [a.ctx]            prebuilt context (tests / batch callers)
 */
export async function analyzeNflPlayer({ player, props, allowedStats = null, directions = ["OVER", "UNDER"], oddsTypes = null, maxLines = 60, ctx = null, source = "analyze-all" }) {
  const buckets = new Map();
  for (const p of props) {
    const stat = mapNflStat(p.stat_type);
    const label = stat ? NFL_STAT_LABEL[stat] : null;
    if (!label || (allowedStats && !allowedStats.has(label))) continue;
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(p);
  }
  const tasks = [];
  for (const [label, bucket] of buckets) {
    for (const dir of directions) {
      for (const chosen of selectLinesForStat(bucket, dir, oddsTypes)) {
        if (tasks.length >= maxLines) break;
        tasks.push({ label, dir, prop: chosen });
      }
    }
  }
  if (!tasks.length) {
    return { total_analyzed: 0, total_s_a: 0, tier_counts: { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 }, top_10: [], message: "No matching lines found for the given filters." };
  }

  const context = ctx ?? (await getNflContext());
  const verdicts = tasks.map((t) => ({ task: t, v: nflVerdict(t.prop, t.dir, context) }));
  logNflVerdicts(verdicts.map((x) => x.v), { source });

  const tierCounts = { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 };
  const skipped = [];
  const results = [];
  for (const { task, v } of verdicts) {
    tierCounts[v.tier] = (tierCounts[v.tier] ?? 0) + 1;
    if (v.pre_filtered && v.skip_reason !== "over_only_line") skipped.push({ stat: task.label, line: task.prop.line, reason: v.skip_reason });
    if (v.tier === "SKIP") continue;
    results.push({
      player,
      league: "NFL",
      game: v.game,
      prop_type: task.label,
      direction: v.verdict,
      line: v.line,
      odds_type: v.odds_type,
      verdict: v.verdict,
      tier: v.tier,
      confidence: v.confidence,
      prob: v.prob,
      break_even: v.break_even,
      edge: v.edge,
      justification: v.justification,
      rules_fired: v.rules_fired,
      flags: v.flags,
      detail: v.detail,
    });
  }
  const order = { S: 0, A: 1, B: 2 };
  results.sort((a, b) => (order[a.tier] - order[b.tier]) || (b.edge - a.edge));
  return {
    league: "NFL",
    total_analyzed: tasks.length,
    total_s_a: results.length,
    tier_counts: tierCounts,
    top_10: results.slice(0, 10),
    skipped: skipped.length ? skipped : undefined,
    calibration_pending: true,
  };
}
