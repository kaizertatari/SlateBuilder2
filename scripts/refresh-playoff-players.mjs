// Enumerate the active 2026 NBA playoff player pool, look up nba+espn IDs,
// and rewrite api/lib/player-ids.js + src/App.jsx with the merged set.
//
// Sources:
//   - ESPN scoreboard (last 14 days, RD16/RD8/RD4/RD2 events)
//   - ESPN summary (boxscore minutes per player)
//   - stats.nba.com/playerindex (one call → name → PERSON_ID map)
//   - ESPN search (audit existing roster against current team)
//
// Usage: node scripts/refresh-playoff-players.mjs
//        npm run refresh-players

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PLAYER_INFO } from "../api/lib/player-ids.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYER_IDS_PATH = path.join(ROOT, "api/lib/player-ids.js");
const APP_JSX_PATH = path.join(ROOT, "src/App.jsx");

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary";
const SEARCH = "https://site.web.api.espn.com/apis/search/v2";
const NBA_PLAYERINDEX =
  "https://stats.nba.com/stats/playerindex?LeagueID=00&Season=2025-26&Active=1&AllStar=&College=&Country=&DraftPick=&DraftRound=&DraftYear=&Height=&Historical=0&TeamID=0&Weight=";

const PLAYOFF_ABBRS = new Set(["RD16", "RD8", "RD4", "RD2"]);
const MIN_MINUTES = 10;
const LOOKBACK_DAYS = 14;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

function normName(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function parseMinutes(min) {
  if (min == null) return 0;
  if (typeof min === "number") return min;
  const m = String(min).match(/^(\d+)(?::(\d+))?$/);
  if (!m) return 0;
  return Number(m[1]) + Number(m[2] || 0) / 60;
}

async function enumeratePlayoffEvents() {
  const events = [];
  const today = new Date();
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const data = await jsonFetch(`${SCOREBOARD}?dates=${fmtYYYYMMDD(d)}`);
    if (!data?.events) continue;
    for (const e of data.events) {
      const comp = e.competitions?.[0];
      const round = comp?.type?.abbreviation;
      if (!round || !PLAYOFF_ABBRS.has(round)) continue;
      const state = e.status?.type?.state;
      events.push({ id: e.id, round, date: e.date, state });
    }
    await sleep(80);
  }
  return events;
}

async function extractPlayersFromEvent(eventId) {
  const data = await jsonFetch(`${SUMMARY}?event=${eventId}`);
  if (!data) return [];
  const out = [];
  for (const teamGroup of data.boxscore?.players || []) {
    const teamId = teamGroup.team?.id;
    const teamAbbr = teamGroup.team?.abbreviation;
    const stats = teamGroup.statistics?.[0];
    const labels = stats?.labels || [];
    const minIdx = labels.indexOf("MIN");
    for (const a of stats?.athletes || []) {
      const name = a.athlete?.displayName;
      const espnId = a.athlete?.id;
      if (!name || !espnId) continue;
      const minStr = minIdx >= 0 ? a.stats?.[minIdx] : null;
      const minutes = parseMinutes(minStr);
      out.push({
        espn_id: String(espnId),
        name,
        team_id: String(teamId),
        team_abbr: teamAbbr,
        minutes,
      });
    }
  }
  return out;
}

async function fetchNbaPlayerIndex() {
  const data = await jsonFetch(NBA_PLAYERINDEX, { headers: NBA_HEADERS });
  if (!data?.resultSets?.[0]) {
    console.error("  ! stats.nba.com/playerindex returned nothing — NBA ids unavailable");
    return new Map();
  }
  const rs = data.resultSets[0];
  const idIdx = rs.headers.indexOf("PERSON_ID");
  const firstIdx = rs.headers.indexOf("PLAYER_FIRST_NAME");
  const lastIdx = rs.headers.indexOf("PLAYER_LAST_NAME");
  const map = new Map();
  for (const row of rs.rowSet) {
    const id = row[idIdx];
    const first = row[firstIdx];
    const last = row[lastIdx];
    map.set(normName(`${first} ${last}`), id);
  }
  return map;
}

async function espnSearch(name) {
  const data = await jsonFetch(
    `${SEARCH}?query=${encodeURIComponent(name)}&type=player&limit=5`
  );
  const players = data?.results?.find((r) => r.type === "player")?.contents ?? [];
  const match =
    players.find(
      (p) =>
        p.sport === "basketball" &&
        p.defaultLeagueSlug === "nba" &&
        p.displayName?.toLowerCase() === name.toLowerCase()
    ) ?? players.find((p) => p.sport === "basketball" && p.defaultLeagueSlug === "nba");
  if (!match) return null;
  const espnId = match.uid?.match(/a:(\d+)/)?.[1] ?? null;
  return { team: match.subtitle ?? null, espnId };
}

async function writePlayerIds(merged) {
  const sorted = Object.entries(merged).sort(([a], [b]) => a.localeCompare(b));
  const maxName = Math.max(...sorted.map(([n]) => n.length));
  const lines = sorted.map(([name, ids]) => {
    const padded = `"${name}":`.padEnd(maxName + 4);
    return `  ${padded} { nba: ${ids.nba}, espn: ${ids.espn} },`;
  });
  const content = `// Display name -> { nba: stats.nba.com PERSON_ID, espn: ESPN athlete id }.
// Names match src/App.jsx NBA_PLAYERS exactly.
//
// Regenerate via: node scripts/refresh-playoff-players.mjs
// Players omitted here resolve to null and the orchestrator returns SKIP
// with a clear flag.

export const PLAYER_INFO = {
${lines.join("\n")}
};

// Back-compat helper used by analyze.js + smoke scripts.
export function resolvePlayerId(name) {
  return PLAYER_INFO[name]?.nba ?? null;
}

export function resolveEspnId(name) {
  return PLAYER_INFO[name]?.espn ?? null;
}

// Legacy export retained for build-espn-ids.mjs and any other consumers
// that just want { name: nba_id }.
export const PLAYER_IDS = Object.fromEntries(
  Object.entries(PLAYER_INFO).map(([k, v]) => [k, v.nba])
);
`;
  await fs.writeFile(PLAYER_IDS_PATH, content);
}

async function patchAppJsx(allNames) {
  const sorted = [...new Set(allNames)].sort();
  const lines = [];
  for (let i = 0; i < sorted.length; i += 4) {
    const row = sorted.slice(i, i + 4).map((n) => `"${n}"`).join(", ");
    lines.push("  " + row + (i + 4 < sorted.length ? "," : ""));
  }
  const block = `const NBA_PLAYERS = [\n${lines.join("\n")}\n];`;
  const current = await fs.readFile(APP_JSX_PATH, "utf8");
  const updated = current.replace(/const NBA_PLAYERS = \[[\s\S]*?\];/, block);
  await fs.writeFile(APP_JSX_PATH, updated);
}

async function main() {
  console.log("=== refresh-playoff-players ===");

  console.log(`\n[1/5] enumerating playoff events from last ${LOOKBACK_DAYS} days...`);
  const events = await enumeratePlayoffEvents();
  console.log(`  ${events.length} playoff events found`);
  if (!events.length) {
    console.error("  no playoff events found — bailing");
    process.exit(1);
  }

  console.log(`\n[2/5] extracting players with >= ${MIN_MINUTES} min from box scores...`);
  const byEspnId = new Map();
  for (const ev of events) {
    if (ev.state !== "post") continue;
    const players = await extractPlayersFromEvent(ev.id);
    for (const p of players) {
      const prior = byEspnId.get(p.espn_id);
      if (!prior || prior.minutes < p.minutes) byEspnId.set(p.espn_id, p);
    }
    await sleep(80);
  }
  const eligible = [...byEspnId.values()].filter((p) => p.minutes >= MIN_MINUTES);
  console.log(
    `  ${byEspnId.size} unique players appeared, ${eligible.length} cleared >=${MIN_MINUTES} min`
  );

  console.log(`\n[3/5] fetching stats.nba.com playerindex...`);
  const nbaIdByName = await fetchNbaPlayerIndex();
  console.log(`  ${nbaIdByName.size} active NBA players in index`);

  const merged = { ...PLAYER_INFO };
  const existingEspnIds = new Set(Object.values(PLAYER_INFO).map((v) => String(v.espn)));
  const newAdds = [];
  const missingNbaId = [];
  for (const p of eligible) {
    if (existingEspnIds.has(p.espn_id)) continue;
    const nbaId = nbaIdByName.get(normName(p.name));
    if (!nbaId) {
      missingNbaId.push({ name: p.name, espn: p.espn_id, team: p.team_abbr });
      continue;
    }
    merged[p.name] = { nba: nbaId, espn: Number(p.espn_id) };
    newAdds.push({
      name: p.name,
      team: p.team_abbr,
      maxMin: p.minutes.toFixed(1),
    });
  }

  console.log(`\n[4/5] auditing ${Object.keys(PLAYER_INFO).length} existing entries...`);
  const audit = [];
  for (const name of Object.keys(PLAYER_INFO).sort()) {
    const r = await espnSearch(name);
    if (!r) audit.push({ name, status: "no ESPN match" });
    else audit.push({ name, status: "ok", team: r.team });
    await sleep(120);
  }

  console.log(`\n[5/5] writing player-ids.js + App.jsx...`);
  await writePlayerIds(merged);
  await patchAppJsx(Object.keys(merged));

  console.log("\n=== ADDED ===");
  for (const a of newAdds.sort((x, y) => x.name.localeCompare(y.name))) {
    console.log(`  + ${a.name.padEnd(28)} ${String(a.team).padEnd(5)} max=${a.maxMin}min`);
  }
  console.log(`  total added: ${newAdds.length}`);

  if (missingNbaId.length) {
    console.log("\n=== MISSING NBA STATS ID (skipped) ===");
    for (const m of missingNbaId) {
      console.log(`  ! ${m.name.padEnd(28)} espn=${m.espn} team=${m.team}`);
    }
  }

  console.log("\n=== AUDIT (existing entries) ===");
  for (const a of audit) {
    if (a.status === "ok") console.log(`  ok    ${a.name.padEnd(28)} ${a.team ?? ""}`);
    else console.log(`  WARN  ${a.name.padEnd(28)} ${a.status}`);
  }

  console.log(`\nFinal total: ${Object.keys(merged).length} players`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
