// Pull league-wide team defensive ratings from stats.nba.com and write
// data/team-defense.json. Production reads the JSON as a fallback when
// live fetches fail (Vercel egress IPs are often 403'd by stats.nba.com,
// but local laptops are not).
//
// Usage: node scripts/refresh-team-defense.mjs
//        npm run refresh-team-defense

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ABBR_BY_TEAM_ID as NBA_TEAM_ID_TO_ABBR } from "../api/lib/team-ids.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "data/team-defense.json");

const NBA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.nba.com",
  Referer: "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

function currentSeason(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const startYear = m >= 9 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

const DASH_DEFAULTS = {
  LastNGames: 0,
  LeagueID: "00",
  Month: 0,
  OpponentTeamID: 0,
  PaceAdjust: "N",
  PerMode: "PerGame",
  Period: 0,
  PlusMinus: "N",
  Rank: "N",
  DateFrom: "",
  DateTo: "",
  GameSegment: "",
  Location: "",
  Outcome: "",
  ShotClockRange: "",
  VsConference: "",
  VsDivision: "",
  TeamID: 0,
  Conference: "",
  Division: "",
  GameScope: "",
  PlayerExperience: "",
  PlayerPosition: "",
  StarterBench: "",
  TwoWay: 0,
};

async function fetchLeagueAdvanced(season, seasonType) {
  const params = new URLSearchParams({
    ...DASH_DEFAULTS,
    MeasureType: "Advanced",
    Season: season,
    SeasonType: seasonType,
  }).toString();
  const url = `https://stats.nba.com/stats/leaguedashteamstats?${params}`;
  const res = await fetch(url, {
    headers: NBA_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`stats.nba.com HTTP ${res.status} for ${seasonType}`);
  return res.json();
}

function parseLeagueDefense(payload) {
  const rs = payload?.resultSets?.find((r) => r.name === "LeagueDashTeamStats");
  if (!rs?.rowSet?.length) throw new Error("LeagueDashTeamStats result set empty");
  const headers = rs.headers;
  const idx = (name) => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error(`column ${name} missing from response`);
    return i;
  };
  const tIdIdx = idx("TEAM_ID");
  const tNameIdx = idx("TEAM_NAME");
  const tDefIdx = idx("DEF_RATING");

  const rows = rs.rowSet.map((row) => ({
    team_id: row[tIdIdx],
    team_name: row[tNameIdx],
    def_rating: row[tDefIdx],
  }));
  // Lower DEF_RATING is better → ascending sort gives rank 1 to top defense.
  rows.sort((a, b) => a.def_rating - b.def_rating);
  return rows.map((r, i) => ({ ...r, def_rank: i + 1 }));
}

async function buildSnapshot() {
  const season = currentSeason();
  const out = {
    season,
    fetched_at: new Date().toISOString(),
    seasons: {},
  };

  for (const seasonType of ["Regular Season", "Playoffs"]) {
    console.log(`Fetching ${seasonType}...`);
    let rows;
    try {
      const payload = await fetchLeagueAdvanced(season, seasonType);
      rows = parseLeagueDefense(payload);
    } catch (err) {
      console.error(`  ${seasonType}: ${err.message}`);
      if (seasonType === "Playoffs") {
        console.error("  (skipping playoffs — likely no games yet)");
        continue;
      }
      throw err;
    }
    const teams = {};
    for (const r of rows) {
      const abbr = NBA_TEAM_ID_TO_ABBR[r.team_id];
      if (!abbr) {
        console.error(`  warning: no abbr for team_id ${r.team_id} (${r.team_name})`);
        continue;
      }
      teams[abbr] = {
        team_id: r.team_id,
        team_name: r.team_name,
        def_rating: r.def_rating,
        def_rank: r.def_rank,
      };
    }
    out.seasons[seasonType] = teams;
    console.log(`  ${Object.keys(teams).length} teams`);
  }
  return out;
}

async function main() {
  console.log("=== refresh-team-defense ===");
  const snapshot = await buildSnapshot();
  await fs.writeFile(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
