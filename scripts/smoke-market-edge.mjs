// Unit smoke for rule-market-edge (no network; injects a synthetic market).
//   node scripts/smoke-market-edge.mjs
import { apply } from "../api/_lib/rules/rule-market-edge.js";
import { setOdds } from "../api/_lib/odds.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };
const ctx = (player, stat, direction, line, league) => ({ groundTruth: { player, info: { full_name: player }, league }, statType: stat, direction, line });
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

// E) line shift: PP line 1pt below book → fair P(over) rises (within reliability cap)
setOne({ stat: "Points", line: 16.5, fair_over: 0.50 });
r = apply(ctx("Test Player", "Points", "OVER", 15.5));
ok(r.fired && r._market.fair_at_line > 0.54 && r._market.line_delta === -1, `E shift raises fair (got ${r._market?.fair_at_line})`);

// F) no matching market → no-op (NBA today / unmatched names)
setOdds({ source: "draftkings", by_player: {}, games: {} });
r = apply(ctx("Nobody", "Points", "OVER", 16.5));
ok(r.fired === false, "F no market → fired:false");

// Stage 5 — per-league market tuning. Set a league-tagged single-book entry.
const setLeagueOne = (league, fair_over, line = 16.5) =>
  setOdds({ source: "dk", league, by_player: { "Test Player": [{ stat: "Points", league, line, over_american: -110, under_american: -110, fair_over, sources: [{ book: "dk", line, over_american: -110, under_american: -110, fair_over }] }] }, games: {} });

// G) looser WNBA signal threshold: pDir 0.55 signals in WNBA (sig1 0.54), not NBA (0.56)
setLeagueOne("WNBA", 0.55);
const wSig = apply(ctx("Test Player", "Points", "OVER", 16.5, "WNBA")).signals_added;
setLeagueOne("NBA", 0.55);
const nSig = apply(ctx("Test Player", "Points", "OVER", 16.5, "NBA")).signals_added;
ok(wSig >= 1 && nSig === 0, `G WNBA acts on a 0.55 edge (WNBA ${wSig} sig, NBA ${nSig})`);

// H) WNBA tolerates a larger line gap: a 2pt shift off an 18.5 book line is
// priced in WNBA (shift ≈0.114 ≤ 0.12 cap) but discarded in NBA (≈0.094 > 0.08)
setLeagueOne("WNBA", 0.50, 18.5);
const wPriced = apply(ctx("Test Player", "Points", "OVER", 16.5, "WNBA")).fired;
setLeagueOne("NBA", 0.50, 18.5);
const nPriced = apply(ctx("Test Player", "Points", "OVER", 16.5, "NBA")).fired;
ok(wPriced && !nPriced, `H WNBA prices a 2pt gap, NBA discards it (WNBA ${wPriced}, NBA ${nPriced})`);

setOdds(null);
console.log(`\nsmoke-market-edge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
