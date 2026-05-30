// Unit smoke for rule-market-edge (no network; injects a synthetic market).
//   node scripts/smoke-market-edge.mjs
import { apply } from "../api/lib/rules/rule-market-edge.js";
import { setOdds } from "../api/lib/odds.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };
const ctx = (player, stat, direction, line) => ({ groundTruth: { player, info: { full_name: player } }, statType: stat, direction, line });
const setOne = ({ player = "Test Player", stat = "Points", line = 16.5, fair_over }) =>
  setOdds({ source: "draftkings", league: "WNBA", by_player: { [player]: [{ stat, line, over_american: -110, under_american: -110, fair_over }] }, games: {} });

// A) market supports the OVER → signals + positive confidence, no skip
setOne({ fair_over: 0.62 });
let r = apply(ctx("Test Player", "Points", "OVER", 16.5));
ok(r.fired && !r.hard_skip && r.signals_added === 2 && r.confidence_delta > 0, "A support → 2 signals, +conf");
ok(r._market && Math.abs(r._market.fair_at_line - 0.62) < 0.001, "A fair_at_line = 0.62");

// B) market strongly disagrees with the OVER → SKIP
setOne({ fair_over: 0.35 });
r = apply(ctx("Test Player", "Points", "OVER", 16.5));
ok(r.fired && r.hard_skip && r.tier_cap === "SKIP", "B strong disagree → SKIP");

// C) mild disagreement → suppressor, cap A
setOne({ fair_over: 0.45 });
r = apply(ctx("Test Player", "Points", "OVER", 16.5));
ok(r.fired && r.suppressor && r.tier_cap === "A" && !r.hard_skip, "C mild disagree → cap A");

// D) UNDER bet, low over-fair → high under-fair → supported
setOne({ fair_over: 0.35 });
r = apply(ctx("Test Player", "Points", "UNDER", 16.5));
ok(r.fired && r.signals_added === 2 && !r.hard_skip, "D under supported when over-fair low");

// E) line shift: PP line 2pts below book → fair P(over) rises
setOne({ stat: "Points", line: 17.5, fair_over: 0.50 });
r = apply(ctx("Test Player", "Points", "OVER", 15.5));
ok(r.fired && r._market.fair_at_line > 0.60 && r._market.line_delta === -2, `E shift raises fair (got ${r._market?.fair_at_line})`);

// F) no matching market → no-op (NBA today / unmatched names)
setOdds({ source: "draftkings", by_player: {}, games: {} });
r = apply(ctx("Nobody", "Points", "OVER", 16.5));
ok(r.fired === false, "F no market → fired:false");

setOdds(null);
console.log(`\nsmoke-market-edge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
