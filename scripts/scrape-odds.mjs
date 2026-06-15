// Scrape DraftKings + FanDuel player-prop O/U markets, de-vig each book, and
// merge into a no-vig CONSENSUS in data/odds.json. Covers WNBA + NBA (both
// leagues merged into one file; each entry tagged with its league for the
// correct line-shift slope). Runs from a residential IP (cloud IPs get
// bot-blocked; the JSON APIs both work from home).
//
// Usage: node scripts/scrape-odds.mjs   |   npm run refresh-odds
//
// Output (data/odds.json):
//   { fetched_at, leagues:[...], sources:[...], games:{...},
//     by_player:{ "<name>": [ { stat, league, line, fair_over (consensus),
//                               books, sources:[ {book, line, over_american,
//                               under_american, fair_over} ], team, opponent,
//                               game, start_time } ] } }

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { devigTwoWay, parseAmerican, fairProbAtLine, impliedProb } from "../api/_lib/odds.js";
import { fitLadderPoisson, poissonFairOver, poissonTail, fairLambda } from "../api/_lib/poisson.js";
import { normalizeName } from "../api/_lib/string-utils.js";
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

// ─── DraftKings World Cup (soccer milestone ladders) ─────────────────────────
//
// Soccer player props are ONE-SIDED milestone ladders ("2+ shots −650") — no
// Under side exists, so devigTwoWay can't apply. Each ladder is fitted to
// Poisson(λ) + a one-sided overround at scrape time (WC_FRAMEWORK_SPEC.md §3);
// lookupMarket then prices ANY PrizePicks line from λ̂ via the Poisson tail.
// DK-only for v1 (FD soccer is also ladder-style; consensus is a calibration-
// driven follow-up). IDs verified live 2026-06-11.
const DK_WC = {
  league: 209533, // "World Cup 2026"
  props: [
    { stat: "Shots", cat: 1113, sub: 16868 },
    { stat: "Shots On Target", cat: 1113, sub: 16861 },
    // v2 expansion (spec §10) — both are milestone ladders like Shots/SOT
    // (probed live 2026-06-11: label shapes 100% "N+"). Passes/Clearances/
    // Fantasy have NO DK market — they ride the model-led path instead.
    { stat: "Tackles", cat: 1567, sub: 18345 },
    { stat: "Goalie Saves", cat: 1567, sub: 18346 },
  ],
  // Match Lines: the soccer base payload only carries Moneyline; totals and
  // goal handicaps live in their own subcategories, each as an alt-line
  // ladder. The "main" line is the rung priced closest to even money.
  lines: { cat: 490, total: 13171, spread: 13170 },
};

// Full country names (not abbrOf): PrizePicks uses full country names for
// soccer teams, so identity matching needs none of the abbreviation
// machinery — "South Africa@Mexico", not "Sou@Mex".
function dkWcEventMap(base) {
  const events = {};
  for (const e of base?.events || []) {
    const home = e.participants?.find((p) => p.venueRole === "Home");
    const away = e.participants?.find((p) => p.venueRole === "Away");
    if (!home || !away) continue;
    events[e.id] = { home: home.name, away: away.name, start_time: e.startEventDate, gameKey: `${away.name}@${home.name}` };
  }
  return events;
}

// Main total from an Over/Under alt ladder: the line whose two sides are
// priced closest to even.
function dkWcMainTotal(sels) {
  const byLine = {};
  for (const s of sels) {
    if (s.points == null) continue;
    (byLine[Math.abs(s.points)] ??= {})[/over/i.test(s.label) ? "over" : "under"] = impliedProb(s.displayOdds?.american);
  }
  let best = null;
  for (const [line, p] of Object.entries(byLine)) {
    if (typeof p.over !== "number" || typeof p.under !== "number") continue;
    const gap = Math.abs(p.over - p.under);
    if (!best || gap < best.gap) best = { line: Number(line), gap };
  }
  return best?.line ?? null;
}

// Main goal handicap: same closest-to-even rule across the two-sided alt
// ladder; selection labels are full team names.
function dkWcMainSpread(sels, homeName) {
  const byAbs = {};
  for (const s of sels) {
    if (s.points == null) continue;
    const side = s.label === homeName ? "home" : "away";
    (byAbs[Math.abs(s.points)] ??= {})[side] = { points: s.points, imp: impliedProb(s.displayOdds?.american) };
  }
  let best = null;
  for (const v of Object.values(byAbs)) {
    if (typeof v.home?.imp !== "number" || typeof v.away?.imp !== "number") continue;
    const gap = Math.abs(v.home.imp - v.away.imp);
    if (!best || gap < best.gap) best = { home_spread: v.home.points, away_spread: v.away.points, gap };
  }
  return best;
}

async function scrapeDraftKingsWorldCup() {
  const base = await jsonFetch(`${DK_NASH}/${DK_WC.league}`, DK_HEADERS);
  if (!base) throw new Error("DK WC base payload fetch failed");
  const eventMap = dkWcEventMap(base);

  const games = {};
  for (const ev of Object.values(eventMap)) {
    games[ev.gameKey] = { home: ev.home, away: ev.away, start_time: ev.start_time, game_total: null, home_spread: null, away_spread: null };
  }
  for (const [kind, sub] of [["total", DK_WC.lines.total], ["spread", DK_WC.lines.spread]]) {
    const data = await jsonFetch(`${DK_NASH}/${DK_WC.league}/categories/${DK_WC.lines.cat}/subcategories/${sub}`, DK_HEADERS);
    if (!data) continue;
    const byMarket = {};
    for (const s of data.selections || []) (byMarket[s.marketId] ??= []).push(s);
    for (const m of data.markets || []) {
      const ev = eventMap[m.eventId];
      if (!ev) continue;
      const g = games[ev.gameKey];
      const sels = byMarket[m.id] || [];
      if (kind === "total") {
        const t = dkWcMainTotal(sels);
        if (t != null) g.game_total = t;
      } else {
        const sp = dkWcMainSpread(sels, ev.home);
        if (sp) { g.home_spread = sp.home_spread; g.away_spread = sp.away_spread; }
      }
    }
  }

  const byPlayer = {};
  for (const { stat, cat, sub } of DK_WC.props) {
    const data = await jsonFetch(`${DK_NASH}/${DK_WC.league}/categories/${cat}/subcategories/${sub}`, DK_HEADERS);
    if (!data) continue;
    const byMarket = {};
    for (const s of data.selections || []) (byMarket[s.marketId] ??= []).push(s);
    for (const m of data.markets || []) {
      const rungs = [];
      let player = null;
      let venue = null;
      for (const s of byMarket[m.id] || []) {
        const milestone = /^(\d+)\+$/.exec(String(s.label || "").trim());
        if (!milestone) continue;
        const american = parseAmerican(s.displayOdds?.american);
        const implied = impliedProb(american);
        if (implied == null) continue;
        player ??= s.participants?.[0]?.name ?? null;
        venue ??= s.participants?.[0]?.venueRole ?? null;
        rungs.push({ k: Number(milestone[1]), american, implied: Number(implied.toFixed(4)) });
      }
      if (!player || !rungs.length) continue;
      rungs.sort((a, b) => a.k - b.k);
      const fit = fitLadderPoisson(rungs);
      if (!fit) continue;
      const ev = eventMap[m.eventId] || {};
      const team = venue === "HomePlayer" ? ev.home : venue === "AwayPlayer" ? ev.away : null;
      // Margin correction happens in λ-space (POISSON_LAMBDA_MARGIN — DK
      // shades the rate, not the probabilities). All fair pricing uses
      // lambda_fair; `lambda` is kept as the raw fit diagnostic.
      const lamFair = Number(fairLambda(fit.lambda).toFixed(4));
      // Representative line: the rung whose fair tail is closest to a coin
      // flip — the line PP most plausibly posts as standard. lookupMarket
      // reprices from λ at whatever line PP actually posted.
      let rep = rungs[0].k;
      let repGap = Infinity;
      for (const r of rungs) {
        const gap = Math.abs(poissonTail(lamFair, r.k) - 0.5);
        if (gap < repGap) { repGap = gap; rep = r.k; }
      }
      const line = rep - 0.5;
      const fairOver = Number(poissonFairOver(lamFair, line).toFixed(4));
      (byPlayer[player] ??= []).push({
        stat, league: "WC", line, fair_over: fairOver,
        lambda: fit.lambda, lambda_fair: lamFair, overround: fit.overround, ladder_rmse: fit.rmse, ladder: rungs,
        books: 1,
        team, opponent: team && ev.home && ev.away ? (team === ev.home ? ev.away : ev.home) : null,
        game: ev.gameKey ?? null, start_time: ev.start_time ?? null,
        sources: [{ book: "draftkings", kind: "ladder", line, fair_over: fairOver, rungs: rungs.length }],
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

function mergeBooks(dk, fd, league) {
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
    const consensus = avg(m.sources.map((s) => fairProbAtLine({ fairOver: s.fair_over, bookLine: s.line, targetLine: repLine, stat: m.stat, league })).filter((x) => typeof x === "number"));
    (byPlayer[m.display] ??= []).push({ stat: m.stat, league, ...m.meta, line: repLine, fair_over: consensus != null ? Number(consensus.toFixed(4)) : null, books: m.sources.length, sources: m.sources });
    coverage[m.sources.length] = (coverage[m.sources.length] || 0) + 1;
  }
  return { byPlayer, coverage };
}

export async function scrapeOdds({ write = true, outputPath = OUTPUT, league = "WNBA" } = {}) {
  // World Cup: DK-only ladder scrape with the Poisson fit done at scrape
  // time; no FD leg and no mergeBooks (entries are already consensus-shaped).
  if (league === "WC") {
    console.log("  DraftKings WC (soccer ladders)...");
    const dk = await scrapeDraftKingsWorldCup();
    const total = Object.values(dk.byPlayer).reduce((n, arr) => n + arr.length, 0);
    console.log(`    ${Object.keys(dk.games).length} games, ${Object.keys(dk.byPlayer).length} players, ${total} fitted ladders`);
    const result = {
      fetched_at: new Date().toISOString(), league, sources: ["draftkings"],
      games: dk.games, by_player: dk.byPlayer, total_props: total, total_players: Object.keys(dk.byPlayer).length, books_coverage: { 1: total },
    };
    if (write) { await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n"); console.log(`  Written to ${path.relative(ROOT, outputPath)}`); }
    return result;
  }

  console.log(`  DraftKings ${league}...`);
  const dk = await scrapeDraftKings(league);
  console.log(`    ${Object.keys(dk.games).length} games, ${Object.keys(dk.byPlayer).length} players`);
  console.log(`  FanDuel ${league}...`);
  let fd = { byPlayer: {} };
  try { fd = await scrapeFanDuel(league); } catch (e) { console.error(`    FD failed (${e.message}) — DK-only this run`); }
  console.log(`    ${Object.keys(fd.byPlayer).length} players`);

  const { byPlayer, coverage } = mergeBooks(dk, fd, league);
  const total = Object.values(byPlayer).reduce((n, arr) => n + arr.length, 0);
  const result = {
    fetched_at: new Date().toISOString(), league, sources: ["draftkings", "fanduel"],
    games: dk.games, by_player: byPlayer, total_props: total, total_players: Object.keys(byPlayer).length, books_coverage: coverage,
  };
  if (write) { await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + "\n"); console.log(`  Written to ${path.relative(ROOT, outputPath)}`); }
  return result;
}

// Scrape every league and merge into ONE odds.json. Players are keyed by name
// (no NBA/WNBA collision in practice), so the slate builder reads a single
// blob; each entry carries its `league` so lookupMarket applies the right
// line-shift slope. A league that fails to scrape is skipped — the rest still
// publish (better a partial refresh than clobbering both books with nothing).
export async function scrapeAllOdds({ leagues = ["WNBA", "NBA", "WC"], write = true, outputPath = OUTPUT } = {}) {
  const per = [];
  for (const lg of leagues) {
    try { per.push(await scrapeOdds({ league: lg, write: false })); }
    catch (e) { console.error(`  ${lg} scrape failed (${e.message}) — skipping league`); }
  }
  const by_player = {};
  const games = {};
  const books_coverage = {};
  for (const r of per) {
    for (const [p, arr] of Object.entries(r.by_player)) (by_player[p] ??= []).push(...arr);
    Object.assign(games, r.games);
    for (const [k, v] of Object.entries(r.books_coverage || {})) books_coverage[k] = (books_coverage[k] || 0) + v;
  }
  const combined = {
    fetched_at: new Date().toISOString(),
    leagues: per.map((r) => r.league),
    sources: ["draftkings", "fanduel"],
    games,
    by_player,
    total_props: Object.values(by_player).reduce((n, a) => n + a.length, 0),
    total_players: Object.keys(by_player).length,
    books_coverage,
    per_league: Object.fromEntries(per.map((r) => [r.league, { total_props: r.total_props, total_players: r.total_players }])),
  };
  if (write) { await fs.writeFile(outputPath, JSON.stringify(combined, null, 2) + "\n"); console.log(`  Written to ${path.relative(ROOT, outputPath)}`); }
  return combined;
}

// Scrape every league and push to the sharp-odds blob (when BLOB_READ_WRITE_TOKEN
// is set). Shared by the CLI (npm run refresh-odds), the home bridge, and the
// /api/refresh-lines endpoint so the REFRESH LINES button keeps odds in sync
// with lines — the scrape + push lives in ONE place. Refuses to push an empty
// scrape (cloud-IP bot-block → 0 props) so a bad run can't clobber the good blob
// a residential refresh pushed. `write` controls the local data/odds.json file
// (true for the committed-snapshot CLI; false for the button/bridge path, which
// only needs the blob).
export async function refreshOddsAndPush({ write = true } = {}) {
  const r = await scrapeAllOdds({ write });
  if (!r.total_props) return { ...r, persisted_to: null, skipped_push: "0 props — refused to overwrite blob" };
  let persisted_to = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { writeOdds } = await import("../api/_lib/odds-store.js");
    persisted_to = await writeOdds(r);
  }
  return { ...r, persisted_to };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvLocal();
  refreshOddsAndPush({ write: true })
    .then((r) => {
      console.log(`\nDone: ${r.total_props} props / ${r.total_players} players across ${(r.leagues || []).join("+")}. Per-league: ${JSON.stringify(r.per_league)}. Book coverage: ${JSON.stringify(r.books_coverage)}`);
      if (r.persisted_to) console.log(`  Pushed to blob: ${r.persisted_to}`);
      else if (r.skipped_push) console.log(`  ${r.skipped_push}`);
      else console.log("  (BLOB_READ_WRITE_TOKEN not set — wrote file only; deployed app keeps its bundled odds)");
    })
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
