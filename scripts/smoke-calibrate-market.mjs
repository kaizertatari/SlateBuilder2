// Smoke for the market-reliability math (no network).
//   node scripts/smoke-calibrate-market.mjs
import { marketReliability, DEFAULT_BINS, edgeByLineDelta, favorableDelta } from "./calibrate-market.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

const row = (p, hit, league = "WNBA", odds_type = "standard") => ({
  market_fair_at_line: p, hit_or_miss: hit ? "hit" : "miss", league, odds_type,
});

// A) perfectly-calibrated input: predicted 0.70, and 7/10 hit → gap ≈ 0
{
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row(0.70, i < 7));
  const rel = marketReliability(rows);
  ok(rel.n === 10, `A: counts all rows (got ${rel.n})`);
  ok(approx(rel.pred_avg, 0.70), `A: pred_avg ~0.70 (got ${rel.pred_avg})`);
  ok(approx(rel.actual_hit, 0.70), `A: actual_hit ~0.70 (got ${rel.actual_hit})`);
  const b = rel.bins.find((x) => x.lo === 0.70); // 0.70 lands in [0.70, 0.75)
  ok(b && approx(b.gap, 0, 0.02), `A: 0.70-0.75 bin gap ~0 (got ${b?.gap})`);
}

// B) optimistic market: predicted 0.80, only 5/10 hit → negative gap (discount)
{
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row(0.80, i < 5));
  const rel = marketReliability(rows);
  ok(rel.actual_hit < rel.pred_avg - 0.1, `B: actual well below predicted (pred ${rel.pred_avg}, actual ${rel.actual_hit})`);
  const b = rel.bins.find((x) => x.lo === 0.8);
  ok(b && b.gap < 0, `B: 0.80-0.90 bin has negative gap (got ${b?.gap})`);
}

// C) Brier sanity: a confident-and-correct set scores lower (better) than a
// confident-and-wrong set.
{
  const good = marketReliability([row(0.9, true), row(0.9, true), row(0.1, false)]);
  const bad = marketReliability([row(0.9, false), row(0.9, false), row(0.1, true)]);
  ok(good.brier < bad.brier, `C: good Brier (${good.brier}) < bad Brier (${bad.brier})`);
}

// D) slices: by_league / by_odds_type partition the sample
{
  const rows = [row(0.7, true, "NBA", "standard"), row(0.6, false, "WNBA", "goblin"), row(0.65, true, "WNBA", "standard")];
  const rel = marketReliability(rows);
  ok(rel.by_league.NBA?.n === 1 && rel.by_league.WNBA?.n === 2, "D: by_league partitions");
  ok(rel.by_odds_type.standard?.n === 2 && rel.by_odds_type.goblin?.n === 1, "D: by_odds_type partitions");
}

// E) ignores rows without a market prob or without a settled outcome
{
  const rows = [row(0.7, true), { hit_or_miss: "hit" }, { market_fair_at_line: 0.7, hit_or_miss: "void" }];
  const rel = marketReliability(rows);
  ok(rel.n === 1, `E: drops no-prob and unsettled rows (got ${rel.n})`);
}

// F) empty input is safe
{
  const rel = marketReliability([]);
  ok(rel.n === 0 && rel.brier === null && rel.bins.length === 0, "F: empty input → zeros, no throw");
}

// G) bin edges cover [0,1] (a 0.0 and a 1.0 prob both land in a bin)
{
  ok(DEFAULT_BINS[0][0] === 0 && DEFAULT_BINS[DEFAULT_BINS.length - 1][1] > 1, "G: bins span 0..>1");
  const rel = marketReliability([row(0.999, true), row(0.0, false)]);
  ok(rel.n === 2 && rel.bins.length === 2, `G: extreme probs each fall in a bin (got ${rel.bins.length} bins)`);
}

// H) favorableDelta is direction-adjusted (lower line favors OVER, higher favors UNDER)
{
  ok(favorableDelta({ market_line_delta: -1, verdict: "OVER" }) === 1, "H: OVER, pp 1 below book → favorable +1");
  ok(favorableDelta({ market_line_delta: 1, verdict: "UNDER" }) === 1, "H: UNDER, pp 1 above book → favorable +1");
  ok(favorableDelta({ market_line_delta: 1, verdict: "OVER" }) === -1, "H: OVER, pp 1 above book → unfavorable -1");
  ok(favorableDelta({ verdict: "OVER" }) === null, "H: missing delta → null");
  ok(favorableDelta({ market_line_delta: 1, verdict: "SKIP" }) === null, "H: non-directional → null");
}

// edge-row helper (carries a line delta + direction)
const erow = (p, hit, delta, dir = "OVER") => ({
  market_fair_at_line: p, market_line_delta: delta, verdict: dir,
  hit_or_miss: hit ? "hit" : "miss",
});

// I) by_favorable: a favorable bucket where actual beats the market prob → +gap
{
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(erow(0.55, i < 8, -1, "OVER")); // favorable, under-priced
  for (let i = 0; i < 10; i++) rows.push(erow(0.50, i < 5, 0, "OVER"));  // neutral, calibrated
  const e = edgeByLineDelta(rows);
  const fav = e.by_favorable.find((b) => b.label === "favorable");
  const neu = e.by_favorable.find((b) => b.label === "neutral");
  ok(fav?.n === 10 && fav.gap > 0.2, `I: favorable bucket shows large +gap (got ${fav?.gap})`);
  ok(neu?.n === 10 && approx(neu.gap, 0, 0.02), `I: neutral bucket ~calibrated (got ${neu?.gap})`);
}

// J) by_magnitude partitions on |delta| and drops rows missing a delta
{
  const rows = [
    erow(0.6, true, 0),     // exact
    erow(0.6, true, 0.5),   // ≤0.5
    erow(0.6, false, 2.5),  // >2
    { market_fair_at_line: 0.6, hit_or_miss: "hit", verdict: "OVER" }, // no delta → dropped
  ];
  const e = edgeByLineDelta(rows);
  ok(e.n === 3, `J: drops the no-delta row (got ${e.n})`);
  const labels = e.by_magnitude.map((b) => b.label);
  ok(labels.includes("exact") && labels.includes("≤0.5") && labels.includes(">2"),
    `J: magnitude buckets present (${labels.join(",")})`);
}

// K) empty input is safe
{
  const e = edgeByLineDelta([]);
  ok(e.n === 0 && e.by_magnitude.length === 0 && e.by_favorable.length === 0, "K: empty input → zeros, no throw");
}

console.log(`\nsmoke-calibrate-market: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
