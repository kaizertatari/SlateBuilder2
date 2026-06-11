// Scrape PrizePicks NBA + WNBA projections and output structured JSON.
// Filters to upcoming games (start_time >= now) and matches player names
// to players.json.
//
// Usage: node scripts/scrape-prizepicks.mjs
//         npm run refresh-prizepicks

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";
import { mapPrizePicksStatType } from "../api/_lib/prop-types.js";
import { loadEnvLocal } from "./_env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = path.join(ROOT, "data/prizepicks-lines.json");
const PLAYERS_JSON = path.join(ROOT, "data/players.json");

const PRIZEPICKS_API = "https://api.prizepicks.com/projections";

// PrizePicks league IDs. Add more entries here if PrizePicks publishes more
// leagues we want to cover; everything downstream is league-aware.
//
// NOTE: PrizePicks' league IDs are unrelated to stats.wnba.com's LeagueID
// ("10" there). Verified against api.prizepicks.com/leagues: WNBA=3, NBA=7,
// WORLD CUP=241 (the per-match board; 457 "WORLD CUP TRNY" is tournament-long
// futures and out of scope — WC_FRAMEWORK_SPEC.md §9).
//
// `stats` (optional) — canonical stat whitelist for the league; projections
// whose stat_type doesn't map into it are dropped at scrape time. WC covers
// the v1 pair plus the v2 expansion (WC_FRAMEWORK_SPEC.md §10); the
// whitelist still keeps ~4k fouls/cards/offsides projections out of the
// snapshot.
const LEAGUES = [
  { league: "NBA", league_id: 7 },
  { league: "WNBA", league_id: 3 },
  { league: "WC", league_id: 241, stats: [
    "Shots", "Shots On Target", "Tackles", "Goalie Saves", "Clearances",
    "Passes Attempted", "Outfield Fantasy Score",
  ] },
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept": "application/json",
  "Referer": "https://app.prizepicks.com/",
  "Accept-Language": "en-US,en;q=0.9",
};

// Name normalization (matches players.json format) is the shared
// normalizeName from api/_lib/string-utils.js — same canonicalization the
// odds scrape and runtime lookups use, so all three agree on a key.

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

async function scrapePrizePicksForLeague(leagueId) {
  const url = `${PRIZEPICKS_API}?league_id=${leagueId}&per_page=250&single_stat=true`;
  // PP rate-limits bursts (429) — with three leagues scraped back-to-back a
  // single retry after a cooldown recovers the slate instead of dropping a
  // whole league from the snapshot.
  let data = await jsonFetch(url, { headers: HEADERS });
  if (!data) {
    console.log(`  league_id=${leagueId} fetch failed — retrying in 15s...`);
    await new Promise((r) => setTimeout(r, 15000));
    data = await jsonFetch(url, { headers: HEADERS });
  }
  if (!data) throw new Error(`Failed to fetch PrizePicks API (league_id=${leagueId})`);

  // Build player lookup from "included" array (includes name AND team)
  const playersById = {};
  const included = data.included || [];
  for (const item of included) {
    if (item.type === "new_player" && item.id && item.attributes?.name) {
      playersById[item.id] = {
        name: item.attributes.name,
        team: item.attributes.team || null,
        team_name: item.attributes.team_name || null,
        // Soccer carries a useful position label (Forward/Midfielder/
        // Defender/Goalkeeper) — basketball sometimes has one too; passed
        // through for league-aware consumers (WC position priors + GK gate).
        position: item.attributes.position || null,
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
        player_position: playerInfo.position,
        opponent: attrs.description || null,
        stat_type: attrs.stat_type || null,
        line_score: attrs.line_score ?? null,
        start_time: attrs.start_time || null,
        status: attrs.status || null,
        odds_type: attrs.odds_type || null,
        // Promo rows (free squares / flash sales) aren't real lines. NOTE:
        // event_type is NOT a usable filter — PP marks every soccer
        // projection event_type:"team", including ordinary player props.
        is_promo: attrs.is_promo === true,
      };
    })
    .filter((p) => p.player_name && p.stat_type && p.line_score != null && p.opponent);

  return projections;
}

// Resolve a PrizePicks player name against the players.json lookup. The
// lookup is league-scoped: a "Caitlin Clark" entry tagged league:"WNBA"
// only resolves for WNBA scrape projections, even if a future NBA player
// shared the name. Combo entries like "Cade Cunningham + James Harden" try
// each component individually and return the first league-matching match.
function resolvePlayer(rawName, nameLookup, league) {
  const direct = nameLookup[normalizeName(rawName)];
  if (direct && direct.league === league) return direct;
  if (!rawName.includes("+")) return null;
  for (const part of rawName.split("+")) {
    const hit = nameLookup[normalizeName(part)];
    if (hit && hit.league === league) return hit;
  }
  return null;
}

// ─── Main Export Function ──────────────────────────────────────────────────

// opts.write (default true) — write the result to OUTPUT. Set false when
// calling from a server context where the bundle FS is read-only.
// opts.outputPath — override OUTPUT (e.g. "/tmp/prizepicks-lines.json").
// opts.leagues — override LEAGUES (e.g. scrape just one league).
export async function scrapePrizePicksForToday(opts = {}) {
  const { write = true, outputPath = OUTPUT, leagues = LEAGUES } = opts;

  // Load players.json and build normalized lookup. Lookup carries the league
  // so we don't accidentally match an NBA player to a WNBA prop (or vice
  // versa) when the two leagues coincide on a name.
  let playerInfo = {};
  try {
    const raw = await fs.readFile(PLAYERS_JSON, "utf8");
    playerInfo = JSON.parse(raw);
  } catch {
    console.warn("  Warning: Could not load data/players.json");
  }

  const nameLookup = {};
  for (const [name, ids] of Object.entries(playerInfo)) {
    nameLookup[normalizeName(name)] = {
      name,
      nba: ids.nba,
      espn: ids.espn,
      league: ids.league ?? "NBA",
    };
  }

  // Keep any projection whose game hasn't tipped yet. Calendar-date filtering
  // breaks around midnight UTC: tip-offs span the UTC day boundary, so a
  // "today UTC" filter drops either the early or late slate depending on
  // when the cron fired. `start_time >= nowMs` naturally picks up tomorrow's
  // slate as soon as PrizePicks posts it.
  const nowMs = Date.now();
  console.log(`  Filtering for games with start_time >= ${new Date(nowMs).toISOString()}...`);

  // Scrape each league sequentially. Tag every projection with `league` for
  // downstream consumers. Combined output keeps NBA + WNBA props under the
  // same `by_player` / `games` maps so the analyze-all path stays simple.
  const gamesOutput = {};
  const byPlayer = {};
  let totalProps = 0;
  const perLeague = {};

  let firstLeague = true;
  for (const { league, league_id, stats } of leagues) {
    // Courtesy gap between league fetches — see 429 note in
    // scrapePrizePicksForLeague.
    if (!firstLeague) await new Promise((r) => setTimeout(r, 3000));
    firstLeague = false;
    console.log(`  Fetching PrizePicks ${league} (league_id=${league_id}) projections...`);
    let projections;
    try {
      projections = await scrapePrizePicksForLeague(league_id);
    } catch (err) {
      console.error(`  ! ${league} scrape failed: ${err.message}`);
      perLeague[league] = { total_props: 0, error: err.message };
      continue;
    }
    console.log(`  Got ${projections.length} total ${league} projections`);

    const allowedStats = Array.isArray(stats) && stats.length ? new Set(stats) : null;
    let leagueProps = 0;
    for (const proj of projections) {
      // Promo rows (free squares / discounted flash lines) aren't real lines.
      if (proj.is_promo) continue;
      // Per-league stat whitelist (canonical names) — see LEAGUES above.
      if (allowedStats && !allowedStats.has(mapPrizePicksStatType(proj.stat_type))) continue;
      // Filter by start_time — only include if the game hasn't tipped yet.
      if (!proj.start_time) continue;
      const startMs = Date.parse(proj.start_time);
      if (!Number.isFinite(startMs) || startMs < nowMs) continue;

      const playerTeamRaw = proj.player_team || "";
      const opponentRaw = proj.opponent || "";

      // Handle combo players like "CLE/DET" — take first team.
      const playerTeam = playerTeamRaw.split("/")[0].trim();
      const opponent = opponentRaw.split("/")[0].trim();

      if (!playerTeam || !opponent) continue;

      // Prefix non-NBA games to disambiguate cross-league key clashes
      // (WNBA keys keep their existing "WNBA:" form; WC gets "WC:").
      const gameKey = league === "NBA"
        ? `${opponent}@${playerTeam}`
        : `${league}:${opponent}@${playerTeam}`;
      const matched = resolvePlayer(proj.player_name, nameLookup, league);

      const prop = {
        player: proj.player_name,
        league,
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
        // Soccer-only (null for basketball): PP position label, used by the
        // WC gatherer for position priors and the goalkeeper gate.
        player_position: proj.player_position ?? null,
      };

      if (!gamesOutput[gameKey]) {
        // NOTE: `home`/`away` are perspective labels (player's team /
        // opponent), NOT actual venue — PrizePicks projections don't say
        // who hosts. Keys kept for snapshot-schema stability; nothing
        // downstream reads them as venue.
        gamesOutput[gameKey] = { league, home: playerTeam, away: opponent, props: [] };
      }
      gamesOutput[gameKey].props.push(prop);

      const key = matched ? matched.name : proj.player_name;
      if (!byPlayer[key]) byPlayer[key] = [];
      byPlayer[key].push(prop);

      totalProps++;
      leagueProps++;
    }
    perLeague[league] = { total_props: leagueProps };
  }

  const result = {
    fetched_at: new Date().toISOString(),
    games: gamesOutput,
    by_player: byPlayer,
    total_props: totalProps,
    total_players: Object.keys(byPlayer).length,
    leagues: perLeague,
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
      for (const [league, stats] of Object.entries(result.leagues ?? {})) {
        console.log(`  ${league}: ${stats.total_props ?? 0} props${stats.error ? ` (error: ${stats.error})` : ""}`);
      }
    })
    .catch((e) => {
      console.error("Fatal:", e.message);
      process.exit(1);
    });
}
