// EPL counterpart of /api/analyze-all's per-player loop: same line selection
// (select-lines.js), same response shape — so the UI renders EPL verdicts
// exactly like basketball ones — but priced by the EPL verdict engine.

import { selectLinesForStat } from "../select-lines.js";
import { mapPrizePicksStatType } from "../prop-types.js";
import { logEplVerdicts } from "../verdict-logger.js";
import { getEplContext } from "./store.js";
import { eplVerdict } from "./verdict.js";

/**
 * @param {Object} a
 * @param {string} a.player           lines-snapshot by_player key
 * @param {Array<Object>} a.props     that player's EPL props
 * @param {Set<string>|null} a.allowedStats  canonical stat names, null = all
 * @param {Array<"OVER"|"UNDER">} a.directions
 * @param {string[]|null} a.oddsTypes
 * @param {number} [a.maxLines=60]
 * @param {Object} [a.ctx]            prebuilt context (tests / batch callers)
 */
export async function analyzeEplPlayer({ player, props, allowedStats = null, directions = ["OVER", "UNDER"], oddsTypes = null, maxLines = 60, ctx = null, source = "analyze-all" }) {
  const buckets = new Map();
  for (const p of props) {
    const stat = mapPrizePicksStatType(p.stat_type);
    if (!stat || (allowedStats && !allowedStats.has(stat))) continue;
    if (!buckets.has(stat)) buckets.set(stat, []);
    buckets.get(stat).push(p);
  }
  const tasks = [];
  for (const [stat, bucket] of buckets) {
    for (const dir of directions) {
      for (const chosen of selectLinesForStat(bucket, dir, oddsTypes)) {
        if (tasks.length >= maxLines) break;
        tasks.push({ stat, dir, prop: chosen });
      }
    }
  }
  if (!tasks.length) {
    return { total_analyzed: 0, total_s_a: 0, tier_counts: { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 }, top_10: [], message: "No matching lines found for the given filters." };
  }

  const context = ctx ?? (await getEplContext());
  const verdicts = tasks.map((t) => ({ task: t, v: eplVerdict(t.prop, t.dir, context) }));
  logEplVerdicts(verdicts.map((x) => x.v), { source });

  const tierCounts = { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 };
  const skipped = [];
  const results = [];
  for (const { task, v } of verdicts) {
    tierCounts[v.tier] = (tierCounts[v.tier] ?? 0) + 1;
    if (v.pre_filtered && v.skip_reason !== "over_only_line") skipped.push({ stat: task.stat, line: task.prop.line, reason: v.skip_reason });
    if (v.tier === "SKIP") continue;
    results.push({
      player,
      league: "EPL",
      game: v.game,
      prop_type: task.stat,
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
  const lineupStates = [...new Set(verdicts.map((x) => x.v.detail?.lineup).filter(Boolean))];
  return {
    league: "EPL",
    total_analyzed: tasks.length,
    total_s_a: results.length,
    tier_counts: tierCounts,
    top_10: results.slice(0, 10),
    skipped: skipped.length ? skipped : undefined,
    lineup_states: lineupStates,
    calibration_pending: true,
  };
}
