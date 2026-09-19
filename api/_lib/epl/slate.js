// EPL slate candidates for /api/build-slate: every board line priced by the
// EPL verdict engine, best side per line, non-SKIP only. Each candidate
// carries the blended probability as an explicit `prob`, which buildSlate
// prefers over any calibration lookup.

import { mapPrizePicksStatType } from "../prop-types.js";
import { getEplContext, readEplLines } from "./store.js";
import { eplVerdict } from "./verdict.js";

/**
 * @param {Object} f
 * @param {Set<string>|null} f.allowedStats   canonical EPL stat names
 * @param {string[]|null} f.oddsTypes         default ["standard"]
 * @param {string[]|null} f.games             "<opponent>@<team>" keys (UI)
 * @param {"OVER"|"UNDER"|null} f.direction
 */
export async function collectEplCandidates({ allowedStats = null, oddsTypes = ["standard"], games = null, direction = null } = {}) {
  const [lines, ctx] = await Promise.all([readEplLines(), getEplContext()]);
  const oddsSet = new Set(oddsTypes && oddsTypes.length ? oddsTypes : ["standard"]);
  const gameSet = Array.isArray(games) && games.length ? new Set(games) : null;
  const candidates = [];
  const verdicts = [];
  let considered = 0;
  for (const [player, props] of Object.entries(lines.by_player || {})) {
    for (const p of props) {
      const ot = (p.odds_type || "standard").toLowerCase();
      if (!oddsSet.has(ot)) continue;
      const stat = mapPrizePicksStatType(p.stat_type);
      if (!stat || (allowedStats && !allowedStats.has(stat))) continue;
      const game = `${p.opponent || "?"}@${p.player_team || "?"}`;
      if (gameSet && !gameSet.has(game)) continue;
      considered++;
      const dirs = direction ? [direction] : ot === "standard" ? ["OVER", "UNDER"] : ["OVER"];
      const best = dirs
        .map((d) => eplVerdict(p, d, ctx))
        .filter((v) => v.tier !== "SKIP")
        .sort((a, b) => b.edge - a.edge)[0];
      if (!best) continue;
      verdicts.push(best);
      candidates.push({
        player,
        league: "EPL",
        stat_type: stat,
        direction: best.direction,
        line: p.line,
        odds_type: ot,
        prob: best.prob,
        confidence: best.confidence,
        tier: best.tier,
        verdict: best.verdict,
        edge: best.edge,
        break_even: best.break_even,
        game,
        match: best.game,
        game_start_time: p.start_time ?? null,
        justification: best.justification,
        flags: best.flags,
      });
    }
  }
  return {
    candidates,
    verdicts,
    considered,
    lines_fetched_at: lines.fetched_at ?? null,
    odds_fetched_at: ctx.odds?.fetched_at ?? null,
    odds_sources: ctx.odds?.sources ?? null,
  };
}
