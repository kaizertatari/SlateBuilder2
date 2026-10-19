// Basketball opponent-factor model, step 1 — pull every player-game and
// team-game box score for the history window and write one compact snapshot
// per league-season (finished seasons never change, so only the current
// season's file churns):
//
//   data/basketball/<league>-<season>.json   e.g. nba-2025-26.json, wnba-2026.json
//   default seasons: NBA last two + current, WNBA last + current
//
// Shape: { league, season, fetched_at, players: { id: { name, position, group } },
//          team_games: [...], rows: [...] }
// Rows carry player_id, game_id, team + non-zero stats (read with statOf);
// date / opponent / home live on the team-game ("<game_id>|<team>").
//
// Validates every season before writing anything: player rows sum to the
// team box score for every counted stat (turnovers may fall short — team
// turnovers aren't credited to a player), every game has both teams, and
// < 1% of minutes lack a position group.
//
// Usage: node scripts/refresh-basketball-gamelogs.mjs --league NBA|WNBA [--seasons 2024-25,2025-26]
// Run from home (stats.nba.com / stats.wnba.com throttle cloud IPs).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NBA_HEADERS, WNBA_HEADERS } from "../api/_lib/nba-http.js";
import { currentSeason } from "../api/_lib/nba-stats.js";
import { parsePlayerGameLog, parseTeamGameLog, parsePlayerIndex, buildTeamGames, validate } from "../api/_lib/basketball/gamelogs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LEAGUE = arg("--league", "NBA").toUpperCase();
if (!["NBA", "WNBA"].includes(LEAGUE)) throw new Error(`--league must be NBA or WNBA (got ${LEAGUE})`);
const CFG = LEAGUE === "WNBA"
  ? { base: "https://stats.wnba.com/stats", headers: WNBA_HEADERS, id: "10" }
  : { base: "https://stats.nba.com/stats", headers: NBA_HEADERS, id: "00" };
const OUT_DIR = path.join(ROOT, "data", "basketball");
const outPath = (season) => path.join(OUT_DIR, `${LEAGUE.toLowerCase()}-${season}.json`);

function defaultSeasons() {
  const y = parseInt(currentSeason(new Date(), LEAGUE), 10);
  const label = (yr) => (LEAGUE === "WNBA" ? String(yr) : `${yr}-${String((yr + 1) % 100).padStart(2, "0")}`);
  return LEAGUE === "WNBA" ? [label(y - 1), label(y)] : [label(y - 2), label(y - 1), label(y)];
}
const SEASONS = arg("--seasons", null)?.split(",") ?? defaultSeasons();

async function get(endpoint, params) {
  const url = `${CFG.base}/${endpoint}?${new URLSearchParams({ LeagueID: CFG.id, ...params })}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: CFG.headers, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${endpoint} ${params.Season ?? ""}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

const gameLog = (season, who) => get("leaguegamelog", { Counter: 0, Direction: "ASC", PlayerOrTeam: who, Season: season, SeasonType: "Regular Season", Sorter: "DATE" });

function serialize(season, fetchedAt, players, teamGames, unsortedRows) {
  // stats.nba.com returns rows in a different order on every call; sort so
  // the snapshot is reproducible and an unchanged season is byte-identical.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const rows = [...unsortedRows].sort((a, b) => cmp(a.game_id, b.game_id) || cmp(a.team, b.team) || a.player_id - b.player_id);
  teamGames = [...teamGames].sort((a, b) => cmp(a.game_id, b.game_id) || cmp(a.team, b.team));
  const own = Object.fromEntries([...new Set(rows.map((r) => r.player_id))].sort((a, b) => a - b).map((id) => [id, players[id] ?? null]));
  const slim = rows.map(({ date, opponent, home, ...r }) => r);
  return [
    `{"league":${JSON.stringify(LEAGUE)},"season":${JSON.stringify(season)},"fetched_at":${JSON.stringify(fetchedAt)},`,
    `"players":${JSON.stringify(own)},`,
    `"team_games":[`,
    teamGames.map((t) => JSON.stringify(t)).join(",\n"),
    `],`,
    `"rows":[`,
    slim.map((r) => JSON.stringify(r)).join(",\n"),
    `]}`,
  ].join("\n") + "\n";
}

async function main() {
  console.log(`=== refresh-basketball-gamelogs (${LEAGUE}: ${SEASONS.join(", ")}) ===`);
  const fetchedAt = new Date().toISOString();
  const ids = new Set();
  const perSeason = {};
  for (const season of SEASONS) {
    const rows = parsePlayerGameLog(await gameLog(season, "P"));
    const teamLog = parseTeamGameLog(await gameLog(season, "T"));
    if (!rows.length) { console.log(`  ${season}: no games yet — skipped`); continue; }
    rows.forEach((r) => ids.add(r.player_id));
    perSeason[season] = { rows, teamLog };
  }
  // Historical=1 lists every player ever with his current listed position
  // (Historical=0 drops players no longer active — 89% of 2024-25 minutes).
  const latest = Object.keys(perSeason).at(-1);
  if (!latest) throw new Error("no season had games");
  const players = parsePlayerIndex(await get("playerindex", { Season: latest, Historical: 1, Active: "", TeamID: 0, College: "", Country: "", DraftYear: "", DraftPick: "", PlayerPosition: "", Height: "", Weight: "" }), ids);

  let bad = 0;
  const files = {};
  for (const [season, { rows, teamLog }] of Object.entries(perSeason)) {
    const problems = validate(rows, teamLog, players);
    const teamGames = buildTeamGames(teamLog);
    console.log(`  ${season}: ${rows.length} player-games, ${teamGames.length / 2} games, ${new Set(rows.map((r) => r.player_id)).size} players — ${problems.length ? `${problems.length} problems` : "valid"}`);
    for (const p of problems.slice(0, 10)) console.log(`    ✗ ${p}`);
    bad += problems.length;
    files[season] = serialize(season, fetchedAt, players, teamGames, rows);
  }
  if (bad) throw new Error(`${bad} validation problems — nothing written`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (const [season, text] of Object.entries(files)) {
    // Skip identical content (only fetched_at would change) so finished
    // seasons and the off-season don't churn the snapshot every day.
    // (CRLF-normalised: git checks the snapshots out with Windows endings.)
    const body = (t) => t.replace(/\r\n/g, "\n").replace(/"fetched_at":"[^"]*",/, "");
    const old = await fs.readFile(outPath(season), "utf8").catch(() => null);
    if (old && body(old) === body(text)) { console.log(`Unchanged ${path.relative(ROOT, outPath(season))}`); continue; }
    await fs.writeFile(outPath(season), text);
    console.log(`Wrote ${path.relative(ROOT, outPath(season))} (${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB)`);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
