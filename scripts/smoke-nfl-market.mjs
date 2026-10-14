// Smoke for NFL sportsbook parsing (api/_lib/nfl/market.js) and the per-book
// combine in scripts/scrape-nfl-odds.mjs, on payloads shaped like the live
// DraftKings / FanDuel responses (verified 2026-10-13).

import { teamAbbr, dkEvents, dkGameLines, parseDkOU, parseDkTd, parseFdOU, parseFdTd, fdEvent, FD_OU } from "../api/_lib/nfl/market.js";
import { combineQuotes } from "./scrape-nfl-odds.mjs";

let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`); };
const near = (a, b, t = 1e-3) => Number.isFinite(a) && Math.abs(a - b) <= t;

check("teamAbbr: nickname decides (LA / NY ambiguity)", teamAbbr("LA Rams") === "LA" && teamAbbr("Los Angeles Chargers") === "LAC" && teamAbbr("NY Jets") === "NYJ" && teamAbbr("New York Giants") === "NYG");
check("teamAbbr: 49ers + unknown", teamAbbr("San Francisco 49ers") === "SF" && teamAbbr("Springfield Atoms") === null);

const base = {
  events: [{ id: "e1", startEventDate: "2026-10-16T00:15:00Z", participants: [{ name: "SEA Seahawks", venueRole: "Away" }, { name: "DEN Broncos", venueRole: "Home" }] }],
  markets: [{ id: "m1", eventId: "e1", marketType: { name: "Total" } }, { id: "m2", eventId: "e1", marketType: { name: "Spread" } }],
  selections: [
    { marketId: "m1", label: "Over", points: 40.5 }, { marketId: "m1", label: "Under", points: 40.5 },
    { marketId: "m2", label: "DEN Broncos", points: 2.5, participants: [{ name: "DEN Broncos" }] }, { marketId: "m2", label: "SEA Seahawks", points: -2.5, participants: [{ name: "SEA Seahawks" }] },
  ],
};
const ev = dkEvents(base);
check("DK events → nflverse abbrs + game key", ev.e1.home === "DEN" && ev.e1.away === "SEA" && ev.e1.game === "SEA@DEN");
const gl = dkGameLines(base, ev);
check("DK game lines: total + home spread", gl["SEA@DEN"].total === 40.5 && gl["SEA@DEN"].home_spread === 2.5);

const ou = parseDkOU({
  markets: [{ id: "p1", eventId: "e1" }, { id: "p2", eventId: "e1" }, { id: "p3", eventId: "e1" }],
  selections: [
    { marketId: "p1", label: "Over", points: 220.5, displayOdds: { american: "−112" }, participants: [{ name: "Sam Darnold", venueRole: "AwayPlayer" }] },
    { marketId: "p1", label: "Under", points: 220.5, displayOdds: { american: "−112" }, participants: [{ name: "Sam Darnold", venueRole: "AwayPlayer" }] },
    { marketId: "p2", label: "Over", points: 6.5, displayOdds: { american: "−124" }, participants: [{ name: "Jaxon Smith-Njigba", venueRole: "AwayPlayer" }] },
    { marketId: "p3", label: "Over", points: 4.5, displayOdds: { american: "+100" }, participants: [{ name: "One Sided", venueRole: "HomePlayer" }] },
  ],
}, "pass_yds", ev);
check("DK O/U: two-sided only (one-sided markets dropped)", ou.length === 1);
check("DK O/U: unicode minus parsed, de-vigged to 50%", ou[0].over_american === -112 && near(ou[0].fair_over, 0.5) && ou[0].team === "SEA" && ou[0].line === 220.5);

const td = parseDkTd({
  markets: [{ id: "t1", eventId: "e1", name: "Anytime TD Scorer" }, { id: "t2", eventId: "e1", name: "First TD Scorer" }],
  selections: [
    { marketId: "t1", label: "Jaxon Smith-Njigba", displayOdds: { american: "+105" }, participants: [{ name: "Jaxon Smith-Njigba", venueRole: "AwayPlayer" }] },
    { marketId: "t2", label: "Jaxon Smith-Njigba", displayOdds: { american: "+600" }, participants: [{ name: "Jaxon Smith-Njigba", venueRole: "AwayPlayer" }] },
  ],
}, ev);
check("DK TD: anytime only, implied prob from American odds", td.length === 1 && near(td[0].implied, 100 / 205) && td[0].team === "SEA");

const fev = fdEvent({ name: "Seattle Seahawks @ Denver Broncos", openDate: "2026-10-16T00:15:00Z" });
check("FD event name → teams", fev.game === "SEA@DEN" && fev.home === "DEN");
const fd = parseFdOU({ markets: {
  a: { marketName: "Sam Darnold - Passing Yds", runners: [{ runnerName: "Over", handicap: 220.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: -110 } } }, { runnerName: "Under", handicap: 220.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: -110 } } }] },
  b: { marketName: "Sam Darnold - Alt Passing Yds", runners: [{ runnerName: "Over", handicap: 250.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: 200 } } }, { runnerName: "Under", handicap: 250.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: -260 } } }] },
  c: { marketName: "Kenneth Walker III - Rushing + Receiving Yds", runners: [{ runnerName: "Over", handicap: 70.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: -115 } } }, { runnerName: "Under", handicap: 70.5, winRunnerOdds: { americanDisplayOdds: { americanOdds: -105 } } }] },
} }, FD_OU, fev);
check("FD O/U: exact full-game markets, alt ladder excluded", fd.length === 2 && fd.every((q) => !/Alt/.test(q.player)));
check("FD O/U: player + stat parsed from the market name", fd.some((q) => q.player === "Kenneth Walker III" && q.stat === "rush_rec_yds" && q.line === 70.5));
const ftd = parseFdTd({ markets: { x: { marketName: "Any Time Touchdown Scorer", runners: [{ runnerName: "Jaxon Smith-Njigba", winRunnerOdds: { americanDisplayOdds: { americanOdds: 110 } } }] }, y: { marketName: "Anytime 4th Quarter TD Scorer", runners: [{ runnerName: "X", winRunnerOdds: { americanDisplayOdds: { americanOdds: 900 } } }] } } }, fev);
check("FD TD: full-game anytime market only", ftd.length === 1 && ftd[0].american === 110);

const { by_player, anytime_td } = combineQuotes([...ou, ...fd, { ...fd[0], book: "fanduel", line: 222.5, fair_over: 0.47 }].filter((q, i, a) => a.indexOf(q) === i), [...td, ...ftd]);
const dar = by_player["Sam Darnold"].find((r) => r.stat === "pass_yds");
check("combine: consensus over books on DraftKings' line", dar.line === 220.5 && dar.books === 2 && near(dar.fair_over, 0.5));
check("combine: off-line book kept in quotes, out of consensus", dar.quotes.some((q) => q.line === 222.5));
check("combine: team comes from DraftKings; a FanDuel-only player stays null", by_player["Kenneth Walker III"][0].team === null && dar.team === "SEA");
check("combine: anytime TD grouped per player across books", anytime_td["Jaxon Smith-Njigba"].length === 2 && anytime_td["Jaxon Smith-Njigba"].every((q) => q.team === "SEA"));

console.log(`\nsmoke-nfl-market: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
