// Smoke for the basketball game-log parsers (api/_lib/basketball/gamelogs.js)
// on synthetic stats.nba.com payloads, plus a sanity pass on the committed
// snapshots. No network.
//   node scripts/smoke-basketball-gamelogs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMatchup, positionGroup, parsePlayerGameLog, parseTeamGameLog, parsePlayerIndex, buildTeamGames, validate, statOf, possessionsOf } from "../api/_lib/basketball/gamelogs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// A) Matchup + position parsing
ok(JSON.stringify(parseMatchup("OKC vs. HOU")) === JSON.stringify({ team: "OKC", home: true, opponent: "HOU" }), "A: home matchup");
ok(parseMatchup("OKC @ HOU")?.home === false && parseMatchup("OKC @ HOU")?.opponent === "HOU", "A: away matchup");
ok(parseMatchup("garbage") === null, "A: unparseable → null");
ok(positionGroup("G") === "G" && positionGroup("G-F") === "W" && positionGroup("F") === "W" && positionGroup("F-C") === "B" && positionGroup("C") === "B", "A: position groups");
ok(positionGroup("") === null && positionGroup(null) === null, "A: missing position → null");

// B) Synthetic one-game league
const PH = ["PLAYER_ID", "GAME_ID", "GAME_DATE", "TEAM_ABBREVIATION", "MATCHUP", "MIN", "PTS", "REB", "OREB", "DREB", "AST", "STL", "BLK", "TOV", "PF", "FGM", "FGA", "FG3M", "FG3A", "FTM", "FTA"];
const TH = ["GAME_ID", "GAME_DATE", "TEAM_ABBREVIATION", "MATCHUP", "PTS", "REB", "OREB", "DREB", "AST", "STL", "BLK", "TOV", "PF", "FGM", "FGA", "FG3M", "FG3A", "FTM", "FTA"];
const pl = (id, team, m, s) => [id, "001", "2026-01-01", team, m, ...s];
const playerPayload = { resultSets: [{ headers: PH, rowSet: [
  pl(1, "AAA", "AAA vs. BBB", [30, 20, 5, 1, 4, 6, 1, 0, 2, 3, 8, 15, 2, 5, 2, 2]),
  pl(2, "AAA", "AAA vs. BBB", [18, 4, 9, 3, 6, 0, 0, 2, 1, 4, 2, 6, 0, 0, 0, 0]),
  pl(3, "BBB", "BBB @ AAA", [36, 30, 3, 0, 3, 2, 2, 0, 3, 2, 11, 20, 4, 8, 4, 5]),
] }] };
const teamPayload = { resultSets: [{ headers: TH, rowSet: [
  ["001", "2026-01-01", "AAA", "AAA vs. BBB", 24, 14, 4, 10, 6, 1, 2, 4, 7, 10, 21, 2, 5, 2, 2], // tov 4 vs players 3 (team turnover)
  ["001", "2026-01-01", "BBB", "BBB @ AAA", 30, 3, 0, 3, 2, 2, 0, 3, 2, 11, 20, 4, 8, 4, 5],
] }] };
const idxPayload = { resultSets: [{ headers: ["PERSON_ID", "PLAYER_FIRST_NAME", "PLAYER_LAST_NAME", "POSITION"], rowSet: [[1, "Ann", "A", "G"], [2, "Bea", "B", "C"], [3, "Cid", "C", "F"], [9, "Not", "Here", "G"]] }] };

const rows = parsePlayerGameLog(playerPayload);
ok(rows.length === 3 && rows[0].home === true && rows[2].opponent === "AAA", "B: player rows with matchup");
ok(!("stl" in rows[1]) && statOf(rows[1], "stl") === 0, "B: zero stats omitted, statOf → 0");
const teamLog = parseTeamGameLog(teamPayload);
ok(Object.keys(teamLog).length === 2 && teamLog["001|AAA"].pts === 24, "B: team log keyed game|team");
const players = parsePlayerIndex(idxPayload, new Set([1, 2, 3]));
ok(Object.keys(players).length === 3 && players[2].group === "B" && players[1].name === "Ann A", "B: player index filtered to ids");
ok(validate(rows, teamLog, players).length === 0, `B: valid league passes (${validate(rows, teamLog, players).join("; ")})`);
const tg = buildTeamGames(teamLog);
const want = (possessionsOf(teamLog["001|AAA"]) + possessionsOf(teamLog["001|BBB"])) / 2;
ok(tg.length === 2 && Math.abs(tg[0].poss - want) < 0.01 && tg[0].poss === tg[1].poss, "B: both sides share one possession count");
ok(tg.find((t) => t.team === "AAA").opp_pts === 30, "B: opponent points attached");

// C) Validation catches real problems
{
  const broken = structuredClone(teamLog); broken["001|AAA"].pts = 25;
  ok(validate(rows, broken, players).some((p) => /pts/.test(p)), "C: points mismatch flagged");
  const tovOver = structuredClone(teamLog); tovOver["001|AAA"].tov = 2;
  ok(validate(rows, tovOver, players).some((p) => /tov/.test(p)), "C: player turnovers above team total flagged");
  const lonely = structuredClone(teamLog); delete lonely["001|BBB"];
  ok(validate(rows, lonely, players).some((p) => /no opponent row|no team row/.test(p)), "C: missing side flagged");
  ok(validate(rows, teamLog, { 1: players[1] }).some((p) => /position group/.test(p)), "C: unpositioned minutes flagged");
}

// D) Committed snapshots (skip if not built yet)
const dir = path.join(ROOT, "data", "basketball");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
if (!files.length) console.log("SKIP  snapshot checks (run scripts/refresh-basketball-gamelogs.mjs)");
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const tgs = new Set(s.team_games.map((t) => `${t.game_id}|${t.team}`));
  const orphan = s.rows.filter((r) => !tgs.has(`${r.game_id}|${r.team}`)).length;
  const posMin = s.rows.reduce((a, r) => a + (s.players[r.player_id]?.group ? statOf(r, "min") : 0), 0) / s.rows.reduce((a, r) => a + statOf(r, "min"), 0);
  ok(orphan === 0, `D: ${f} every row joins a team-game (${orphan} orphans)`);
  ok(posMin > 0.99, `D: ${f} ≥ 99% of minutes have a position group (${(100 * posMin).toFixed(1)}%)`);
  ok(s.team_games.every((t) => t.poss > 60 && t.poss < 130), `D: ${f} possessions in a sane range`);
}

console.log(`\nsmoke-basketball-gamelogs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
