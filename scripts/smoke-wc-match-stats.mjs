// Unit smoke for the FBref WC match-stats fallback.
//
// Covers:
//   • composeMatchPlayers: table dumps → per-player rows (candidate
//     data-stat names, total-row filtering, team from caption, keeper SV)
//   • completedMatchesFromSchedule: only played fixtures with a report link
//   • indexWcMatchStatsByDate / mergeWcEntry: snapshot join + ESPN overlay
//   • wcActualFor: ESPN-only entry leaves Tackles/Clearances/Passes/fantasy
//     null; the merged entry grades all of them (fantasy all-or-nothing)
//
// Pure local — no network, no Playwright.

import { composeMatchPlayers, completedMatchesFromSchedule, hasAdvancedStats, needsRescrape } from "./refresh-wc-match-stats.mjs";
import { composeFotmobPlayers, parseFotmobCards, finishedMatchesFromLeagues, etDate } from "./refresh-wc-fotmob-stats.mjs";
import { indexWcMatchStatsByDate, mergeWcEntry, wcActualFor, normalizeName, buildSoccerAccrual } from "./_wc-actuals.mjs";

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

// ── composeMatchPlayers ─────────────────────────────────────────────────────

const TABLES = [
  {
    id: "stats_abc123_summary",
    caption: "Mexico Player Stats Table",
    rows: [
      { player: "Édson Álvarez", minutes: "90", shots: "1", shots_on_target: "0", goals: "0", assists: "0", cards_yellow: "1", cards_red: "0", tackles: "4", passes: "58" },
      { player: "Raúl Jiménez", minutes: "78", shots: "3", shots_on_target: "2", goals: "1", assists: "0", cards_yellow: "0", cards_red: "0", tackles: "0", passes: "21" },
      { player: "16 Players", minutes: "990", shots: "12" }, // team total row
    ],
  },
  {
    id: "stats_abc123_passing",
    caption: "Mexico Player Stats Table",
    rows: [
      { player: "Édson Álvarez", passes: "58", assisted_shots: "1" },
      { player: "Raúl Jiménez", passes: "21", assisted_shots: "2" },
    ],
  },
  {
    id: "stats_abc123_defense",
    caption: "Mexico Player Stats Table",
    rows: [
      { player: "Édson Álvarez", tackles: "4", clearances: "3" },
      { player: "Raúl Jiménez", tackles: "0", clearances: "0" },
    ],
  },
  {
    id: "stats_abc123_possession",
    caption: "Mexico Player Stats Table",
    rows: [
      { player: "Édson Álvarez", take_ons: "2" },
      { player: "Raúl Jiménez", dribbles_att: "1" }, // legacy data-stat variant
    ],
  },
  {
    id: "stats_abc123_misc",
    caption: "Mexico Player Stats Table",
    rows: [
      { player: "Édson Álvarez", crosses: "0", fouls: "2", cards_yellow: "1", cards_red: "0" },
      { player: "Raúl Jiménez", crosses: "3", fouls: "1", cards_yellow: "0", cards_red: "0" },
    ],
  },
  {
    id: "keeper_stats_abc123",
    caption: "Mexico Goalkeeper Stats Table",
    rows: [{ player: "Raúl Rangel", minutes: "90", gk_saves: "2" }],
  },
  {
    id: "stats_abc123_pass_types", // excluded family — must not contribute
    caption: "Mexico Player Stats Table",
    rows: [{ player: "Édson Álvarez", passes: "999" }],
  },
];

const players = composeMatchPlayers(TABLES);
const alvarez = players[normalizeName("Édson Álvarez")];
const jimenez = players[normalizeName("Raúl Jiménez")];
const rangel = players[normalizeName("Raúl Rangel")];

assert("players keyed by normalized name", alvarez && jimenez && rangel,
  `keys=${Object.keys(players).join(",")}`);
assert("team total row dropped", !Object.values(players).some((p) => /Players/.test(p.name)));
assert("summary fields parse", alvarez?.min === 90 && alvarez?.sh === 1 && alvarez?.g === 0 && alvarez?.yc === 1);
assert("passing fields parse (pa + kp)", alvarez?.pa === 58 && alvarez?.kp === 1);
assert("pass_types table excluded", alvarez?.pa === 58, `pa=${alvarez?.pa}`);
assert("defense fields parse (tk + clr)", alvarez?.tk === 4 && alvarez?.clr === 3);
assert("possession take_ons → drb", alvarez?.drb === 2);
assert("legacy dribbles_att candidate → drb", jimenez?.drb === 1);
assert("misc fields parse (cr + fc)", jimenez?.cr === 3 && jimenez?.fc === 1);
assert("keeper SV parses", rangel?.sv === 2 && rangel?.min === 90);
assert("team from caption", alvarez?.team === "Mexico" && rangel?.team === "Mexico");

// ── completedMatchesFromSchedule ────────────────────────────────────────────

const sched = completedMatchesFromSchedule([
  { date: "2026-06-11", home_team: "Mexico", away_team: "South Africa", report_href: "/en/matches/aaa/x", report_text: "Match Report" },
  { date: "2026-06-13", home_team: "France", away_team: "Senegal", report_href: "/en/matches/bbb/y", report_text: "Head-to-Head" },
  { date: "", home_team: "", away_team: "", report_href: null, report_text: null }, // spacer row
]);
assert("only completed fixtures kept", sched.length === 1 && sched[0].report === "/en/matches/aaa/x");
assert("schedule date + teams carried", sched[0].date === "2026-06-11" && sched[0].home === "Mexico");

// ── basic-vs-advanced rescrape gate ─────────────────────────────────────────
// Day-after FBref reports are basic-only (no tk/clr/pa); they must stay on
// the rescrape list until the advanced tables land.

const basicMatch = { date: "2026-06-11", players: { x: { name: "X", min: 90, sh: 2, st: 1, cr: 1, fc: 0 } } };
const advancedMatch = { date: "2026-06-11", players: { x: { name: "X", min: 90, sh: 2, tk: 3, clr: 1, pa: 40 } } };
assert("basic-only match flagged", !hasAdvancedStats(basicMatch) && needsRescrape(basicMatch));
assert("advanced match not rescraped", hasAdvancedStats(advancedMatch) && !needsRescrape(advancedMatch));
assert("unscraped match needs scrape", needsRescrape(undefined) && needsRescrape({ date: "2026-06-11" }));

// ── snapshot index + merge ──────────────────────────────────────────────────

const SNAP = {
  fetched_at: "2026-06-12T00:00:00Z",
  total_matches: 2,
  matches: {
    "/en/matches/aaa/x": { date: "2026-06-11", home: "Mexico", away: "South Africa", players },
    "/en/matches/ccc/z": {
      date: "2026-06-11", home: "South Korea", away: "Czechia",
      players: { [normalizeName("Heung-Min Son")]: { name: "Heung-Min Son", team: "South Korea", min: 90, sh: 4, st: 2, g: 1, a: 0, tk: 1, clr: 0, pa: 35, kp: 3, cr: 5, drb: 4, fc: 1, yc: 0, rc: 0 } },
    },
  },
};
const byDate = indexWcMatchStatsByDate(SNAP);
assert("index merges matches on one date", byDate.get("2026-06-11")?.size === 4,
  `size=${byDate.get("2026-06-11")?.size}`);
assert("index empty for null snapshot", indexWcMatchStatsByDate(null).size === 0);

// ESPN entry shape: validated keys only (sh/st/sv/g/a/fc/yc/rc), no tk/clr/pa.
const espnAlvarez = { name: "Édson Álvarez", team: "Mexico", played: true, event_id: "760415", sh: 1, st: 0, g: 0, a: 0, fc: 2, yc: 1, rc: 0, tk: null, sv: null, clr: null, pa: null, kp: null, cr: null, drb: null };
const fbAlvarez = byDate.get("2026-06-11").get(normalizeName("Édson Álvarez"));

const merged = mergeWcEntry(espnAlvarez, fbAlvarez);
assert("merge keeps ESPN identity + played", merged.played === true && merged.event_id === "760415");
assert("merge fills ESPN nulls from FBref", merged.tk === 4 && merged.clr === 3 && merged.pa === 58 && merged.kp === 1 && merged.drb === 2);
assert("merge never overwrites finite ESPN values", merged.sh === 1 && merged.fc === 2);
assert("merge with no FBref row = ESPN passthrough", mergeWcEntry(espnAlvarez, null) === espnAlvarez);
const fbOnly = mergeWcEntry(null, fbAlvarez);
assert("FBref-only entry plays with minutes", fbOnly.played === true && fbOnly.event_id === null && fbOnly.tk === 4);
assert("both null → null", mergeWcEntry(null, null) === null);

// ── wcActualFor over merged entries ─────────────────────────────────────────

assert("ESPN-only: Tackles ungradeable", wcActualFor("Tackles", espnAlvarez) == null);
assert("merged: Tackles grades", wcActualFor("Tackles", merged) === 4);
assert("merged: Clearances grades", wcActualFor("Clearances", merged) === 3);
assert("merged: Passes Attempted grades", wcActualFor("Passes Attempted", merged) === 58);
assert("ESPN-only: fantasy null (all-or-nothing)", wcActualFor("Outfield Fantasy Score", espnAlvarez) === null);
// 0g,0a,1sh,0st,58·0.05pa,1·0.5kp,3clr,4tk,2drb,0cr,1yc(−1),0rc,2fc(−0.5) = 11.4
assert("merged: fantasy composite grades", wcActualFor("Outfield Fantasy Score", merged) === 11.4,
  `got ${wcActualFor("Outfield Fantasy Score", merged)}`);
assert("keeper: Goalie Saves grades from FBref", wcActualFor("Goalie Saves", mergeWcEntry(null, rangel)) === 2);

// ── FotMob composer (refresh-wc-fotmob-stats.mjs) ───────────────────────────
// FotMob carries the advanced Opta stats FBref hasn't posted this tournament.
// Per-player stats are grouped; attempted counts (passes/dribbles/crosses) live
// in `.total`; cards come from matchFacts events; omitted countables = true 0.

const FM_MD = {
  content: {
    playerStats: {
      "1": {
        name: "Heung-Min Son", teamName: "South Korea", isGoalkeeper: false,
        stats: [
          { title: "Top stats", stats: {
            "Minutes played": { stat: { value: 90 } },
            "Goals": { stat: { value: 1 } },
            "Assists": { stat: { value: 0 } },
            "Total shots": { stat: { value: 4 } },
            "Shots on target": { stat: { value: 2 } },
            "Accurate passes": { stat: { value: 30, total: 42 } }, // pa = attempted (total)
            "Chances created": { stat: { value: 3 } },
          } },
          { title: "Attack", stats: {
            "Successful dribbles": { stat: { value: 2, total: 5 } }, // drb = attempted
            "Accurate crosses": { stat: { value: 1, total: 4 } },    // cr = attempted
          } },
          { title: "Defense", stats: { "Tackles": { stat: { value: 1 } }, "Clearances": { stat: { value: 0 } } } },
          { title: "Duels", stats: { "Fouls committed": { stat: { value: 2 } } } },
        ],
      },
      "2": { // keeper: Saves present, isGoalkeeper → sv defaults 0 if absent
        name: "Test Keeper", teamName: "South Korea", isGoalkeeper: true,
        stats: [
          { title: "Top stats", stats: { "Minutes played": { stat: { value: 90 } } } },
          { title: "Goalkeeping", stats: { "Saves": { stat: { value: 3 } } } },
        ],
      },
      "3": { name: "Unused Sub", teamName: "South Korea", isGoalkeeper: false, stats: [] }, // no minutes → excluded
      "4": { // outfielder with no crosses/dribbles (omitted = 0) + a yellow card
        name: "Carded Player", teamName: "Czechia", isGoalkeeper: false,
        stats: [
          { title: "Top stats", stats: { "Minutes played": { stat: { value: 80 } }, "Accurate passes": { stat: { value: 20, total: 25 } }, "Total shots": { stat: { value: 0 } }, "Shots on target": { stat: { value: 0 } }, "Goals": { stat: { value: 0 } }, "Assists": { stat: { value: 0 } }, "Chances created": { stat: { value: 0 } } } },
          { title: "Defense", stats: { "Tackles": { stat: { value: 3 } }, "Clearances": { stat: { value: 5 } } } },
        ],
      },
    },
    matchFacts: { events: { events: [
      { type: "Card", player: { name: "Carded Player" }, card: "Yellow" },
      { type: "Card", player: { name: "Heung-Min Son" }, card: "Red" },
    ] } },
  },
};

const fm = composeFotmobPlayers(FM_MD);
const son = fm[normalizeName("Heung-Min Son")];
const keeper = fm[normalizeName("Test Keeper")];
const carded = fm[normalizeName("Carded Player")];

assert("fotmob: unused sub (no minutes) excluded", !fm[normalizeName("Unused Sub")] && Object.keys(fm).length === 3, `keys=${Object.keys(fm).join(",")}`);
assert("fotmob: passes attempted from .total", son?.pa === 42);
assert("fotmob: dribbles + crosses attempted from .total", son?.drb === 5 && son?.cr === 4);
assert("fotmob: tackles/clearances/kp/fouls parse", son?.tk === 1 && son?.clr === 0 && son?.kp === 3 && son?.fc === 2);
assert("fotmob: red card → rc from events", son?.rc === 1 && son?.yc === 0);
assert("fotmob: team + played", son?.team === "South Korea" && son?.played === true);
assert("fotmob: keeper saves + sv default", keeper?.sv === 3 && keeper?.sh === 0);
assert("fotmob: omitted countables default to 0", carded?.cr === 0 && carded?.drb === 0 && carded?.yc === 1 && carded?.rc === 0);

const fmCards = parseFotmobCards(FM_MD);
assert("parseFotmobCards: yellow vs red split", fmCards.get(normalizeName("Carded Player")).yc === 1 && fmCards.get(normalizeName("Heung-Min Son")).rc === 1);

// Grader merge order: FotMob preferred over FBref, ESPN wins over both.
const espnSon = { name: "Heung-Min Son", team: "South Korea", played: true, event_id: "e1", sh: 4, st: 2, g: 1, a: 0, sv: null, tk: null, clr: null, pa: null, kp: null, cr: null, drb: null, fc: null, yc: null, rc: null };
const fbSon = { name: "Heung-Min Son", team: "South Korea", min: 90, tk: 99 }; // FBref disagrees on tk
const snapSon = mergeWcEntry(son, fbSon);          // FotMob preferred
const mergedSon = mergeWcEntry(espnSon, snapSon);  // ESPN wins overall
assert("merge: FotMob preferred over FBref", snapSon.tk === 1);
assert("merge: ESPN identity preserved", mergedSon.event_id === "e1" && mergedSon.sh === 4);
assert("merge: FotMob fills model-led for ESPN", mergedSon.pa === 42 && mergedSon.clr === 0 && mergedSon.drb === 5);
// 10g +0a +4sh +2st +42·0.05 +3·0.5 +0clr +1tk +5drb +4·0.5cr +0yc +1·-2rc +2·-0.5fc
assert("merge: fantasy grades off FotMob", wcActualFor("Outfield Fantasy Score", mergedSon) === 24.6,
  `got ${wcActualFor("Outfield Fantasy Score", mergedSon)}`);

// ── finishedMatchesFromLeagues + etDate ─────────────────────────────────────

const LG = { fixtures: { allMatches: [
  { id: 1, pageUrl: "/matches/a-vs-b/x#1", home: { name: "A" }, away: { name: "B" }, status: { finished: true, utcTime: "2026-06-11T19:00:00Z" } },
  { id: 2, pageUrl: "/matches/c-vs-d/y#2", home: { name: "C" }, away: { name: "D" }, status: { finished: false, utcTime: "2026-06-25T19:00:00Z" } },
  { id: 3, pageUrl: "/matches/e-vs-f/z#3", home: { name: "E" }, away: { name: "F" }, status: { finished: true, cancelled: true, utcTime: "2026-06-12T19:00:00Z" } },
] } };
const finished = finishedMatchesFromLeagues(LG);
assert("leagues: only finished, non-cancelled kept", finished.length === 1 && finished[0].id === "1");
assert("leagues: id/pageUrl/teams carried", finished[0].pageUrl === "/matches/a-vs-b/x#1" && finished[0].home === "A" && finished[0].away === "B");
assert("leagues: overview fallback path", finishedMatchesFromLeagues({ overview: { leagueOverviewMatches: LG.fixtures.allMatches } }).length === 1);
// 19:00Z = 15:00 EDT same day; 02:00Z = 22:00 EDT previous day (the reason for ET conversion)
assert("etDate: same-day afternoon", etDate("2026-06-11T19:00:00Z") === "2026-06-11");
assert("etDate: post-midnight-UTC stays previous ET day", etDate("2026-06-12T02:00:00Z") === "2026-06-11");

// ── buildSoccerAccrual (spec §4.4 tournament accrual) ───────────────────────

const P = normalizeName("Heung-Min Son");
const FULL = { name: "Heung-Min Son", min: 90, sh: 3, st: 1, tk: 2, clr: 1, pa: 40, sv: 0, g: 1, a: 0, kp: 2, cr: 3, drb: 4, fc: 1, yc: 0, rc: 0 };
const fmAcc = { matches: {
  m1: { date: "2026-06-11", players: { [P]: FULL } },
  m2: { date: "2026-06-17", players: { [P]: { ...FULL, min: 60, sh: 1, pa: 20 } } },
} };
const accr = buildSoccerAccrual(fmAcc, null);
assert("accrual: totals sum across matches", accr.players[P]?.shots === 4 && accr.players[P]?.passes_att === 60);
assert("accrual: minutes + matches accumulate", accr.players[P]?.minutes === 150 && accr.players[P]?.matches === 2);
assert("accrual: snapshot keys → LAMBDA_FIELDS names",
  accr.players[P]?.sot === 2 && accr.players[P]?.key_passes === 4 && accr.players[P]?.dribbles_att === 8 && accr.players[P]?.yellow === 0);

// FotMob preferred per field; FBref fills what FotMob lacks on the same date.
const fmSparse = { matches: { m1: { date: "2026-06-11", players: { [P]: { name: "Heung-Min Son", min: 90, sh: 2, tk: 5 } } } } };
const fbSame = { matches: { f1: { date: "2026-06-11", players: { [P]: { name: "Heung-Min Son", min: 90, sh: 9, tk: 9, clr: 3 } } } } };
const accrMerged = buildSoccerAccrual(fmSparse, fbSame);
assert("accrual: FotMob preferred, FBref fills", accrMerged.players[P]?.shots === 2 && accrMerged.players[P]?.tackles === 5 && accrMerged.players[P]?.clearances === 3);

// A field missing in ANY of the player's matches is omitted (all-or-nothing
// per field): a partial total over full minutes would deflate the per-90.
const fmPartial = { matches: {
  m1: { date: "2026-06-11", players: { [P]: FULL } },
  m2: { date: "2026-06-17", players: { [P]: { name: "Heung-Min Son", min: 45, sh: 1 } } }, // basic-only: no tk/clr/pa
} };
const accrPartial = buildSoccerAccrual(fmPartial, null);
assert("accrual: field missing in one match → omitted", accrPartial.players[P]?.tackles === undefined && accrPartial.players[P]?.shots === 4);
assert("accrual: minutes still cover all matches", accrPartial.players[P]?.minutes === 135);

// Rows without minutes can't per-90 — skipped entirely.
const fmNoMin = { matches: { m1: { date: "2026-06-11", players: { [P]: { name: "Heung-Min Son", sh: 3 } } } } };
assert("accrual: row without minutes skipped", Object.keys(buildSoccerAccrual(fmNoMin, null).players).length === 0);
assert("accrual: null snapshots → empty players", Object.keys(buildSoccerAccrual(null, null).players).length === 0);

console.log(`\nsmoke-wc-match-stats: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
