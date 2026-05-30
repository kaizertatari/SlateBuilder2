// Scrape DraftKings player-prop O/U markets + game lines and emit no-vig fair
// probabilities. v1: WNBA (league 94682). Runs from a residential IP (same
// constraint as the PrizePicks scrape — cloud IPs get Akamai-403'd; the new
// "nash" sportscontent API works from home).
//
// Usage: node scripts/scrape-odds.mjs   |   npm run refresh-odds
//
// Output (data/odds.json):
//   { fetched_at, league, source, games:{ "AWAY@HOME": {...total/spread} },
//     by_player:{ "<name>": [ { stat, line, over_american, under_american,
//                               fair_over, team, opponent, game, start_time } ] } }

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devigTwoWay, parseAmerican } from "../api/lib/odds.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/odds.json");

const NASH = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusil/v1/leagues";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://sportsbook.draftkings.com/",
};

const LEAGUES = { WNBA: 94682, NBA: 42648 };

// DK O/U subcategories → our canonical stat names (api/lib/prop-types STATS).
// Subcategory IDs are global DK market-type ids (shared NBA/WNBA).
const OU_SUBCATS = [
  { stat: "Points", cat: 1215, sub: 12488 },
  { stat: "Rebounds", cat: 1216, sub: 12492 },
  { stat: "Assists", cat: 1217, sub: 12495 },
  { stat: "3-Pointers Made", cat: 1218, sub: 12497 },
  { stat: "PRA", cat: 583, sub: 5001 },
  { stat: "PA", cat: 583, sub: 9973 },
  { stat: "PR", cat: 583, sub: 9976 },
  { stat: "RA", cat: 583, sub: 9974 },
];

async function dkFetch(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`  HTTP ${res.status} ${url.slice(-60)}`); return null; }
    return await res.json();
  } catch (err) {
    console.error(`  fetch threw ${url.slice(-60)}: ${err.message}`);
    return null;
  }
}

// First token of a DK team name ("CHI Sky" → "CHI") = the abbreviation.
const abbrOf = (name) => String(name || "").trim().split(/\s+/)[0] || "?";

// Build eventId → { home, away, start_time, gameKey } from a base payload.
function buildEventMap(base) {
  const events = {};
  for (const e of base?.events || []) {
    const home = e.participants?.find((p) => p.venueRole === "Home");
    const away = e.participants?.find((p) => p.venueRole === "Away");
    if (!home || !away) continue;
    const h = abbrOf(home.name);
    const a = abbrOf(away.name);
    events[e.id] = { home: h, away: a, start_time: e.startEventDate, gameKey: `${a}@${h}` };
  }
  return events;
}

// Game total + team spreads from the base game-lines payload.
function parseGameLines(base, eventMap) {
  const games = {};
  const selsByMarket = {};
  for (const s of base?.selections || []) (selsByMarket[s.marketId] ??= []).push(s);
  for (const m of base?.markets || []) {
    const ev = eventMap[m.eventId];
    if (!ev) continue;
    const g = (games[ev.gameKey] ??= { home: ev.home, away: ev.away, start_time: ev.start_time, game_total: null, home_spread: null, away_spread: null });
    const type = m.marketType?.name || m.name;
    const sels = selsByMarket[m.id] || [];
    if (type === "Total") {
      const over = sels.find((s) => /over/i.test(s.label));
      if (over?.points != null) g.game_total = over.points;
    } else if (type === "Spread") {
      for (const s of sels) {
        const abbr = abbrOf(s.participants?.[0]?.name);
        if (s.points == null) continue;
        if (abbr === ev.home) g.home_spread = s.points;
        else if (abbr === ev.away) g.away_spread = s.points;
      }
    }
  }
  return games;
}

export async function scrapeOdds({ write = true, outputPath = OUTPUT, league = "WNBA" } = {}) {
  const leagueId = LEAGUES[league];
  if (!leagueId) throw new Error(`Unknown league ${league}`);

  console.log(`  Fetching DK ${league} (league ${leagueId}) base payload...`);
  const base = await dkFetch(`${NASH}/${leagueId}`);
  if (!base) throw new Error("DK base payload fetch failed (residential IP required?)");
  const eventMap = buildEventMap(base);
  const games = parseGameLines(base, eventMap);
  console.log(`  ${Object.keys(eventMap).length} events, ${Object.keys(games).length} game lines`);

  const byPlayer = {};
  let propCount = 0;
  for (const { stat, cat, sub } of OU_SUBCATS) {
    const data = await dkFetch(`${NASH}/${leagueId}/categories/${cat}/subcategories/${sub}`);
    if (!data) continue;
    const selsByMarket = {};
    for (const s of data.selections || []) (selsByMarket[s.marketId] ??= []).push(s);
    let n = 0;
    for (const m of data.markets || []) {
      const sels = selsByMarket[m.id] || [];
      const over = sels.find((s) => /^over$/i.test(s.label));
      const under = sels.find((s) => /^under$/i.test(s.label));
      if (!over || !under || over.points == null) continue;
      const player = over.participants?.[0]?.name || under.participants?.[0]?.name;
      if (!player) continue;
      const overAm = parseAmerican(over.displayOdds?.american);
      const underAm = parseAmerican(under.displayOdds?.american);
      const fair = devigTwoWay(overAm, underAm);
      if (fair == null) continue;
      const ev = eventMap[m.eventId] || {};
      const venue = over.participants?.[0]?.venueRole; // HomePlayer | AwayPlayer
      const team = venue === "HomePlayer" ? ev.home : venue === "AwayPlayer" ? ev.away : null;
      const opponent = team && ev.home && ev.away ? (team === ev.home ? ev.away : ev.home) : null;
      (byPlayer[player] ??= []).push({
        stat,
        line: over.points,
        over_american: overAm,
        under_american: underAm,
        fair_over: Number(fair.toFixed(4)),
        team,
        opponent,
        game: ev.gameKey ?? null,
        start_time: ev.start_time ?? null,
        books: 1,
      });
      n++; propCount++;
    }
    console.log(`    ${stat.padEnd(16)} ${n} markets`);
  }

  const result = {
    fetched_at: new Date().toISOString(),
    league,
    source: "draftkings",
    games,
    by_player: byPlayer,
    total_props: propCount,
    total_players: Object.keys(byPlayer).length,
  };
  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
    console.log(`  Written to ${path.relative(ROOT, outputPath)}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  scrapeOdds()
    .then((r) => console.log(`\nDone: ${r.total_props} props for ${r.total_players} players across ${Object.keys(r.games).length} games`))
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
