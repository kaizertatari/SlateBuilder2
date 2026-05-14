// Scrape PrizePicks NBA projections and output structured JSON.
// Filters to upcoming games (start_time >= now) and matches player names
// to players.json.
//
// Usage: node scripts/scrape-prizepicks.mjs
//         npm run refresh-prizepicks

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvLocal } from "./_env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/prizepicks-lines.json");
const PLAYERS_JSON = path.join(ROOT, "data/players.json");

const PRIZEPICKS_API = "https://api.prizepicks.com/projections";
const NBA_LEAGUE_ID = 7;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://app.prizepicks.com/",
  "Accept-Language": "en-US,en;q=0.9",
};

// ─── Name Normalization (matches players.json format) ───────────────────────

function normalizeName(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[.'’\-]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Fetch Helpers ──────────────────────────────────────────────────────────

async function jsonFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
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

// ─── Scrape PrizePicks ─────────────────────────────────────────────────────

async function scrapePrizePicks() {
  const url = `${PRIZEPICKS_API}?league_id=${NBA_LEAGUE_ID}&per_page=250&single_stat=true`;
  const data = await jsonFetch(url, { headers: HEADERS });
  if (!data) throw new Error("Failed to fetch PrizePicks API");

  // Build player lookup from "included" array (includes name AND team)
  const playersById = {};
  const included = data.included || [];
  for (const item of included) {
    if (item.type === "new_player" && item.id && item.attributes?.name) {
      playersById[item.id] = {
        name: item.attributes.name,
        team: item.attributes.team || null,
        team_name: item.attributes.team_name || null,
      };
    }
  }

  // Parse projections from "data" array
  const projections = (data.data || [])
    .filter((d) => d.type === "projection")
    .map((d) => {
      const attrs = d.attributes || {};
      const playerId = d.relationships?.new_player?.data?.id;
      const playerInfo = playersById[playerId];
      if (!playerInfo) return null;
      return {
        player_name: playerInfo.name,
        player_team: playerInfo.team,
        opponent: attrs.description || null,
        stat_type: attrs.stat_type || null,
        line_score: attrs.line_score ?? null,
        start_time: attrs.start_time || null,
        status: attrs.status || null,
        odds_type: attrs.odds_type || null,
      };
    })
    .filter((p) => p.player_name && p.stat_type && p.line_score != null && p.opponent);

  return projections;
}

// Resolve a PrizePicks player name against the players.json lookup.
// Combo entries like "Cade Cunningham + James Harden" try each component
// individually and return the first match.
function resolvePlayer(rawName, nameLookup) {
  const direct = nameLookup[normalizeName(rawName)];
  if (direct) return direct;
  if (!rawName.includes("+")) return null;
  for (const part of rawName.split("+")) {
    const hit = nameLookup[normalizeName(part)];
    if (hit) return hit;
  }
  return null;
}

// ─── Main Export Function ──────────────────────────────────────────────────

// opts.write (default true) — write the result to OUTPUT. Set false when
// calling from a server context where the bundle FS is read-only.
// opts.outputPath — override OUTPUT (e.g. "/tmp/prizepicks-lines.json").
export async function scrapePrizePicksForToday(opts = {}) {
  const { write = true, outputPath = OUTPUT } = opts;

  // Load players.json and build normalized lookup
  let playerInfo = {};
  try {
    const raw = await fs.readFile(PLAYERS_JSON, "utf8");
    playerInfo = JSON.parse(raw);
  } catch {
    console.warn("  Warning: Could not load data/players.json");
  }

  const nameLookup = {};
  for (const [name, ids] of Object.entries(playerInfo)) {
    nameLookup[normalizeName(name)] = { name, nba: ids.nba, espn: ids.espn };
  }

  // Keep any projection whose game hasn't tipped yet. Calendar-date
  // filtering broke around midnight UTC: NBA tip-offs span the UTC day
  // boundary, so a "today UTC" filter would drop either the early or the
  // late slate depending on when the cron fired. `start_time >= nowMs`
  // naturally picks up tomorrow's slate as soon as PrizePicks posts it.
  const nowMs = Date.now();
  console.log(`  Filtering for games with start_time >= ${new Date(nowMs).toISOString()}...`);

  // Scrape PrizePicks
  console.log("  Fetching PrizePicks projections...");
  const projections = await scrapePrizePicks();
  console.log(`  Got ${projections.length} total projections`);

  // Filter to upcoming games by start_time and match players
  const gamesOutput = {};
  const byPlayer = {};
  let totalProps = 0;

  for (const proj of projections) {
    // Filter by start_time - only include if the game hasn't tipped yet.
    if (!proj.start_time) continue;
    const startMs = Date.parse(proj.start_time);
    if (!Number.isFinite(startMs) || startMs < nowMs) continue;

    const playerTeamRaw = proj.player_team || "";
    const opponentRaw = proj.opponent || "";

    // Handle combo players like "CLE/DET" - take first team
    const playerTeam = playerTeamRaw.split("/")[0].trim();
    const opponent = opponentRaw.split("/")[0].trim();

    if (!playerTeam || !opponent) continue;

    const gameKey = `${opponent}@${playerTeam}`;
    const matched = resolvePlayer(proj.player_name, nameLookup);

    const prop = {
      player: proj.player_name,
      stat_type: proj.stat_type,
      line: proj.line_score,
      odds_type: proj.odds_type,
      player_team: playerTeam,
      opponent,
      description: `${playerTeam} vs ${opponent}`,
      start_time: proj.start_time,
      player_key: matched?.name ?? null,
      nba_id: matched?.nba ?? null,
      espn_id: matched?.espn ?? null,
    };

    if (!gamesOutput[gameKey]) {
      gamesOutput[gameKey] = { home: playerTeam, away: opponent, props: [] };
    }
    gamesOutput[gameKey].props.push(prop);

    const key = matched ? matched.name : proj.player_name;
    if (!byPlayer[key]) byPlayer[key] = [];
    byPlayer[key].push(prop);

    totalProps++;
  }

  const result = {
    fetched_at: new Date().toISOString(),
    games: gamesOutput,
    by_player: byPlayer,
    total_props: totalProps,
    total_players: Object.keys(byPlayer).length,
  };

  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`  Written to ${path.relative(ROOT, outputPath)}`);
  }

  return result;
}

// ─── CLI Entrypoint ────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvLocal();
  scrapePrizePicksForToday()
    .then((result) => {
      console.log(`\nDone: ${result.total_props} props for ${result.total_players} players`);
    })
    .catch((e) => {
      console.error("Fatal:", e.message);
      process.exit(1);
    });
}
