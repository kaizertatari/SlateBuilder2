// Refresh data/soccer-rates.json — club per-90 priors for the WC framework
// (WC_FRAMEWORK_SPEC.md §2, §4.1, §10).
//
// FBref (Sports Reference) 403s plain fetch AND curl (Cloudflare bot
// management), so this scrapes through a real browser via Playwright,
// mirroring scripts/fetch-prizepicks-entries.mjs: system Chrome/Edge,
// automation tells stripped, persistent profile (.fbref-profile). No login
// required — the profile just persists Cloudflare clearance cookies.
//
// Seven pages per competition (shooting/passing/defense/possession/misc/
// keepers = per-90 rates for every WC stat incl. the fantasy components;
// playingtime = minutes/matches for the expected-minutes share), ~5s apart
// out of rate courtesy. A failed page logs and continues — partial
// snapshots are still useful (players missing a rates row, or a row
// missing v2 fields, degrade per-stat to position priors + tier caps).
//
// Usage: npm run refresh-soccer-rates          (headless; default)
//        node scripts/refresh-soccer-rates.mjs --headed   (first run / debug)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data/soccer-rates.json");
const PROFILE_DIR = path.join(ROOT, ".fbref-profile");
const PAGE_GAP_MS = 5000;

// Competitions covering the bulk of 2026 WC squads. Big5 is one combined
// page (EPL/La Liga/Serie A/Bundesliga/Ligue 1); the rest catch the
// non-European-big-five contingents (Liga MX, MLS, Saudi, Brasileirão, …).
const COMPS = [
  { comp: "Big5", slug: "Big-5-European-Leagues-Stats", base: "https://fbref.com/en/comps/Big5", playersInfix: "/players" },
  { comp: "MLS", slug: "Major-League-Soccer-Stats", base: "https://fbref.com/en/comps/22" },
  { comp: "LigaMX", slug: "Liga-MX-Stats", base: "https://fbref.com/en/comps/31" },
  { comp: "Eredivisie", slug: "Eredivisie-Stats", base: "https://fbref.com/en/comps/23" },
  { comp: "PrimeiraLiga", slug: "Primeira-Liga-Stats", base: "https://fbref.com/en/comps/32" },
  { comp: "Championship", slug: "Championship-Stats", base: "https://fbref.com/en/comps/10" },
  { comp: "BrasileiraoA", slug: "Serie-A-Stats", base: "https://fbref.com/en/comps/24" },
  { comp: "ArgPrimera", slug: "Primera-Division-Stats", base: "https://fbref.com/en/comps/21" },
  { comp: "SaudiPL", slug: "Saudi-Professional-League-Stats", base: "https://fbref.com/en/comps/70" },
  { comp: "J1", slug: "J1-League-Stats", base: "https://fbref.com/en/comps/25" },
  { comp: "SuperLig", slug: "Super-Lig-Stats", base: "https://fbref.com/en/comps/26" },
  { comp: "BelgianPL", slug: "Belgian-Pro-League-Stats", base: "https://fbref.com/en/comps/37" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Extract rows from an FBref stats table by data-stat attribute. Runs in the
// page; FBref renders commented-out tables via its own JS in a real browser.
async function extractTable(page, tableSelector, fields) {
  return page.$$eval(
    `${tableSelector} tbody tr:not(.thead)`,
    (rows, fields) => rows.map((tr) => {
      const out = {};
      for (const f of fields) {
        const cell = tr.querySelector(`[data-stat="${f}"]`);
        out[f] = cell ? cell.textContent.trim() : null;
      }
      return out;
    }),
    fields,
  );
}

// Stat pages, in scrape order. `rates` maps output field → candidate
// data-stat names (first non-null wins — FBref has renamed a few across
// table generations, e.g. take-on attempts). All FBref stat columns are
// season TOTALS; each page's own `minutes_90s` (keepers fall back to the
// gk_-prefixed variant) divides them into per-90 rates.
const STAT_PAGES = [
  { slug: "shooting", table: "stats_shooting", rates: { shots_p90: ["shots"], sot_p90: ["shots_on_target"], goals_p90: ["goals"] } },
  { slug: "passing", table: "stats_passing", rates: { passes_att_p90: ["passes"], assists_p90: ["assists"], key_passes_p90: ["assisted_shots"] } },
  { slug: "defense", table: "stats_defense", rates: { tackles_p90: ["tackles"], clearances_p90: ["clearances"] } },
  { slug: "possession", table: "stats_possession", rates: { dribbles_att_p90: ["take_ons", "take_ons_att", "dribbles_att"] } },
  { slug: "misc", table: "stats_misc", rates: { crosses_p90: ["crosses"], fouls_p90: ["fouls"], yellow_p90: ["cards_yellow"], red_p90: ["cards_red"] } },
  { slug: "keepers", table: "stats_keeper", rates: { saves_p90: ["gk_saves"] } },
];

async function scrapeComp(page, { comp, slug, base, playersInfix = "" }) {
  const num = (x) => { const n = Number(String(x ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const players = {};

  for (let i = 0; i < STAT_PAGES.length; i++) {
    const sp = STAT_PAGES[i];
    if (i > 0) await sleep(PAGE_GAP_MS);
    const url = `${base}/${sp.slug}${playersInfix}/${slug}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector(`table[id^='${sp.table}'] tbody tr`, { timeout: 20000 });
    } catch (e) {
      // Shooting is the backbone page; without it the whole comp fails so
      // the caller logs it. Other pages degrade per-stat to priors.
      if (sp.slug === "shooting") throw e;
      console.error(`    ! ${comp}/${sp.slug} failed: ${String(e.message).slice(0, 90)} — per-stat prior fallback`);
      continue;
    }
    const srcFields = [...new Set(Object.values(sp.rates).flat())];
    const rows = await extractTable(page, `table[id^='${sp.table}']`, ["player", "team", "minutes_90s", "gk_minutes_90s", ...srcFields]);
    for (const r of rows) {
      if (!r.player || r.player === "Player") continue;
      const key = normalizeName(r.player);
      const n90 = num(r.minutes_90s) ?? num(r.gk_minutes_90s);
      let row = players[key];
      if (!row) {
        if (!n90 || n90 <= 0) continue; // can't create an entry without exposure
        row = players[key] = {
          name: r.player,
          squad: r.team ?? null,
          comp,
          minutes: Math.round(n90 * 90), // refined by playingtime below when available
          matches: null,
          _n90: n90,
        };
      }
      const div = (n90 && n90 > 0) ? n90 : row._n90;
      if (!div) continue;
      for (const [outField, candidates] of Object.entries(sp.rates)) {
        let v = null;
        for (const c of candidates) { v = num(r[c]); if (v != null) break; }
        if (v != null) row[outField] = Number((v / div).toFixed(3));
      }
    }
  }

  // Final page: playingtime — true minutes + matches for the share signal.
  await sleep(PAGE_GAP_MS);
  const ptUrl = `${base}/playingtime${playersInfix}/${slug}`;
  await page.goto(ptUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("table[id^='stats_playing_time'] tbody tr", { timeout: 20000 });
  const pt = await extractTable(page, "table[id^='stats_playing_time']", ["player", "games", "minutes"]);
  for (const r of pt) {
    const key = normalizeName(r.player ?? "");
    const row = players[key];
    if (!row) continue;
    const minutes = num(r.minutes);
    const games = num(r.games);
    if (minutes != null) row.minutes = minutes;
    if (games != null) row.matches = games;
  }

  for (const row of Object.values(players)) delete row._n90; // scratch field
  return players;
}

export async function refreshSoccerRates({ headed = false, comps = COMPS, outputPath = OUTPUT, write = true } = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error("Playwright is not installed. Run: npm install && npx playwright install chromium");
    process.exit(1);
  }

  const launchOpts = {
    headless: !headed,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  let context;
  for (const channel of ["chrome", "msedge", null]) {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, channel ? { ...launchOpts, channel } : launchOpts);
      break;
    } catch { /* try next channel */ }
  }
  if (!context) throw new Error("Could not launch a browser (chrome/msedge/bundled all failed)");

  const page = await context.newPage();
  const all = {};
  const perComp = {};
  try {
    for (const c of comps) {
      try {
        console.log(`  FBref ${c.comp}...`);
        const players = await scrapeComp(page, c);
        perComp[c.comp] = Object.keys(players).length;
        // Name collisions across comps: keep the row with more minutes (the
        // player's primary club sample).
        for (const [key, row] of Object.entries(players)) {
          if (!all[key] || (row.minutes ?? 0) > (all[key].minutes ?? 0)) all[key] = row;
        }
        console.log(`    ${perComp[c.comp]} players`);
      } catch (e) {
        perComp[c.comp] = 0;
        console.error(`    ! ${c.comp} failed: ${e.message.slice(0, 120)}`);
      }
      await sleep(PAGE_GAP_MS);
    }
  } finally {
    await context.close();
  }

  const result = {
    fetched_at: new Date().toISOString(),
    source: "fbref",
    per_comp: perComp,
    total_players: Object.keys(all).length,
    players: all,
  };
  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 1) + "\n");
    console.log(`  Written ${result.total_players} players to ${path.relative(ROOT, outputPath)}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const headed = process.argv.includes("--headed");
  refreshSoccerRates({ headed })
    .then((r) => console.log(`\nDone: ${r.total_players} players across ${Object.entries(r.per_comp).filter(([, n]) => n > 0).length} comps. Per-comp: ${JSON.stringify(r.per_comp)}`))
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
