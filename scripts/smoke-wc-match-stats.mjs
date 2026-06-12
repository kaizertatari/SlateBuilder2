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
import { indexWcMatchStatsByDate, mergeWcEntry, wcActualFor, normalizeName } from "./_wc-actuals.mjs";

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

console.log(`\nsmoke-wc-match-stats: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
