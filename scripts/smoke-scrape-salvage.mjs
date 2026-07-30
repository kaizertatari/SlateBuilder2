// Unit smoke for the league-salvage guard in scrape-prizepicks.mjs.
//
// Covers:
//   • Salvage extracts only the requested league from a previous snapshot
//   • Props whose game already started are dropped
//   • Games left with zero upcoming props are dropped entirely
//   • by_player keys use player_key, falling back to raw player name
//   • Empty / null / league-less snapshots salvage nothing
//
// Pure local — no network. The partial-vs-total failure gating lives in
// scrapePrizePicksForToday (salvage only runs when at least one league
// succeeded) and is asserted here against the helper's contract.

import { salvageLeagueFromSnapshot } from "./scrape-prizepicks.mjs";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS — ${name}`);
    passed++;
  } else {
    console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`);
    failed++;
  }
}

const NOW = Date.parse("2026-06-12T12:00:00Z");
const FUTURE = "2026-06-12T18:00:00Z";
const PAST = "2026-06-12T06:00:00Z";

function wnbaProp(overrides = {}) {
  return {
    player: "A'ja Wilson",
    league: "WNBA",
    stat_type: "Points",
    line: 22.5,
    odds_type: "standard",
    player_team: "LVA",
    opponent: "NYL",
    start_time: FUTURE,
    player_key: "A'ja Wilson",
    ...overrides,
  };
}

const previous = {
  fetched_at: "2026-06-12T02:34:38.940Z",
  games: {
    "WNBA:NYL@LVA": {
      league: "WNBA",
      home: "LVA",
      away: "NYL",
      props: [
        wnbaProp(),
        wnbaProp({ stat_type: "Rebounds", line: 9.5 }),
        // Unmatched player — no player_key, falls back to raw name.
        wnbaProp({ player: "Unknown Rookie", player_key: null }),
        // Tipped game-leg: started in the past, must be dropped.
        wnbaProp({ player: "Early Bird", start_time: PAST }),
      ],
    },
    // Whole game in the past — must vanish from the salvage.
    "WNBA:CHI@CON": {
      league: "WNBA",
      home: "CON",
      away: "CHI",
      props: [wnbaProp({ player: "Stale Player", player_team: "CON", opponent: "CHI", start_time: PAST })],
    },
    // Different league — never salvaged when asking for WNBA.
    "NYK@SAS": {
      league: "NBA",
      home: "SAS",
      away: "NYK",
      props: [wnbaProp({ league: "NBA", player: "Some Guard", start_time: FUTURE })],
    },
  },
};

console.log("=== smoke-scrape-salvage ===\n");

const wnba = salvageLeagueFromSnapshot(previous, "WNBA", NOW);

assert("salvages the upcoming WNBA props", wnba.count === 3, `count=${wnba.count}`);
assert("keeps only the live game", Object.keys(wnba.games).join(",") === "WNBA:NYL@LVA",
  Object.keys(wnba.games).join(","));
assert("drops the tipped prop inside the live game",
  wnba.games["WNBA:NYL@LVA"]?.props.length === 3,
  `props=${wnba.games["WNBA:NYL@LVA"]?.props.length}`);
assert("does not touch other leagues",
  !Object.keys(wnba.games).includes("NYK@SAS") && !("Some Guard" in wnba.byPlayer));
assert("by_player keyed on player_key", Array.isArray(wnba.byPlayer["A'ja Wilson"])
  && wnba.byPlayer["A'ja Wilson"].length === 2,
  JSON.stringify(Object.keys(wnba.byPlayer)));
assert("unmatched player falls back to raw name", wnba.byPlayer["Unknown Rookie"]?.length === 1);
assert("salvaged game entry preserves metadata",
  wnba.games["WNBA:NYL@LVA"]?.home === "LVA" && wnba.games["WNBA:NYL@LVA"]?.league === "WNBA");

const nba = salvageLeagueFromSnapshot(previous, "NBA", NOW);
assert("NBA salvage picks up only NBA", nba.count === 1 && "NYK@SAS" in nba.games,
  `count=${nba.count}`);

assert("null snapshot salvages nothing", salvageLeagueFromSnapshot(null, "WNBA", NOW).count === 0);
assert("empty snapshot salvages nothing", salvageLeagueFromSnapshot({}, "WNBA", NOW).count === 0);
assert("league absent from snapshot salvages nothing",
  salvageLeagueFromSnapshot(previous, "MLB", NOW).count === 0);

console.log(`\nsmoke-scrape-salvage: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
