// Smoke for /api/build-slate candidate pricing + assembly. No network.
//   node scripts/smoke-build-slate.mjs
import { collectMarketCandidates } from "../api/build-slate.js";
import { buildSlate } from "../api/lib/slate-builder.js";
import { setOdds } from "../api/lib/odds.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

const ppProp = (player_team, opponent, fair_over, line = 15.5) => ({ player_team, opponent, fair_over, line });
function scenario(fairs) {
  // odds: flat per-player Points entry (lookupMarket back-compat = 1 source)
  const odds = { source: "dk+fd", fetched_at: "t", by_player: {}, games: {} };
  const lines = { fetched_at: "t", by_player: {} };
  const teams = [["AAA", "BBB"], ["CCC", "DDD"], ["EEE", "FFF"], ["GGG", "HHH"]];
  Object.entries(fairs).forEach(([name, fo], i) => {
    odds.by_player[name] = [{ stat: "Points", line: 15.5, over_american: -110, under_american: -110, fair_over: fo }];
    lines.by_player[name] = [{ stat_type: "Points", line: 15.5, odds_type: "standard", league: "WNBA", player_team: teams[i][0], opponent: teams[i][1] }];
  });
  setOdds(odds);
  return lines;
}

// A) pricing: 4 props priced, direction follows the market-favored side
{
  const lines = scenario({ Alice: 0.80, Bob: 0.80, Cara: 0.80, Dan: 0.40 });
  const { candidates, matchedMarket, considered } = collectMarketCandidates(lines, { league: "WNBA", allowedStats: new Set(["Points"]) });
  ok(considered === 4 && matchedMarket === 4, `A: 4 considered/matched (got ${considered}/${matchedMarket})`);
  const dan = candidates.find((c) => c.player === "Dan");
  ok(dan && dan.direction === "UNDER" && Math.abs(dan.market_fair_at_line - 0.60) < 0.001, "A: Dan fair_over 0.40 → UNDER @ 0.60");
  const alice = candidates.find((c) => c.player === "Alice");
  ok(alice && alice.direction === "OVER" && alice.market_fair_at_line === 0.80, "A: Alice → OVER @ 0.80");
}

// B) assembly: three 0.80 legs (distinct games) → +EV slate at ≥3×
{
  const lines = scenario({ Alice: 0.80, Bob: 0.80, Cara: 0.80, Dan: 0.40 });
  const { candidates } = collectMarketCandidates(lines, { league: "WNBA", allowedStats: new Set(["Points"]) });
  const r = buildSlate(candidates, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(!r.abstained, "B: builds a slate");
  ok(r.slate && r.slate.legs.length === 3 && r.slate.legs.every((l) => l.prob_source === "market"), "B: 3 legs, all market-priced");
  ok(r.slate && !r.slate.legs.some((l) => l.player === "Dan"), "B: excludes the market-dog (Dan)");
}

// C) abstain: market says coin flips → no +EV slate at ≥3×
{
  const lines = scenario({ Alice: 0.48, Bob: 0.48, Cara: 0.48, Dan: 0.48 });
  const { candidates } = collectMarketCandidates(lines, { league: "WNBA", allowedStats: new Set(["Points"]) });
  const r = buildSlate(candidates, { targetMultiplier: 3, mode: "power", size: 3 });
  ok(r.abstained, "C: ~coin-flip market → abstain at ≥3×");
}

// D) league filter excludes NBA props
{
  const lines = scenario({ Alice: 0.80 });
  lines.by_player.NBAGuy = [{ stat_type: "Points", line: 15.5, odds_type: "standard", league: "NBA", player_team: "ZZZ", opponent: "YYY" }];
  const { considered } = collectMarketCandidates(lines, { league: "WNBA", allowedStats: new Set(["Points"]) });
  ok(considered === 1, `D: NBA prop excluded by league filter (got ${considered})`);
}

setOdds(null);
console.log(`\nsmoke-build-slate: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
