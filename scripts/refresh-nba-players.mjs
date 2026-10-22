// Rebuild the NBA player pool in data/players.json from the CURRENT ESPN
// team rosters (all 30 teams), replacing the playoff-only pool that
// refresh-playoff-players.mjs builds. Run at the start of each season and
// after the trade deadline.
//
// Sources:
//   - ESPN teams + teams/{id}/roster — PRIMARY. Every rostered player with
//     their ESPN athlete id (two-way and injured players included).
//   - stats.nba.com/playerindex — the PERSON_ID analyze.js requires for NBA.
//     Falls back to the id already in players.json (matched on ESPN id).
//
// Existing entries are matched on ESPN id and keep their key (the spelling
// PrizePicks resolves against) and bbref slug. NBA entries whose ESPN id is
// on no current roster are dropped (free agents, overseas, retired).
// WNBA entries are untouched.
//
// New entries come in with bbref: null — follow with
//   node scripts/build-bbref-ids.mjs --missing --league NBA
//
// Usage: node scripts/refresh-nba-players.mjs [--dry-run]
//        npm run refresh-nba-players

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PLAYER_INFO } from "../api/_lib/player-ids.js";
import { normalizeName as normName } from "../api/_lib/string-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYERS_JSON_PATH = path.join(ROOT, "data/players.json");

const TEAMS = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams";
const ROSTER = (id) => `${TEAMS}/${id}/roster`;

// NBA season label: Oct–Dec belong to the season that starts that year.
function currentNbaSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() + 1 >= 8 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const NBA_SEASON = currentNbaSeason();
const NBA_PLAYERINDEX =
  `https://stats.nba.com/stats/playerindex?LeagueID=00&Season=${NBA_SEASON}&Active=1&AllStar=&College=&Country=&DraftPick=&DraftRound=&DraftYear=&Height=&Historical=0&TeamID=0&Weight=`;

const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

// Generational suffixes differ across sources ("Jabari Smith Jr." on ESPN,
// "Jabari Smith" on stats.nba.com / PrizePicks, "Udeh, Jr." in the
// playerindex), so id matching strips them.
const SUFFIX_RE = /,?\s+(jr|sr|ii|iii|iv|v)\.?$/i;
const matchKey = (name) => normName(String(name).replace(SUFFIX_RE, ""));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      console.error(`  HTTP ${res.status} ${url.slice(0, 90)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`  fetch threw on ${url.slice(0, 80)}: ${err.message}`);
    return null;
  }
}

async function fetchEspnRosters() {
  const data = await jsonFetch(TEAMS);
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams?.map((t) => t.team) ?? [];
  const players = [];
  const failed = [];
  for (const t of teams) {
    const r = await jsonFetch(ROSTER(t.id));
    if (!r?.athletes) {
      failed.push(t.abbreviation);
      continue;
    }
    for (const a of r.athletes) {
      if (!a.id || !a.displayName) continue;
      players.push({ espn: Number(a.id), name: a.displayName, team_abbr: t.abbreviation });
    }
    await sleep(80);
  }
  return { teams, players, failed };
}

async function fetchNbaPlayerIndex() {
  const data = await jsonFetch(NBA_PLAYERINDEX, { headers: NBA_HEADERS });
  if (!data?.resultSets?.[0]) {
    console.warn("  stats.nba.com playerindex unavailable — new players need it for an NBA id");
    return new Map();
  }
  const rs = data.resultSets[0];
  const idIdx = rs.headers.indexOf("PERSON_ID");
  const firstIdx = rs.headers.indexOf("PLAYER_FIRST_NAME");
  const lastIdx = rs.headers.indexOf("PLAYER_LAST_NAME");
  const map = new Map();
  for (const row of rs.rowSet) {
    map.set(matchKey(`${row[firstIdx]} ${row[lastIdx]}`), row[idIdx]);
  }
  return map;
}

async function writePlayersJson(merged) {
  const sorted = Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))
  );
  await fs.writeFile(PLAYERS_JSON_PATH, JSON.stringify(sorted, null, 2) + "\n");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log("=== refresh-nba-players ===");
  console.log(`  season=${NBA_SEASON}${dryRun ? " (dry run)" : ""}`);

  console.log(`\n[1/3] fetching ESPN rosters...`);
  const { teams, players: rostered, failed } = await fetchEspnRosters();
  console.log(`  ${teams.length} teams, ${rostered.length} rostered players`);
  // A partial roster pull would drop every player on the missing teams.
  if (teams.length !== 30 || failed.length) {
    console.error(`  expected 30 full rosters (failed: ${failed.join(", ") || "team list"}) — bailing`);
    process.exit(1);
  }

  console.log(`\n[2/3] fetching stats.nba.com playerindex...`);
  const nbaIdByName = await fetchNbaPlayerIndex();
  console.log(`  ${nbaIdByName.size} players in index`);

  console.log(`\n[3/3] merging...`);
  const merged = {};
  const existingByEspn = new Map();
  for (const [name, info] of Object.entries(PLAYER_INFO)) {
    if ((info.league ?? "NBA") !== "NBA") {
      merged[name] = info;
      continue;
    }
    if (!existingByEspn.has(info.espn)) existingByEspn.set(info.espn, []);
    existingByEspn.get(info.espn).push(name);
  }

  const added = [];
  const kept = [];
  const missingNbaId = [];
  const idChanged = [];
  const rosteredEspn = new Set();
  for (const p of rostered) {
    rosteredEspn.add(p.espn);
    const indexId = nbaIdByName.get(matchKey(p.name)) ?? null;
    const priorNames = existingByEspn.get(p.espn) ?? [];
    if (priorNames.length) {
      // Keep every existing key (aliases PrizePicks may still publish).
      for (const n of priorNames) {
        const prior = PLAYER_INFO[n];
        if (indexId && prior.nba && indexId !== prior.nba) idChanged.push(`${n}: ${prior.nba} → ${indexId}`);
        merged[n] = { ...prior, nba: prior.nba ?? indexId, league: "NBA" };
        kept.push(n);
      }
      continue;
    }
    if (!indexId) {
      missingNbaId.push(p);
      continue;
    }
    merged[p.name] = { nba: indexId, espn: p.espn, bbref: null, league: "NBA" };
    added.push(p);
  }
  const dropped = [...existingByEspn.entries()]
    .filter(([espn]) => !rosteredEspn.has(espn))
    .flatMap(([, names]) => names);

  if (!dryRun) await writePlayersJson(merged);

  console.log("\n=== ADDED ===");
  for (const a of added.sort((x, y) => x.name.localeCompare(y.name))) {
    console.log(`  + ${a.name.padEnd(28)} ${a.team_abbr}`);
  }
  console.log("\n=== DROPPED (no longer on an NBA roster) ===");
  for (const n of dropped.sort()) console.log(`  - ${n}`);
  if (missingNbaId.length) {
    console.log("\n=== SKIPPED — no stats.nba.com id ===");
    for (const m of missingNbaId) console.log(`  ! ${m.name.padEnd(28)} espn=${m.espn} ${m.team_abbr}`);
  }
  if (idChanged.length) {
    console.log("\n=== NBA id differs from playerindex (kept existing) ===");
    for (const c of idChanged) console.log(`  ? ${c}`);
  }
  const nbaCount = Object.values(merged).filter((v) => (v.league ?? "NBA") === "NBA").length;
  console.log(`\n  kept ${kept.length}, added ${added.length}, dropped ${dropped.length}, skipped ${missingNbaId.length}`);
  console.log(`  NBA pool: ${nbaCount} | total: ${Object.keys(merged).length} (NBA + WNBA)`);
  if (added.length) console.log(`\nNext: node scripts/build-bbref-ids.mjs --missing --league NBA`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
