// Hermetic smoke for NFL grading (api/_lib/nfl/grading.js) + the gameday window.

import { actualFor, gradeVerdict, playedState, latestBeforeKickoff, joinKey, openClose, clvFor } from "../api/_lib/nfl/grading.js";
import { MODEL_STATS } from "../api/_lib/nfl/model.js";
import { gamesInWindow } from "./nfl-gameday.mjs";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}

console.log("[a] actuals from a compact nflverse row (zero stats dropped)");
const qb = { pass_att: 35, completions: 24, pass_yds: 280, pass_td: 2, pass_int: 1, rush_att: 5, rush_yds: 30, rush_td: 1, sack_fum_lost: 1, pass_2pt: 1 };
assert("plain stats", actualFor("pass_yds", qb) === 280 && actualFor("completions", qb) === 24);
assert("missing stat reads 0", actualFor("rec", qb) === 0 && actualFor("targets", qb) === 0);
assert("pass + rush yds", actualFor("pass_rush_yds", qb) === 310);
// 0.04·280 + 4·2 − 1 + 0.1·30 + 6 − 1 (sack fumble lost) + 2 (2-pt) = 28.2
assert("PrizePicks fantasy formula", actualFor("fantasy", qb) === 28.2, String(actualFor("fantasy", qb)));
const wr = { targets: 9, rec: 6, rec_yds: 88, rec_td: 1, rush_att: 1, rush_yds: 7, rec_fum_lost: 1 };
assert("rush + rec yds / TDs", actualFor("rush_rec_yds", wr) === 95 && actualFor("rush_rec_td", wr) === 1);
assert("WR fantasy (PPR, fumble lost)", actualFor("fantasy", wr) === 6 + 8.8 + 6 + 0.7 - 1, String(actualFor("fantasy", wr)));
assert("tackles + assists", actualFor("tackles_ast", { tackles_solo: 4, tackle_ast: 3 }) === 7);
assert("kicking points = 3·FG + PAT", actualFor("kicking_pts", { fg_made: 2, pat_made: 3 }) === 9);
assert("every model stat has an actual", MODEL_STATS.every((s) => actualFor(s, {}) === 0), MODEL_STATS.filter((s) => actualFor(s, {}) !== 0).join(","));
assert("unknown stat → null", actualFor("longest_rec", wr) === null);

console.log("\n[b] played? (stats row, snap counts, not yet published)");
assert("stats row → played", playedState({ statRow: wr, snapRow: null, snapsPublished: false }) === true);
assert("snaps only (touched nothing) → played", playedState({ statRow: null, snapRow: { off_snaps: 12, def_snaps: 0, st_snaps: 0 }, snapsPublished: true }) === true);
assert("special-teams snaps count", playedState({ statRow: null, snapRow: { off_snaps: 0, st_snaps: 8 }, snapsPublished: true }) === true);
assert("no row, snaps published → DNP", playedState({ statRow: null, snapRow: null, snapsPublished: true }) === false);
assert("no row, snaps not out → wait", playedState({ statRow: null, snapRow: null, snapsPublished: false }) === null);

console.log("\n[c] settlement");
const v = (stat, line, direction) => ({ nfl_stat: stat, line, direction });
assert("OVER hit", gradeVerdict(v("rec_yds", 70.5, "OVER"), { statRow: wr, played: true }).hit_or_miss === "hit");
assert("UNDER miss", gradeVerdict(v("rec_yds", 70.5, "UNDER"), { statRow: wr, played: true }).hit_or_miss === "miss");
assert("integer tie → push", gradeVerdict(v("rec", 6, "OVER"), { statRow: wr, played: true }).hit_or_miss === "push");
assert("played, no stats row → 0 (UNDER hits)", (() => { const g = gradeVerdict(v("rec", 2.5, "UNDER"), { statRow: null, played: true }); return g.hit_or_miss === "hit" && g.actual_value === 0; })());
assert("DNP → void", gradeVerdict(v("rec", 2.5, "UNDER"), { statRow: null, played: false }).reason === "dnp");

console.log("\n[d] closing line: first vs last pre-kickoff verdict");
const base = { player: "P", prop_type: "Receiving Yards OVER", line: 60.5, direction: "OVER", game_start_time: "2026-10-18T17:00:00Z" };
const vs = [
  { ...base, _time: "2026-10-15T12:00:00Z", nfl_p_market: 0.5, nfl_book_line: 60.5 },
  { ...base, _time: "2026-10-18T16:10:00Z", nfl_p_market: 0.56, nfl_book_line: 62.5 },
  { ...base, _time: "2026-10-18T15:40:00Z", nfl_p_market: 0.54, nfl_book_line: 61.5 },
  { ...base, _time: "2026-10-18T17:30:00Z", nfl_p_market: 0.9 }, // after kickoff — ignored
];
const oc = openClose(vs).get(joinKey(base));
assert("open = earliest, close = latest pre-kickoff", oc.open._time === "2026-10-15T12:00:00Z" && oc.close._time === "2026-10-18T16:10:00Z" && oc.n === 3);
assert("CLV = close − open on the picked side", clvFor(oc) === 0.06, String(clvFor(oc)));
assert("CLV null without a market price", clvFor({ open: { nfl_p_market: null }, close: { nfl_p_market: 0.5 } }) === null);
assert("grader keeps the same verdict as the close", latestBeforeKickoff(vs)[0]._time === oc.close._time);

console.log("\n[e] gameday window (kickoffs are ET, EDT before Nov 1)");
const sched = [
  { away: "SEA", home: "DEN", gameday: "2026-10-15", gametime: "20:15" }, // 00:15Z Oct 16
  { away: "KC", home: "BUF", gameday: "2026-10-18", gametime: "13:00" },
];
const now = Date.parse("2026-10-15T23:00:00Z"); // 75 min before SEA@DEN
assert("game 75 min out is in a 90-min window", gamesInWindow(sched, now, 90).map((g) => g.home).join() === "DEN");
assert("not in a 60-min window", gamesInWindow(sched, now, 60).length === 0);
assert("started games drop out", gamesInWindow(sched, Date.parse("2026-10-16T00:20:00Z"), 90).length === 0);

console.log(`\nsmoke-nfl-grading: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
