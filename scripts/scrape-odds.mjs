// Scrape DraftKings + FanDuel player-prop O/U markets, de-vig each book, and
// merge into a no-vig CONSENSUS in data/odds.json. v1: WNBA. Runs from a
// residential IP (cloud IPs get bot-blocked; the JSON APIs both work from home).
//
// Usage: node scripts/scrape-odds.mjs   |   npm run refresh-odds
//
// Output (data/odds.json):
//   { fetched_at, league, sources:[...], games:{...},
//     by_player:{ "<name>": [ { stat, line, fair_over (consensus), books,
//                               sources:[ {book, line, over_american,
//                               under_american, fair_over} ], team, opponent,
//                               game, start_time } ] } }

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devigTwoWay, parseAmerican, fairProbAtLine } from "../api/lib/odds.js";
import { normalizeName } from "../api/lib/string-utils.js";
import { loadEnvLocal } from "./_env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/odds.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function jsonFetch(url, headers) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`  HTTP ${res.status} ${url.slice(-70)}`); return null; }
    return await res.json();
  } catch (err) { console.error(`  fetch threw ${url.slice(-70)}: ${err.message}`); return null; }
}

const abbrOf = (name) => String(name || "").trim().split(/\s+/)[0] || "?";
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ─── DraftKings (nash sportscontent API) ─────────────────────────────────────

const DK_NASH = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusil/v1/leagues";
const DK_HEADERS = { Referer: "https://sportsbook.draftkings.com/" };
const DK_LEAGUES = { WNBA: 94682, NBA: 42648 };
const DK_OU_SUBCATS = [
  { stat: "Points", cat: 1215, sub: 12488 }, { stat: "Rebounds", cat: 1216, sub: 12492 },
  { stat: "Assists", cat: 1217, sub: 12495 }, { stat: "3-Pointers Made", cat: 1218, sub: 12497 },
  { stat: "PRA", cat: 583, sub: 5001 }, { stat: "PA", cat: 583, sub: 9973 },
  { stat: "PR", cat: 583, sub: 9976 }, { stat: "RA", cat: 583, sub: 9974 },
];

function dkEventMap(base) {
  const events = {};
  for (const e of base?.events || []) {
    const home = e.participants?.find((p) => p.venueRole === "Home");
    const away = e.participants?.find((p) => p.venueRole === "Away");
    if (!home || !away) continue;
    events[e.id] = { home: abbrOf(home.name), away: abbrOf(away.name), start_time: e.startEventDate, gameKey: `${abbrOf(away.name)}@${abbrOf(home.name)}` };
  }
  return events;
}

function dkGameLines(base, eventMap) {
  const games = {};
  const byMarket = {};
  for (const s of base?.selections || []) (byMarket[s.marketId] ??= []).push(s);
  for (const m of base?.markets || []) {
    const ev = eventMap[m.eventId]; if (!ev) continue;
    const g = (games[ev.gameKey] ??= { home: ev.home, away: ev.away, start_time: ev.start_time, game_total: null, home_spread: null, away_spread: null });
    const type = m.marketType?.name || m.name;
    const sels = byMarket[m.id] || [];
    if (type === "Total") { const o = sels.find((s) => /over/i.test(s.label)); if (o?.points != null) g.game_total = o.points; }
    else if (type === "Spread") for (const s of sels) { const a = abbrOf(s.participants?.[0]?.name); if (s.points == null) continue; if (a === ev.home) g.home_spread = s.points; else if (a === ev.away) g.away_spread = s.points; }
  }
  return games;
}

async function scrapeDraftKings(league) {
  const id = DK_LEAGUES[league];
  const base = await jsonFetch(`${DK_NASH}/${id}`, DK_HEADERS);
  if (!base) throw new Error("DK base payload fetch failed");
  const eventMap = dkEventMap(base);
  const games = dkGameLines(base, eventMap);
  const byPlayer = {};
  for (const { stat, cat, sub } of DK_OU_SUBCATS) {
    const data = await jsonFetch(`${DK_NASH}/${id}/categories/${cat}/subcategories/${sub}`, DK_HEADERS);
    if (!data) continue;
    const byMarket = {};
    for (const s of data.selections || []) (byMarket[s.marketId] ??= []).push(s);
    for (const m of data.markets || []) {
      const sels = byMarket[m.id] || [];
      const over = sels.find((s) => /^over$/i.test(s.label));
      const under = sels.find((s) => /^under$/i.test(s.label));
      if (!over || !under || over.points == null) continue;
      const player = over.participants?.[0]?.name; if (!player) continue;
      const fair = devigTwoWay(over.displayOdds?.american, under.displayOdds?.american);
      if (fair == null) continue;
      const ev = eventMap[m.eventId] || {};
      const venue = over.participants?.[0]?.venueRole;
      const team = venue === "HomePlayer" ? ev.home : venue === "AwayPlayer" ? ev.away : null;
      (byPlayer[player] ??= []).push({
        stat, line: over.points, over_american: parseAmerican(over.displayOdds?.american), under_american: parseAmerican(under.displayOdds?.american),
        fair_over: Number(fair.toFixed(4)), team, opponent: team && ev.home && ev.away ? (team === ev.home ? ev.away : ev.home) : null, game: ev.gameKey ?? null, start_time: ev.start_time ?? null,
      });
    }
  }
  return { games, byPlayer };
}

// ─── FanDuel (sbapi content-managed-page + per-tab event-page) ────────────────

const FD_AK = "FhMFpcPWXMeyZxOx";
const FD_REGION = { host: "il", code: "ILLINOIS" };
const FD_PAGE = { WNBA: "wnba", NBA: "nba" };
const FD_TABS = [
  { stat: "Points", slug: "player-points" }, { stat: "Rebounds", slug: "player-rebounds" },
  { stat: "Assists", slug: "player-assists" }, { stat: "3-Pointers Made", slug: "player-threes" },
];
// A player-prop tab also returns quarter/half/double-double markets that start
// with PLAYER. Match the EXACT full-game stat via the market-name suffix
// ("Player - Points", not "Player - 1st Quarter Points") so we never grab a
// 4.5-point alt line as a "Points" market.
const FD_STAT_SUFFIX = {
  Points: /-\s*Points$/i,
  Rebounds: /-\s*Rebounds$/i,
  Assists: /-\s*Assists$/i,
  "3-Pointers Made": /-\s*(Made\s*Threes|Threes|3-?\s*Point(ers)?\s*Made)$/i,
};
const fdCommon = `_ak=${FD_AK}&betexRegion=GBR&capiJurisdiction=intl&currencyCode=USD&exchangeLocale=en_US&includePrices=true&language=en&regionCode=${FD_REGION.code}&timezone=America%2FNew_York`;
const fdBase = `https://sbapi.${FD_REGION.host}.sportsbook.fanduel.com/api`;

async function scrapeFanDuel(league) {
  const page = FD_PAGE[league];
  const cmp = await jsonFetch(`${fdBase}/content-managed-page?page=CUSTOM&customPageId=${page}&${fdCommon}`);
  const events = cmp?.attachments?.events || {};
  const markets = cmp?.attachments?.markets || {};
  const gameIds = new Set();
  for (const m of Object.values(markets)) if (m.marketType === "MONEY_LINE") gameIds.add(String(m.eventId));
  const byPlayer = {};
  for (const eid of gameIds) {
    for (const { stat, slug } of FD_TABS) {
      const ep = await jsonFetch(`${fdBase}/event-page?eventId=${eid}&tab=${slug}&${fdCommon}`);
      const mkts = ep?.attachments?.markets || {};
      for (const m of Object.values(mkts)) {
        if (!String(m.marketType || "").startsWith("PLAYER")) continue;
        const name = String(m.marketName || "");
        if (!FD_STAT_SUFFIX[stat]?.test(name)) continue; // exact full-game stat only
        const player = name.split(" - ")[0].trim();
        if (!player) continue;
        const runners = m.runners || [];
        const over = runners.find((r) => /over/i.test(r.runnerName));
        const under = runners.find((r) => /under/i.test(r.runnerName));
        if (!over || !under || over.handicap == null) continue;
        const oa = over.winRunnerOdds?.americanDisplayOdds?.americanOdds;
        const ua = under.winRunnerOdds?.americanDisplayOdds?.americanOdds;
        const fair = devigTwoWay(oa, ua);
        if (fair == null) continue;
        (byPlayer[player] ??= []).push({ stat, line: over.handicap, over_american: parseAmerican(oa), under_american: parseAmerican(ua), fair_over: Number(fair.toFixed(4)) });
      }
    }
  }
  return { byPlayer };
}

// ─── Merge books → consensus ──────────────────────────────────────────────────

function mergeBooks(dk, fd) {
  const map = new Map(); // `${norm}|${stat}` -> { display, stat, meta, sources[] }
  const add = (book, player, e) => {
    const key = `${normalizeName(player)}|${e.stat}`;
    let m = map.get(key);
    if (!m) { m = { display: player, stat: e.stat, meta: {}, sources: [] }; map.set(key, m); }
    if (book === "draftkings") { m.display = player; m.meta = { team: e.team ?? null, opponent: e.opponent ?? null, game: e.game ?? null, start_time: e.start_time ?? null }; }
    if (m.sources.some((s) => s.book === book)) return; // one quote per book (skip dup/alt lines)
    // Line-sanity guard: if a second book's line is implausibly far from the
    // first (DK), it's a different/mis-parsed market — drop it rather than
    // pollute the consensus (e.g. a 4.5 1Q-points line vs a 19.5 game line).
    if (m.sources.length) {
      const tol = Math.max(3, 0.3 * Math.abs(m.sources[0].line || 0));
      if (Math.abs((e.line ?? 0) - (m.sources[0].line ?? 0)) > tol) return;
    }
    m.sources.push({ book, line: e.line, over_american: e.over_american, under_american: e.under_american, fair_over: e.fair_over });
  };
  for (const [p, arr] of Object.entries(dk.byPlayer)) for (const e of arr) add("draftkings", p, e);
  for (const [p, arr] of Object.entries(fd.byPlayer)) for (const e of arr) add("fanduel", p, e);

  const byPlayer = {};
  const coverage = {};
  for (const m of map.values()) {
    const repLine = m.sources[0].line; // DK added first when present
    const consensus = avg(m.sources.map((s) => fairProbAtLine({ fairOver: s.fair_over, bookLine: s.line, targetLine: repLine, stat: m.stat })).filter((x) => typeof x === "number"));
    (byPlayer[m.display] ??= []).push({ stat: m.stat, ...m.meta, line: repLine, fair_over: consensus != null ? Number(consensus.toFixed(4)) : null, books: m.sources.length, sources: m.sources });
    coverage[m.sources.length] = (coverage[m.sources.length] || 0) + 1;
  }
  return { byPlayer, coverage };
}

export async function scrapeOdds({ write = true, outputPath = OUTPUT, league = "WNBA" } = {}) {
  console.log(`  DraftKings ${league}...`);
  const dk = await scrapeDraftKings(league);
  console.log(`    ${Object.keys(dk.games).length} games, ${Object.keys(dk.byPlayer).length} players`);
  console.log(`  FanDuel ${league}...`);
  let fd = { byPlayer: {} };
  try { fd = await scrapeFanDuel(league); } catch (e) { console.error(`    FD failed (${e.message}) — DK-only this run`); }
  console.log(`    ${Object.keys(fd.byPlayer).length} players`);

  const { byPlayer, coverage } = mergeBooks(dk, fd);
  const total = Object.values(byPlayer).reduce((n, arr) => n + arr.length, 0);
  const result = {
    fetched_at: new Date().toISOString(), league, sources: ["draftkings", "fanduel"],
    games: dk.games, by_player: byPlayer, total_props: total, total_players: Object.keys(byPlayer).length, books_coverage: coverage,
  };
  if (write) { await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n"); console.log(`  Written to ${path.relative(ROOT, outputPath)}`); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvLocal();
  scrapeOdds()
    .then(async (r) => {
      console.log(`\nDone: ${r.total_props} props / ${r.total_players} players. Book coverage: ${JSON.stringify(r.books_coverage)}`);
      // Push to the blob so the deployed slate builder sees fresh odds (same
      // pattern as refresh-prizepicks → writeLines). File-only without a token.
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const { writeOdds } = await import("../api/lib/odds-store.js");
        console.log(`  Pushed to blob: ${await writeOdds(r)}`);
      } else {
        console.log("  (BLOB_READ_WRITE_TOKEN not set — wrote file only; deployed app keeps its bundled odds)");
      }
    })
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
