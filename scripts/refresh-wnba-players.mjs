// Enumerate the active WNBA player pool, look up wnba+espn IDs, and merge
// the resulting entries into data/players.json with league: "WNBA".
//
// Sources:
//   - ESPN scoreboard + summary (last 30 days) — PRIMARY. Yields ESPN
//     athlete IDs and current team_abbr per player.
//   - stats.wnba.com/playerindex (LeagueID=10) — BEST-EFFORT enrichment.
//     Adds the WNBA stats edge PERSON_ID when available; the endpoint often
//     503s from cloud egress so we never block on it.
//
// Each WNBA entry is shaped:
//   { nba: <wnba stats edge id|null>, espn: <espn id>, bbref: null,
//     team_abbr: "LV", league: "WNBA" }
//
// team_abbr is embedded so analyze.js can resolve WNBA players without a
// stats edge round-trip on every request. Re-run this script after the trade
// deadline to refresh.
//
// Designed to be additive: NBA entries already in players.json are
// preserved, and any pre-existing WNBA entries are refreshed in place.
//
// Usage: node scripts/refresh-wnba-players.mjs
//        npm run refresh-wnba-players

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PLAYER_INFO } from "../api/_lib/player-ids.js";
import { normalizeName as normName } from "../api/_lib/string-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYERS_JSON_PATH = path.join(ROOT, "data/players.json");

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard";
const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary";

// WNBA season is a single calendar year. PlayerIndex needs the current year.
function currentWnbaSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return String(m >= 5 ? y : y - 1);
}

const WNBA_SEASON = currentWnbaSeason();

// ESPN-form abbreviations for the 15 WNBA franchises (2026: 13 holdovers +
// Portland Fire and Toronto Tempo expansion). Filters out national-team
// exhibition rosters (JPN, NIGER, …) that show up in preseason box scores
// before the regular season starts.
const WNBA_TEAM_ABBRS = new Set([
  "ATL", "CHI", "CON", "DAL", "GS", "IND", "LA", "LV",
  "MIN", "NY", "PHX", "SEA", "WSH", "POR", "TOR",
]);
const WNBA_PLAYERINDEX =
  `https://stats.wnba.com/stats/playerindex?LeagueID=10&Season=${WNBA_SEASON}&Active=1&AllStar=&College=&Country=&DraftPick=&DraftRound=&DraftYear=&Height=&Historical=0&TeamID=0&Weight=`;

// 30 calendar days covers regular-season cadence (most teams play ~3
// games/week) and bridges the early-season ramp where some players haven't
// suited up yet. Players with 0 box scores in the window can't be resolved
// to an ESPN ID — they'll be added later when they next play.
const LOOKBACK_DAYS = 30;
const MIN_MINUTES = 1; // minimum minutes across the window to be included

const WNBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Referer: "https://www.wnba.com/",
  Origin: "https://www.wnba.com",
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

async function enumerateRecentEvents() {
  const events = [];
  const today = new Date();
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const data = await jsonFetch(`${SCOREBOARD}?dates=${fmtYYYYMMDD(d)}`);
    if (!data?.events) continue;
    for (const e of data.events) {
      const state = e.status?.type?.state;
      if (state !== "post") continue; // only completed games have box scores
      events.push({ id: e.id, date: e.date, state });
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
        team_abbr: teamAbbr,
        minutes,
      });
    }
  }
  return out;
}

async function fetchWnbaPlayerIndex() {
  const data = await jsonFetch(WNBA_PLAYERINDEX, { headers: WNBA_HEADERS });
  if (!data?.resultSets?.[0]) {
    console.warn("  stats.wnba.com playerindex unavailable — continuing with ESPN-only IDs");
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
    map.set(normName(`${first} ${last}`), { id, full: `${first} ${last}` });
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
  console.log("=== refresh-wnba-players ===");
  console.log(`  season=${WNBA_SEASON}`);

  console.log(`\n[1/4] fetching stats.wnba.com playerindex (best-effort)...`);
  const wnbaIdByName = await fetchWnbaPlayerIndex();
  console.log(`  ${wnbaIdByName.size} players in stats.wnba.com index`);

  console.log(`\n[2/4] enumerating WNBA games in last ${LOOKBACK_DAYS} days...`);
  const events = await enumerateRecentEvents();
  console.log(`  ${events.length} completed games found`);
  if (!events.length) {
    console.error("  no completed games found — WNBA season may not have started yet");
    if (!wnbaIdByName.size) {
      console.error("  AND playerindex is empty — nothing to merge. Bailing.");
      process.exit(1);
    }
  }

  console.log(`\n[3/4] aggregating players across box scores...`);
  // Keep the max-minutes appearance per player to capture their current team
  // (most recent stint = highest minute count over the 30-day window).
  const byEspnId = new Map();
  for (const ev of events) {
    const players = await extractPlayersFromEvent(ev.id);
    for (const p of players) {
      const prior = byEspnId.get(p.espn_id);
      if (!prior || prior.minutes < p.minutes) byEspnId.set(p.espn_id, p);
    }
    await sleep(80);
  }
  const eligible = [...byEspnId.values()].filter(
    (p) => p.minutes >= MIN_MINUTES && WNBA_TEAM_ABBRS.has(p.team_abbr)
  );
  const droppedNonWnba = [...byEspnId.values()].filter(
    (p) => p.minutes >= MIN_MINUTES && !WNBA_TEAM_ABBRS.has(p.team_abbr)
  );
  console.log(`  ${byEspnId.size} unique players appeared, ${eligible.length} cleared >=${MIN_MINUTES} min on a WNBA roster`);
  if (droppedNonWnba.length) {
    const teamCounts = {};
    for (const p of droppedNonWnba) teamCounts[p.team_abbr] = (teamCounts[p.team_abbr] || 0) + 1;
    console.log(`  ${droppedNonWnba.length} dropped as non-WNBA exhibition entries:`,
      Object.entries(teamCounts).map(([t, n]) => `${t}=${n}`).join(", "));
  }

  console.log(`\n[4/4] merging into players.json...`);
  const merged = { ...PLAYER_INFO };

  // Prune stale WNBA entries from prior runs that landed on a non-WNBA team
  // (national-team exhibition rosters). NBA entries are untouched.
  let pruned = 0;
  for (const [name, info] of Object.entries(merged)) {
    if (info?.league === "WNBA" && info.team_abbr && !WNBA_TEAM_ABBRS.has(info.team_abbr)) {
      delete merged[name];
      pruned++;
    }
  }
  if (pruned) console.log(`  pruned ${pruned} stale non-WNBA exhibition entries`);

  let added = 0;
  let updated = 0;
  let withWnbaId = 0;

  for (const p of eligible) {
    const wnbaHit = wnbaIdByName.get(normName(p.name));
    const wnbaId = wnbaHit?.id ?? null;
    if (wnbaId) withWnbaId++;

    const existing = merged[p.name];
    const next = {
      nba: wnbaId ?? existing?.nba ?? null,
      espn: Number(p.espn_id),
      bbref: existing?.bbref ?? null,
      team_abbr: p.team_abbr ?? existing?.team_abbr ?? null,
      league: "WNBA",
    };

    if (existing) {
      if (existing.nba !== next.nba || existing.espn !== next.espn ||
          existing.team_abbr !== next.team_abbr || existing.league !== "WNBA") {
        updated++;
      }
    } else {
      added++;
    }
    merged[p.name] = next;
  }

  await writePlayersJson(merged);

  console.log(`\n  added: ${added}`);
  console.log(`  updated: ${updated}`);
  console.log(`  with stats.wnba.com PERSON_ID: ${withWnbaId}/${eligible.length}`);
  console.log(`\nFinal total: ${Object.keys(merged).length} players (NBA + WNBA combined)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
