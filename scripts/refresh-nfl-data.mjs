// NFL model step 1 — pull nflverse data (free, nightly) for the history
// window (2025 priors + the current 2026 season) and write compact snapshots:
//
//   data/nfl-games.json         every game: teams, scores, closing spread /
//                               total / moneylines, roof, wind, temp, rest
//   data/nfl-player-games.json  one row per player-game: box-score stats +
//                               offense/defense snap share (merged from
//                               snap_counts via the PFR↔GSIS registry)
//   data/nfl-players.json       registry (gsis → name/position/team/ids) for
//                               every player in the window + latest injury
//                               report status this season
//   data/nfl-injuries.json      every weekly injury-report row this season
//
// Then validates internal consistency per team-game: receptions = completions
// and receiving yards = passing yards (both exact in nflverse's box scores).
//
// Usage: npm run refresh-nfl-data  [-- --seasons 2025,2026]
// Plain HTTPS from GitHub releases — no browser, no PrizePicks, any IP.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, parseWeeklyStats, parseSchedule, parseSnapCounts, parseInjuries, parsePlayers } from "../api/_lib/nfl/nflverse.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REL = "https://github.com/nflverse/nflverse-data/releases/download";
const args = process.argv.slice(2);
const sIdx = args.indexOf("--seasons");
const SEASONS = (sIdx >= 0 ? args[sIdx + 1] : "2025,2026").split(",").map(Number);
const CURRENT = Math.max(...SEASONS);

async function getCsv(file) {
  const url = `${REL}/${file}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseCsv(await res.text());
    } catch (e) {
      if (attempt === 3) throw new Error(`${file}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// One JSON object per line inside the array, so git diffs stay readable.
const jsonLines = (head, key, rows) =>
  `{${Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")},${JSON.stringify(key)}:[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;

/** Per team-game box-score identities (exact in nflverse). */
export function validateTeamGames(rows) {
  const tg = new Map();
  for (const r of rows) {
    const k = `${r.game_id}|${r.team}`;
    const t = tg.get(k) ?? { comp: 0, rec: 0, pass_yds: 0, rec_yds: 0 };
    t.comp += r.completions ?? 0; t.rec += r.rec ?? 0;
    t.pass_yds += r.pass_yds ?? 0; t.rec_yds += r.rec_yds ?? 0;
    tg.set(k, t);
  }
  const bad = [];
  for (const [k, t] of tg) if (t.comp !== t.rec || Math.abs(t.pass_yds - t.rec_yds) > 0) bad.push({ key: k, ...t });
  return { teamGames: tg.size, bad };
}

async function main() {
  const t0 = Date.now();
  console.log(`refresh-nfl-data: seasons ${SEASONS.join(", ")} (current ${CURRENT})`);
  const [gamesRaw, playersRaw] = await Promise.all([getCsv("schedules/games.csv"), getCsv("players/players.csv")]);
  const games = parseSchedule(gamesRaw, SEASONS);
  const registryAll = parsePlayers(playersRaw, { minSeason: Math.min(...SEASONS) });
  const pfrToGsis = new Map(Object.entries(registryAll).filter(([, p]) => p.pfr_id).map(([g, p]) => [p.pfr_id, g]));

  const statRows = [], snapRows = [];
  let injuries = [];
  for (const s of SEASONS) {
    const [st, sn, inj] = await Promise.all([
      getCsv(`stats_player/stats_player_week_${s}.csv`),
      getCsv(`snap_counts/snap_counts_${s}.csv`),
      s === CURRENT ? getCsv(`injuries/injuries_${s}.csv`) : Promise.resolve(null),
    ]);
    if (!st) { console.log(`  ${s}: no weekly stats published yet`); continue; }
    const parsed = parseWeeklyStats(st);
    statRows.push(...parsed);
    if (sn) snapRows.push(...parseSnapCounts(sn));
    if (inj) injuries = parseInjuries(inj);
    const weeks = [...new Set(parsed.map((r) => `${r.season_type} ${r.week}`))];
    console.log(`  ${s}: ${parsed.length} player-games (${weeks.length} weeks: ${weeks.at(0)} → ${weeks.at(-1)}), ${sn?.length ?? 0} snap rows${inj ? `, ${injuries.length} injury rows` : ""}`);
  }

  // Merge snap share onto the player-game rows (PFR id → GSIS id).
  const snapsByKey = new Map();
  let snapUnmatched = 0;
  for (const s of snapRows) {
    const gsis = pfrToGsis.get(s.pfr_id);
    if (!gsis) { snapUnmatched++; continue; }
    snapsByKey.set(`${s.game_id}|${gsis}`, s);
  }
  let snapMatched = 0;
  for (const r of statRows) {
    const s = snapsByKey.get(`${r.game_id}|${r.player_id}`);
    if (!s) continue;
    snapMatched++;
    if (s.off_snaps != null) r.off_snaps = s.off_snaps;
    if (s.off_pct != null) r.off_pct = s.off_pct;
    if (s.def_pct != null) r.def_pct = s.def_pct;
  }
  statRows.sort((a, b) => a.season - b.season || a.week - b.week || a.game_id.localeCompare(b.game_id) || a.player_id.localeCompare(b.player_id));

  // Registry: players who appear in the window, plus their latest injury status.
  const inWindow = new Set(statRows.map((r) => r.player_id));
  for (const i of injuries) inWindow.add(i.player_id);
  const latestInjury = new Map();
  for (const i of injuries) {
    const prev = latestInjury.get(i.player_id);
    if (!prev || i.week > prev.week) latestInjury.set(i.player_id, i);
  }
  // Position as played (nflverse weekly) fills registry gaps.
  const lastSeen = new Map();
  for (const r of statRows) lastSeen.set(r.player_id, r);
  const registry = {};
  for (const id of [...inWindow].sort()) {
    const seen = lastSeen.get(id);
    const p = registryAll[id] ?? (seen ? { name: seen.name, position: seen.position, team: seen.team } : null);
    if (!p) continue;
    const inj = latestInjury.get(id);
    registry[id] = inj ? { ...p, injury: { week: inj.week, report_status: inj.report_status ?? null, practice_status: inj.practice_status ?? null, primary_injury: inj.primary_injury ?? null } } : p;
  }

  // Validation.
  const v = validateTeamGames(statRows);
  const gameIds = new Set(games.map((g) => g.game_id));
  const orphanGames = [...new Set(statRows.filter((r) => !gameIds.has(r.game_id)).map((r) => r.game_id))];
  const byGame = new Map(games.map((g) => [g.game_id, g]));
  const sideMismatch = statRows.filter((r) => { const g = byGame.get(r.game_id); return g && !((r.team === g.home && r.opponent === g.away) || (r.team === g.away && r.opponent === g.home)); }).length;
  console.log(`  validation: ${v.teamGames} team-games; receptions≠completions or rec yds≠pass yds in ${v.bad.length}; stat rows with no schedule game ${orphanGames.length}; team/opponent ≠ schedule ${sideMismatch}`);
  for (const b of v.bad.slice(0, 5)) console.log(`    ${b.key}: comp ${b.comp} rec ${b.rec} | pass ${b.pass_yds} rec ${b.rec_yds}`);
  console.log(`  snaps: ${snapMatched}/${statRows.length} player-games matched (${snapUnmatched} snap rows without a PFR→GSIS id)`);

  const fetched_at = new Date().toISOString();
  await fs.writeFile(path.join(ROOT, "data/nfl-games.json"), jsonLines({ fetched_at, seasons: SEASONS }, "games", games));
  // name/position/group are registry facts — strip them from the game rows.
  const slim = statRows.map(({ name, position, group, ...rest }) => rest);
  await fs.writeFile(path.join(ROOT, "data/nfl-player-games.json"), jsonLines({ fetched_at, seasons: SEASONS }, "rows", slim));
  await fs.writeFile(path.join(ROOT, "data/nfl-injuries.json"), jsonLines({ fetched_at, season: CURRENT }, "rows", injuries));
  await fs.writeFile(path.join(ROOT, "data/nfl-players.json"), JSON.stringify({ fetched_at, seasons: SEASONS, players: registry }) + "\n");
  const played = games.filter((g) => g.home_score != null && g.season === CURRENT).length;
  console.log(`Wrote ${games.length} games (${played} played in ${CURRENT}), ${statRows.length} player-games, ${Object.keys(registry).length} players, ${injuries.length} injury rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (v.bad.length || orphanGames.length || sideMismatch) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
