// NFL step 3 — scrape DraftKings + FanDuel NFL player props into
// data/nfl-odds.json. Two-sided O/U quotes are de-vigged per book and kept
// per book (no line shifting here — the verdict layer moves a book price to
// the PrizePicks line with the model's own distribution shape). Anytime-TD
// prices are one-sided (raw implied probability, vig included).
//
// Output:
//   { fetched_at, sources, games: { "AWY@HOM": { home, away, start_time,
//     total, home_spread } }, by_player: { "<name>": [ { stat, line,
//     fair_over, books, team, game, start_time, quotes:[ per-book ] } ] },
//     anytime_td: { "<name>": [ { book, american, implied, team, game } ] } }
//
// Usage: npm run scrape-nfl-odds  [-- --days 8] [-- --push]   (residential IP, Node fetch)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";
import { DK_OU, DK_TD, FD_OU, FD_TD_TAB, dkEvents, dkGameLines, parseDkOU, parseDkTd, parseFdOU, parseFdTd, fdEvent } from "../api/_lib/nfl/market.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/nfl-odds.json");
const args = process.argv.slice(2);
const dIdx = args.indexOf("--days");
const DAYS = dIdx >= 0 ? Number(args[dIdx + 1]) : 8;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
async function jsonFetch(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) { console.error(`  HTTP ${res.status} ${url.slice(-80)}`); return null; }
    return await res.json();
  } catch (e) { console.error(`  fetch failed ${url.slice(-80)}: ${e.message}`); return null; }
}

const DK = "https://sportsbook-nash.draftkings.com/api/sportscontent/dkusil/v1/leagues/88808";
const DK_H = { Referer: "https://sportsbook.draftkings.com/" };
const FD = "https://sbapi.il.sportsbook.fanduel.com/api";
const FD_C = "_ak=FhMFpcPWXMeyZxOx&betexRegion=GBR&capiJurisdiction=intl&currencyCode=USD&exchangeLocale=en_US&includePrices=true&language=en&regionCode=ILLINOIS&timezone=America%2FNew_York";

async function scrapeDk() {
  const base = await jsonFetch(DK, DK_H);
  if (!base) throw new Error("DraftKings NFL league payload failed");
  const events = dkEvents(base);
  const games = dkGameLines(base, events);
  const quotes = [];
  for (const { stat, cat, sub } of DK_OU) {
    const d = await jsonFetch(`${DK}/categories/${cat}/subcategories/${sub}`, DK_H);
    if (d) quotes.push(...parseDkOU(d, stat, events));
  }
  const td = await jsonFetch(`${DK}/categories/${DK_TD.cat}/subcategories/${DK_TD.sub}`, DK_H);
  return { games, quotes, tds: td ? parseDkTd(td, events) : [] };
}

async function scrapeFd() {
  const cmp = await jsonFetch(`${FD}/content-managed-page?page=CUSTOM&customPageId=nfl&${FD_C}`);
  const evs = cmp?.attachments?.events || {};
  const ids = new Set(Object.values(cmp?.attachments?.markets || {}).filter((m) => m.marketType === "MONEY_LINE").map((m) => String(m.eventId)));
  const horizon = Date.now() + DAYS * 86400000;
  const quotes = [], tds = [];
  for (const id of ids) {
    const ev = fdEvent(evs[id]);
    if (!ev || !(Date.parse(ev.start_time) < horizon)) continue;
    for (const tab of [...new Set(FD_OU.map((s) => s.tab))]) {
      const p = await jsonFetch(`${FD}/event-page?eventId=${id}&tab=${tab}&${FD_C}`);
      if (p) quotes.push(...parseFdOU(p.attachments, FD_OU.filter((s) => s.tab === tab), ev));
    }
    const t = await jsonFetch(`${FD}/event-page?eventId=${id}&tab=${FD_TD_TAB}&${FD_C}`);
    if (t) tds.push(...parseFdTd(t.attachments, ev));
  }
  return { quotes, tds };
}

/**
 * Group per-book quotes by (player, stat). Consensus fair_over = mean of the
 * books quoting the SAME line as DraftKings (or the first book); a book on a
 * different line stays in `quotes` but out of the consensus.
 */
export function combineQuotes(quotes, tds) {
  const team = new Map();
  for (const q of [...quotes, ...tds]) if (q.team) team.set(`${normalizeName(q.player)}|${q.game}`, q.team);
  const groups = new Map();
  for (const q of quotes) {
    const k = `${normalizeName(q.player)}|${q.stat}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(q);
  }
  const by_player = {};
  for (const qs of groups.values()) {
    qs.sort((a, b) => (a.book === "draftkings" ? -1 : 0) - (b.book === "draftkings" ? -1 : 0));
    const rep = qs[0];
    const same = qs.filter((q) => q.line === rep.line);
    const fair = same.reduce((a, q) => a + q.fair_over, 0) / same.length;
    const t = rep.team ?? team.get(`${normalizeName(rep.player)}|${rep.game}`) ?? null;
    (by_player[rep.player] ??= []).push({ stat: rep.stat, line: rep.line, fair_over: Number(fair.toFixed(4)), books: same.length, team: t, game: rep.game, start_time: rep.start_time,
      quotes: qs.map(({ book, line, over_american, under_american, fair_over }) => ({ book, line, over_american, under_american, fair_over })) });
  }
  const anytime_td = {};
  for (const q of tds) {
    const t = q.team ?? team.get(`${normalizeName(q.player)}|${q.game}`) ?? null;
    (anytime_td[q.player] ??= []).push({ book: q.book, american: q.american, implied: q.implied, team: t, game: q.game });
  }
  return { by_player, anytime_td };
}

async function main() {
  console.log("scrape-nfl-odds: DraftKings...");
  const dk = await scrapeDk();
  console.log(`  ${Object.keys(dk.games).length} games, ${dk.quotes.length} O/U quotes, ${dk.tds.length} anytime-TD prices`);
  console.log(`FanDuel (games within ${DAYS} days)...`);
  let fd = { quotes: [], tds: [] };
  try { fd = await scrapeFd(); } catch (e) { console.error(`  FanDuel failed (${e.message}) — DraftKings only`); }
  console.log(`  ${fd.quotes.length} O/U quotes, ${fd.tds.length} anytime-TD prices`);
  const { by_player, anytime_td } = combineQuotes([...dk.quotes, ...fd.quotes], [...dk.tds, ...fd.tds]);
  const rows = Object.values(by_player).flat();
  const byStat = {};
  for (const r of rows) byStat[r.stat] = (byStat[r.stat] || 0) + 1;
  const result = { fetched_at: new Date().toISOString(), sources: ["draftkings", "fanduel"], games: dk.games, by_player, anytime_td,
    total_props: rows.length, total_players: Object.keys(by_player).length, two_book_props: rows.filter((r) => r.books > 1).length, by_stat: byStat };
  if (!rows.length && !Object.keys(dk.games).length) {
    // Blocked or empty response — keep the last snapshot instead of wiping it.
    console.error("  nothing scraped — data/nfl-odds.json left unchanged");
    process.exitCode = 1;
    return;
  }
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 1) + "\n");
  console.log(`Wrote ${rows.length} props (${result.two_book_props} priced by both books) for ${result.total_players} players, ${Object.keys(anytime_td).length} anytime-TD players → data/nfl-odds.json`);
  console.log(`  by stat: ${JSON.stringify(byStat)}`);
  if (args.includes("--push")) {
    // Blob copy for the deployed app (api/_lib/nfl/store.js nflOddsStore) —
    // without it the app prices against the odds bundled at the last deploy.
    const { loadEnvLocal } = await import("./_env.mjs");
    loadEnvLocal();
    if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn("  --push: BLOB_READ_WRITE_TOKEN not set — skipped");
    else {
      const { nflOddsStore } = await import("../api/_lib/nfl/store.js");
      console.log(`  pushed to blob: ${await nflOddsStore.write(result)}`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
