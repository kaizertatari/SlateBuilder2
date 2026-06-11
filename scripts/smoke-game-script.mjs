// Smoke for rule-game-script (Stage 2 Vegas game-script). No network.
//   node scripts/smoke-game-script.mjs
import { apply } from "../api/_lib/rules/rule-game-script.js";
import { setOdds } from "../api/_lib/odds.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

const ctxFor = ({ player = "P", statType = "Points", direction = "OVER", league = "NBA" } = {}) =>
  ({ groundTruth: { info: { full_name: player }, player, league }, statType, direction, line: 25.5 });

// Load one game + a DK-tagged entry (team + game key) so lookupVegas resolves.
function loadGame({ player = "P", league = "NBA", team = "BBB", game = "AAA@BBB", home = "BBB", away = "AAA", game_total, home_spread, away_spread }) {
  setOdds({
    games: { [game]: { home, away, game_total, home_spread, away_spread } },
    by_player: { [player]: [{ stat: "Points", league, team, game, line: 25.5, fair_over: 0.5, sources: [{ book: "dk", line: 25.5, fair_over: 0.5 }] }] },
  });
}

// A) high team total → OVER tailwind (signal, +confidence), no blowout
loadGame({ game_total: 240, home_spread: -2, away_spread: 2 });
{
  const a = apply(ctxFor({ direction: "OVER" }));
  ok(a.fired && a.signals_added >= 1 && !a.suppressor && a.confidence_delta > 0, "A: high team total → OVER tailwind");
  ok(a._vegas && a._vegas.team_total === 121, `A: team_total 121 (got ${a._vegas?.team_total})`);
}

// B) low team total → OVER headwind (suppressor, −confidence)
loadGame({ game_total: 200, home_spread: -2, away_spread: 2 });
{
  const b = apply(ctxFor({ direction: "OVER" }));
  ok(b.fired && b.suppressor && b.signals_added === 0 && b.confidence_delta < 0, "B: low team total → OVER headwind (suppressor)");
}

// C/D) blowout with a neutral total (team_total == ref, isolates the spread)
loadGame({ game_total: 213, home_spread: -15, away_spread: 15 });
{
  const c = apply(ctxFor({ direction: "OVER" }));
  ok(c.fired && c.suppressor && c._vegas.blowout === true, "C: blowout → OVER suppressor");
  ok(Math.abs(c._vegas.team_total - 114) < 0.01, `C: neutral team_total 114 isolates blowout (got ${c._vegas?.team_total})`);
  const d = apply(ctxFor({ direction: "UNDER" }));
  ok(d.fired && !d.suppressor && d.signals_added >= 1 && d.confidence_delta > 0, "D: blowout → UNDER tailwind");
}

// E) neutral total + no blowout → no fire, but _vegas still surfaced
loadGame({ game_total: 228, home_spread: 0, away_spread: 0 });
{
  const e = apply(ctxFor({ direction: "OVER" }));
  ok(!e.fired && e._vegas && Math.abs(e._vegas.team_total - 114) < 0.01, "E: neutral total + no blowout → no fire, _vegas present");
}

// F) non-counting stat → no fire, no lookup (returns before lookupVegas)
loadGame({ game_total: 240, home_spread: -2, away_spread: 2 });
{
  const f = apply(ctxFor({ statType: "Blocks", direction: "OVER" }));
  ok(!f.fired && !f._vegas, "F: non-counting stat → no fire, no lookup");
}

// G) no odds coverage → no fire
setOdds({ games: {}, by_player: {} });
{
  const g = apply(ctxFor({ player: "Nobody", direction: "OVER" }));
  ok(!g.fired, "G: no odds coverage → no fire");
}

// H) WNBA: team_total 88 is a tailwind off the WNBA ref (83) — would be a
// headwind off the NBA ref (114). Proves the per-league reference is applied.
loadGame({ player: "W", league: "WNBA", game_total: 176, home_spread: 0, away_spread: 0 });
{
  const h = apply(ctxFor({ player: "W", league: "WNBA", direction: "OVER" }));
  ok(h.fired && !h.suppressor && h.signals_added >= 1, "H: WNBA team total 88 uses WNBA ref → OVER tailwind");
  ok(h._vegas.team_total === 88, `H: team_total 88 (got ${h._vegas?.team_total})`);
}

setOdds(null);
console.log(`\nsmoke-game-script: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
