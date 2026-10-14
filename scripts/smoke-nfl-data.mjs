// Smoke for the NFL data layer (api/_lib/nfl/nflverse.js + refresh-nfl-data
// validation) on fixtures, plus a sanity pass over the committed snapshot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, parseWeeklyStats, parseSchedule, parseSnapCounts, parseInjuries, parsePlayers, statOf } from "../api/_lib/nfl/nflverse.js";
import { validateTeamGames } from "./refresh-nfl-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`); };

// CSV: BOM, CRLF, quoted commas, escaped quotes, empty trailing field.
const csv = parseCsv(String.fromCharCode(0xfeff) + 'a,b,c\r\n1,"x, y",\r\n2,"he said ""hi""",NA\r\n');
check("CSV: header + rows", csv.length === 2 && Object.keys(csv[0]).join() === "a,b,c");
check("CSV: quoted comma kept in one field", csv[0].b === "x, y" && csv[0].c === "");
check("CSV: escaped quotes", csv[1].b === 'he said "hi"');

const wk = parseWeeklyStats([
  { player_id: "00-1", player_display_name: "Q B", position: "QB", position_group: "QB", season: "2026", week: "3", season_type: "REG", game_id: "2026_03_AAA_BBB", team: "AAA", opponent_team: "BBB", completions: "22", attempts: "33", passing_yards: "250", passing_tds: "2", passing_interceptions: "0", carries: "NA", target_share: "NA" },
  { player_id: "00-2", season: "2026", week: "NA", game_id: "x" },
]);
check("weekly: keeps valid rows only", wk.length === 1);
check("weekly: renames + numbers", wk[0].completions === 22 && wk[0].pass_att === 33 && wk[0].pass_yds === 250 && wk[0].pass_td === 2);
check("weekly: NA and zero stats dropped", !("rush_att" in wk[0]) && !("target_share" in wk[0]) && !("pass_int" in wk[0]));
check("statOf: absent stat reads 0", statOf(wk[0], "pass_int") === 0 && statOf(wk[0], "pass_yds") === 250);

const sch = parseSchedule([
  { game_id: "2026_03_AAA_BBB", season: "2026", week: "3", game_type: "REG", away_team: "AAA", home_team: "BBB", away_score: "20", home_score: "NA", spread_line: "-3.5", total_line: "44.5", roof: "dome", wind: "NA" },
  { game_id: "2024_01_X_Y", season: "2024", week: "1" },
], [2025, 2026]);
check("schedule: season filter", sch.length === 1);
check("schedule: unplayed score null, lines numeric", !("home_score" in sch[0]) && sch[0].away_score === 20 && sch[0].spread_line === -3.5 && sch[0].total_line === 44.5 && !("wind" in sch[0]));

const sn = parseSnapCounts([{ pfr_player_id: "AbcdXx00", player: "W R", game_id: "2026_03_AAA_BBB", season: "2026", week: "3", team: "AAA", offense_snaps: "50", offense_pct: "0.8", defense_snaps: "0", defense_pct: "0" }]);
check("snaps: offense share parsed", sn[0].off_snaps === 50 && sn[0].off_pct === 0.8 && sn[0].def_pct === 0);
const inj = parseInjuries([{ gsis_id: "00-1", full_name: "Q B", season: "2026", week: "4", report_status: "Questionable", practice_status: "Limited Participation in Practice", report_primary_injury: "Ankle" }, { gsis_id: "" }]);
check("injuries: status rows", inj.length === 1 && inj[0].report_status === "Questionable" && inj[0].primary_injury === "Ankle");
const pl = parsePlayers([{ gsis_id: "00-1", display_name: "Q B", position: "QB", latest_team: "AAA", pfr_id: "QbxxQb00", espn_id: "123", last_season: "2026" }, { gsis_id: "00-9", display_name: "Old", last_season: "2019" }], { minSeason: 2025 });
check("players: minSeason filter + ids", Object.keys(pl).length === 1 && pl["00-1"].pfr_id === "QbxxQb00" && pl["00-1"].espn_id === "123");

const ok = validateTeamGames([{ game_id: "g", team: "A", completions: 2, pass_yds: 30 }, { game_id: "g", team: "A", rec: 2, rec_yds: 30 }]);
const bad = validateTeamGames([{ game_id: "g", team: "A", completions: 2, pass_yds: 30 }, { game_id: "g", team: "A", rec: 1, rec_yds: 12 }]);
check("validation: identities hold / break detected", ok.bad.length === 0 && bad.bad.length === 1);

// Committed snapshot sanity (skips cleanly before the first refresh).
const f = (n) => path.join(ROOT, "data", n);
if (fs.existsSync(f("nfl-player-games.json")) && fs.existsSync(f("nfl-players.json")) && fs.existsSync(f("nfl-games.json"))) {
  const rows = JSON.parse(fs.readFileSync(f("nfl-player-games.json"), "utf8")).rows;
  const players = JSON.parse(fs.readFileSync(f("nfl-players.json"), "utf8")).players;
  const games = JSON.parse(fs.readFileSync(f("nfl-games.json"), "utf8")).games;
  check("snapshot: player-games present for both seasons", rows.some((r) => r.season === 2025) && rows.some((r) => r.season === 2026), `${rows.length} rows`);
  const missing = new Set(rows.map((r) => r.player_id).filter((id) => !players[id]));
  check("snapshot: every player-game has a registry entry", missing.size === 0, `${missing.size} ids missing`);
  check("snapshot: box-score identities hold", validateTeamGames(rows).bad.length === 0);
  check("snapshot: games carry closing lines", games.filter((g) => g.home_score != null).every((g) => g.total_line != null && g.spread_line != null));
} else {
  console.log("SKIP  snapshot checks (run npm run refresh-nfl-data)");
}

console.log(`\nsmoke-nfl-data: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
