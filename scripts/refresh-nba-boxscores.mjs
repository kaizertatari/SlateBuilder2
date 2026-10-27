// NBA team tracker, step 1 — per-game box scores for THIS season only:
// traditional (with the starters/bench split), misc, advanced, hustle and
// matchup defense for every finished game in the league game log.
//
//   data/basketball/box/nba-<season>.json   { season, fetched_at, games: { id: game } }
//
// Incremental: only games not yet stored are fetched (plus stored games whose
// hustle / matchup feed was still empty — stats.nba.com fills those late).
// Game list + dates come from data/basketball/nba-<season>.json, so run
// refresh-basketball-gamelogs first (the daily grade task does).
//
// Accuracy, before a game is stored:
//   - internal: starters + bench = team, player rows = team, 5 starters per
//     team, pts = 2·FGM + 3PM + FTM, plus-minus = margin, paint pts match the
//     opponent's "allowed", 240 (+25 per OT) team-minutes  (validateGame)
//   - vs ESPN (independent source): final score + full team box (FG/3P/FT
//     made-attempted, OREB/DREB/REB, AST, STL, BLK)
//   - vs the league game log (separate stats.nba.com aggregation); a mismatch
//     there is only a warning when ESPN confirms the box (stat corrections)
// A game failing any check is NOT stored (retried next run) and the script
// exits 1, so the daily log shows it.
//
// Usage: node scripts/refresh-nba-boxscores.mjs [--refetch-all] [--check]
//   --check  re-validate every stored game against the game log + ESPN, write nothing

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NBA_HEADERS } from "../api/_lib/nba-http.js";
import { currentSeason } from "../api/_lib/nba-stats.js";
import { toNbaAbbr } from "../api/_lib/espn.js";
import { parseGame, validateGame, compareTotals, parseEspnTeamTotals } from "../api/_lib/basketball/boxscores.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const REFETCH = args.includes("--refetch-all");
const SEASON = currentSeason(new Date(), "NBA");
const LOG_FILE = path.join(ROOT, "data", "basketball", `nba-${SEASON}.json`);
const OUT = path.join(ROOT, "data", "basketball", "box", `nba-${SEASON}.json`);
const FEEDS = { trad: "boxscoretraditionalv3", misc: "boxscoremiscv3", adv: "boxscoreadvancedv3", hustle: "boxscorehustlev2", def: "boxscoredefensivev2" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw new Error(`${url.split("?")[0].split("/").pop()}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

async function fetchGame(gameId) {
  const q = `GameID=${gameId}&StartPeriod=0&EndPeriod=0&StartRange=0&EndRange=0&RangeType=0`;
  const out = {};
  for (const [k, ep] of Object.entries(FEEDS)) {
    try { out[k] = await getJson(`https://stats.nba.com/stats/${ep}?${q}`, NBA_HEADERS); }
    catch (e) { if (k === "trad") throw e; out[k] = null; } // optional feeds may lag
    await sleep(400);
  }
  return out;
}

// ESPN completed games by date → { "<NBA tri>|<NBA tri>": { id, pts: { TRI: pts } } }
const espnCache = new Map();
const nbaTri = (a) => toNbaAbbr(a, "NBA");
async function espnGames(date) {
  if (espnCache.has(date)) return espnCache.get(date);
  const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date.replaceAll("-", "")}`);
  const out = {};
  for (const ev of j.events ?? []) {
    const c = ev.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const pts = Object.fromEntries((c.competitors ?? []).map((x) => [nbaTri(x.team?.abbreviation), Number(x.score)]));
    out[Object.keys(pts).sort().join("|")] = { id: ev.id, pts };
  }
  espnCache.set(date, out);
  return out;
}

// Three sources per team stat: the box, the league game log (a second
// stats.nba.com aggregation that can lag a stat correction — 2026-10-25
// SAC/MEM) and ESPN (independent; occasionally ±1 attempt off the official
// play-by-play — 2026-10-23 SAC 3PA, 2026-10-24 DAL FGA). A stat is accepted
// when the box agrees with at least one other source (warning on the odd one
// out); it blocks storing when the box disagrees with both. Final score must
// match ESPN exactly. Without ESPN, the box must match the game log.
async function crossCheck(game, logTeams) {
  const hard = validateGame(game);
  const warn = [];
  let espnBox = null;
  try {
    const ev = (await espnGames(game.date))[Object.keys(game.teams).sort().join("|")];
    if (!ev) throw new Error(`no completed ESPN game for ${Object.keys(game.teams).join("/")} on ${game.date}`);
    for (const [tri, t] of Object.entries(game.teams)) if (ev.pts[tri] !== t.totals.pts) hard.push(`${game.game_id} ${tri}: pts ${t.totals.pts} ≠ ESPN ${ev.pts[tri]}`);
    espnBox = parseEspnTeamTotals(await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`), nbaTri);
  } catch (e) {
    warn.push(`${game.game_id}: ESPN check unavailable (${e.message})`);
  }
  const logDiff = new Set(compareTotals(game, logTeams, "src").map((x) => x.split(" box ")[0]));
  const espnDiff = espnBox ? new Set(compareTotals(game, espnBox, "src").map((x) => x.split(" box ")[0])) : null;
  const all = [...compareTotals(game, logTeams, "game log"), ...(espnBox ? compareTotals(game, espnBox, "ESPN") : [])];
  for (const msg of all) {
    const key = msg.split(" box ")[0];
    const confirmed = espnDiff ? !(logDiff.has(key) && espnDiff.has(key)) : !logDiff.has(key);
    (confirmed ? warn : hard).push(confirmed ? `${msg} (other source agrees with box)` : msg);
  }
  return { hard, warn };
}

// The v3 traditional box counts player turnovers only; the league game log's
// team TOV adds team turnovers (shot clock, 8-second, ...). Attach it as
// totals.tov_total — deterministic from the log, so re-applied every run.
function attachTeamTurnovers(game, logTeams) {
  for (const [tri, t] of Object.entries(game.teams)) {
    const lg = logTeams?.[tri]?.tov;
    if (lg == null) continue;
    // A stale game-log row (pre stat correction) can undercount: never go
    // below the box's player turnovers.
    if (lg < t.totals.tov) console.log(`  ! ${game.game_id} ${tri}: game-log TOV ${lg} < player TOV ${t.totals.tov} (stale log row) — using ${t.totals.tov}`);
    t.totals.tov_total = Math.max(lg, t.totals.tov);
  }
}

function serialize(store) {
  const ids = Object.keys(store.games).sort();
  return [
    `{"season":${JSON.stringify(store.season)},"fetched_at":${JSON.stringify(store.fetched_at)},"games":{`,
    ids.map((id) => `${JSON.stringify(id)}:${JSON.stringify(store.games[id])}`).join(",\n"),
    `}}`,
  ].join("\n") + "\n";
}

async function main() {
  const log = JSON.parse(await fs.readFile(LOG_FILE, "utf8"));
  const logByGame = new Map();
  for (const t of log.team_games) {
    const g = logByGame.get(t.game_id) ?? { date: t.date, teams: {} };
    g.teams[t.team] = t;
    logByGame.set(t.game_id, g);
  }
  let store = { season: SEASON, fetched_at: null, games: {} };
  try { store = JSON.parse(await fs.readFile(OUT, "utf8")); } catch { /* first run */ }
  if (store.season !== SEASON) store = { season: SEASON, fetched_at: null, games: {} }; // this season only

  if (CHECK) {
    let bad = 0;
    for (const [id, g] of Object.entries(store.games)) {
      const { hard, warn } = await crossCheck(g, logByGame.get(id)?.teams);
      for (const x of warn) console.log(`  ! ${x}`);
      if (hard.length) { bad++; for (const x of hard) console.log(`  ✗ ${x}`); }
    }
    const missing = [...logByGame.keys()].filter((id) => !store.games[id]);
    console.log(`check: ${Object.keys(store.games).length} stored games, ${bad} with problems, ${missing.length} game-log games not stored${missing.length ? ` (${missing.join(", ")})` : ""}`);
    process.exit(bad || missing.length ? 1 : 0);
  }

  // A feed is "late" when it's absent for a whole team — the hustle feed
  // permanently omits some low-minute bench players, so per-player nulls
  // are normal and must not trigger a refetch.
  let enriched = 0;
  for (const [id, g] of Object.entries(store.games)) {
    const before = JSON.stringify(Object.values(g.teams).map((t) => t.totals.tov_total));
    attachTeamTurnovers(g, logByGame.get(id)?.teams);
    if (JSON.stringify(Object.values(g.teams).map((t) => t.totals.tov_total)) !== before) enriched++;
  }

  const lateFeeds = (g) => Object.values(g.teams).some((t) => t.hustle == null || !g.players.some((p) => p.team === t.team && p.matchup != null));
  const todo = [...logByGame.keys()].filter((id) => REFETCH || !store.games[id] || lateFeeds(store.games[id])).sort();
  console.log(`refresh-nba-boxscores ${SEASON}: ${logByGame.size} finished games in the game log, ${Object.keys(store.games).length} stored, ${todo.length} to fetch`);
  let added = 0, failed = 0;
  for (const id of todo) {
    const meta = logByGame.get(id);
    try {
      const game = parseGame(await fetchGame(id), meta.date);
      if (!game) throw new Error("unparseable traditional box");
      attachTeamTurnovers(game, meta.teams);
      const { hard, warn } = await crossCheck(game, meta.teams);
      for (const x of warn) console.log(`  ! ${x}`);
      if (hard.length) { failed++; console.log(`  ✗ ${id} not stored:\n    ${hard.join("\n    ")}`); continue; }
      store.games[id] = game;
      added++;
      console.log(`  ✓ ${id} ${meta.date} ${game.away}@${game.home} ${game.teams[game.away].totals.pts}-${game.teams[game.home].totals.pts}${lateFeeds(game) ? " (hustle/matchup feed pending)" : ""}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${id}: ${e.message}`);
    }
  }
  if (added || enriched) {
    store.fetched_at = new Date().toISOString();
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, serialize(store));
  }
  console.log(`stored ${added}, failed ${failed} → ${path.relative(ROOT, OUT)} (${Object.keys(store.games).length} games)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
