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

function wcProp(overrides = {}) {
  return {
    player: "Kylian Mbappé",
    league: "WC",
    stat_type: "Shots",
    line: 2.5,
    odds_type: "standard",
    player_team: "FRA",
    opponent: "BRA",
    start_time: FUTURE,
    player_key: "Kylian Mbappé",
    ...overrides,
  };
}

const previous = {
  fetched_at: "2026-06-12T02:34:38.940Z",
  games: {
    "WC:BRA@FRA": {
      league: "WC",
      home: "FRA",
      away: "BRA",
      props: [
        wcProp(),
        wcProp({ stat_type: "Shots On Target", line: 1.5 }),
        // Unmatched player — no player_key, falls back to raw name.
        wcProp({ player: "Unknown Striker", player_key: null }),
        // Tipped game-leg: started in the past, must be dropped.
        wcProp({ player: "Early Bird", start_time: PAST }),
      ],
    },
    // Whole game in the past — must vanish from the salvage.
    "WC:GER@ESP": {
      league: "WC",
      home: "ESP",
      away: "GER",
      props: [wcProp({ player: "Stale Player", player_team: "ESP", opponent: "GER", start_time: PAST })],
    },
    // Different league — never salvaged when asking for WC.
    "NYK@SAS": {
      league: "NBA",
      home: "SAS",
      away: "NYK",
      props: [wcProp({ league: "NBA", player: "Some Guard", start_time: FUTURE })],
    },
  },
};

console.log("=== smoke-scrape-salvage ===\n");

const wc = salvageLeagueFromSnapshot(previous, "WC", NOW);

assert("salvages the upcoming WC props", wc.count === 3, `count=${wc.count}`);
assert("keeps only the live game", Object.keys(wc.games).join(",") === "WC:BRA@FRA",
  Object.keys(wc.games).join(","));
assert("drops the tipped prop inside the live game",
  wc.games["WC:BRA@FRA"]?.props.length === 3,
  `props=${wc.games["WC:BRA@FRA"]?.props.length}`);
assert("does not touch other leagues",
  !Object.keys(wc.games).includes("NYK@SAS") && !("Some Guard" in wc.byPlayer));
assert("by_player keyed on player_key", Array.isArray(wc.byPlayer["Kylian Mbappé"])
  && wc.byPlayer["Kylian Mbappé"].length === 2,
  JSON.stringify(Object.keys(wc.byPlayer)));
assert("unmatched player falls back to raw name", wc.byPlayer["Unknown Striker"]?.length === 1);
assert("salvaged game entry preserves metadata",
  wc.games["WC:BRA@FRA"]?.home === "FRA" && wc.games["WC:BRA@FRA"]?.league === "WC");

const nba = salvageLeagueFromSnapshot(previous, "NBA", NOW);
assert("NBA salvage picks up only NBA", nba.count === 1 && "NYK@SAS" in nba.games,
  `count=${nba.count}`);

assert("null snapshot salvages nothing", salvageLeagueFromSnapshot(null, "WC", NOW).count === 0);
assert("empty snapshot salvages nothing", salvageLeagueFromSnapshot({}, "WC", NOW).count === 0);
assert("league absent from snapshot salvages nothing",
  salvageLeagueFromSnapshot(previous, "WNBA", NOW).count === 0);

console.log(`\nsmoke-scrape-salvage: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
