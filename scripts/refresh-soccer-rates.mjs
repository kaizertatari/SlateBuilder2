// Refresh data/soccer-rates.json — club per-90 shooting priors for the WC
// framework (WC_FRAMEWORK_SPEC.md §2, §4.1).
//
// FBref (Sports Reference) 403s plain fetch AND curl (Cloudflare bot
// management), so this scrapes through a real browser via Playwright,
// mirroring scripts/fetch-prizepicks-entries.mjs: system Chrome/Edge,
// automation tells stripped, persistent profile (.fbref-profile). No login
// required — the profile just persists Cloudflare clearance cookies.
//
// Two pages per competition (shooting = per-90 rates; playingtime = minutes/
// matches for the expected-minutes share), ~5s apart out of rate courtesy.
// A failed page logs and continues — partial snapshots are still useful
// (players missing a rates row degrade to position priors + A-tier cap).
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

async function scrapeComp(page, { comp, slug, base, playersInfix = "" }) {
  const num = (x) => { const n = Number(String(x ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
  const players = {};

  // Page 1: shooting — per-90 shot rates.
  const shootingUrl = `${base}/shooting${playersInfix}/${slug}`;
  await page.goto(shootingUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("table[id^='stats_shooting'] tbody tr", { timeout: 20000 });
  const shooting = await extractTable(page, "table[id^='stats_shooting']", ["player", "team", "shots", "shots_on_target", "minutes_90s"]);
  for (const r of shooting) {
    if (!r.player || r.player === "Player") continue;
    const n90 = num(r.minutes_90s);
    if (!n90 || n90 <= 0) continue;
    players[normalizeName(r.player)] = {
      name: r.player,
      squad: r.team ?? null,
      comp,
      shots_p90: num(r.shots) != null ? Number((num(r.shots) / n90).toFixed(3)) : null,
      sot_p90: num(r.shots_on_target) != null ? Number((num(r.shots_on_target) / n90).toFixed(3)) : null,
      minutes: Math.round(n90 * 90), // refined by playingtime below when available
      matches: null,
    };
  }

  // Page 2: playingtime — true minutes + matches for the share signal.
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
