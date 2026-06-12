// Refresh data/wc-match-stats.json — per-player actuals from FBref match
// reports, the grader's fallback for WC stats ESPN doesn't carry
// (Tackles / Clearances / Passes Attempted / key passes / crosses /
// dribbles → also unlocks the Outfield Fantasy Score composite).
// WC_FRAMEWORK_SPEC.md §7; consumed via scripts/_wc-actuals.mjs.
//
// Same Cloudflare story as refresh-soccer-rates.mjs: FBref 403s plain
// fetch/curl, so this scrapes through a real browser via Playwright
// (system Chrome/Edge, automation tells stripped, persistent
// .fbref-profile). Run --headed if the headless run hits the
// "Just a moment..." interstitial.
//
// Incremental: the WC schedule page lists every fixture; only completed
// matches whose report isn't already in the snapshot are scraped
// (~5s apart). Group-stage days have ≤6 matches, so a daily/weekly run
// stays small. --all rescrapes everything.
//
// Usage: npm run refresh-wc-match-stats            (incremental)
//        node scripts/refresh-wc-match-stats.mjs --headed [--all]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";
import { WC_MATCH_STATS_PATH, loadWcMatchStats } from "./_wc-actuals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".fbref-profile");
const PAGE_GAP_MS = 5000;
const SCHEDULE_URL = "https://fbref.com/en/comps/1/schedule/FIFA-World-Cup-Scores-and-Fixtures";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => { const n = Number(String(x ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

// Output field → candidate data-stat names across FBref's match-report
// tables (summary / passing / defense / possession / misc / keeper).
// Field names match the grader's ESPN entry fields so mergeWcEntry is a
// straight overlay. First finite candidate wins; tables that repeat a
// stat (e.g. tackles in summary AND defense) agree, so order is moot.
//
// Probed 2026-06-12: day-after WC reports carry only the BASIC summary
// (goals/assists/shots/SOT/cards/fouls/crosses/tackles_won/interceptions)
// + keeper table — no passing/defense/possession/misc yet. WC 2022 reports
// have the full advanced set, so FBref enriches with a lag; matches
// without advanced stats are rescraped every run until they upgrade
// (needsRescrape below). tackles_won is deliberately NOT a tk candidate —
// PrizePicks Tackles settles on total tackles, and grading won-only would
// silently lowball every line.
const FIELD_CANDIDATES = {
  min: ["minutes"],
  sh: ["shots", "shots_total"],
  st: ["shots_on_target"],
  g: ["goals"],
  a: ["assists"],
  yc: ["cards_yellow"],
  rc: ["cards_red"],
  tk: ["tackles"],
  clr: ["clearances"],
  pa: ["passes"],
  kp: ["assisted_shots"],
  drb: ["take_ons", "take_ons_att", "dribbles_att", "dribbles"],
  cr: ["crosses"],
  fc: ["fouls"],
  sv: ["gk_saves", "saves"],
};

// Tables worth reading on a match report page. pass_types shares the
// _passing prefix family but carries nothing we grade — excluded.
const TABLE_ID_RE = /^(stats_.+_(summary|passing|defense|possession|misc)|keeper_stats_.+)$/;

// Pure composer: generic {id, caption, rows:[{data-stat: text}]} table
// dumps → players keyed by normalizeName. Exported for the smoke.
export function composeMatchPlayers(tables) {
  const players = {};
  for (const t of tables) {
    if (!TABLE_ID_RE.test(t?.id ?? "")) continue;
    // Caption "Mexico Player Stats Table" / "Mexico Goalkeeper Stats Table"
    const team = t.caption ? t.caption.replace(/\s*(Player|Goalkeeper)\s+Stats.*$/i, "").trim() || null : null;
    for (const r of t.rows ?? []) {
      const name = r.player?.trim();
      if (!name || /^\d+\s+Players?$/i.test(name)) continue; // header/total rows
      const key = normalizeName(name);
      let row = players[key];
      if (!row) row = players[key] = { name, team };
      if (team && !row.team) row.team = team;
      for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
        if (Number.isFinite(row[field])) continue;
        for (const c of candidates) {
          if (!(c in r)) continue;
          const v = num(r[c]);
          if (v != null) { row[field] = v; break; }
        }
      }
    }
  }
  return players;
}

// Advanced (Opta) data present? Basic-only matches lack every field the
// fallback exists for, so they stay on the rescrape list until FBref
// posts the advanced tables.
export function hasAdvancedStats(match) {
  return Object.values(match?.players ?? {}).some(
    (p) => Number.isFinite(p.tk) || Number.isFinite(p.clr) || Number.isFinite(p.pa),
  );
}

export const needsRescrape = (match) => !match?.players || !hasAdvancedStats(match);

// Schedule rows → completed matches with a report link.
export function completedMatchesFromSchedule(rows) {
  const out = [];
  for (const r of rows) {
    if (!r?.report_href || !/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? "")) continue;
    if (!/match report/i.test(r.report_text ?? "")) continue; // upcoming = "Head-to-Head"
    out.push({ report: r.report_href, date: r.date, home: r.home_team || null, away: r.away_team || null });
  }
  return out;
}

async function dumpTables(page, selector) {
  return page.$$eval(selector, (els) => els.map((t) => ({
    id: t.id,
    caption: t.querySelector("caption")?.textContent?.trim() ?? null,
    rows: Array.from(t.querySelectorAll("tbody tr")).map((tr) => {
      const out = {};
      for (const cell of tr.querySelectorAll("[data-stat]")) {
        out[cell.getAttribute("data-stat")] = cell.textContent.trim();
      }
      return out;
    }),
  })));
}

export async function refreshWcMatchStats({ headed = false, all = false, outputPath = WC_MATCH_STATS_PATH, write = true } = {}) {
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

  const existing = (!all && await loadWcMatchStats(outputPath)) || null;
  const matches = { ...(existing?.matches ?? {}) };

  const page = await context.newPage();
  try {
    console.log("  FBref WC schedule...");
    await page.goto(SCHEDULE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("table[id^='sched'] tbody tr", { timeout: 20000 });
    const schedRows = await page.$$eval("table[id^='sched'] tbody tr:not(.thead)", (rows) => rows.map((tr) => {
      // Team cells embed the flag span's country code ("Mexico mx") — the
      // anchor text is the clean name.
      const get = (f) => {
        const cell = tr.querySelector(`[data-stat="${f}"]`);
        return (cell?.querySelector("a") ?? cell)?.textContent?.trim() ?? null;
      };
      const link = tr.querySelector("[data-stat='match_report'] a");
      return {
        date: get("date"),
        home_team: get("home_team"),
        away_team: get("away_team"),
        report_href: link?.getAttribute("href") ?? null,
        report_text: link?.textContent?.trim() ?? null,
      };
    }));
    const completed = completedMatchesFromSchedule(schedRows);
    const todo = completed.filter((m) => needsRescrape(matches[m.report]));
    const rescrapes = todo.filter((m) => matches[m.report]?.players).length;
    console.log(`    ${completed.length} completed matches on FBref; ${todo.length} to scrape (${rescrapes} basic-only rescrapes)`);

    for (const m of todo) {
      await sleep(PAGE_GAP_MS);
      const url = `https://fbref.com${m.report}`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForSelector("table[id^='stats_'] tbody tr", { timeout: 20000 });
        const tables = await dumpTables(page, "table[id^='stats_'], table[id^='keeper_stats_']");
        const players = composeMatchPlayers(tables);
        const n = Object.keys(players).length;
        if (n === 0) { console.error(`    ! ${m.home} vs ${m.away} ${m.date}: 0 players parsed — skipped`); continue; }
        matches[m.report] = { date: m.date, home: m.home, away: m.away, scraped_at: new Date().toISOString(), players };
        const advanced = hasAdvancedStats(matches[m.report]);
        console.log(`    ${m.date}  ${m.home} vs ${m.away}: ${n} players${advanced ? "" : " (basic only — tk/clr/pa pending FBref enrichment, will rescrape)"}`);
      } catch (e) {
        // Partial snapshots are fine — the grader's lookback window retries
        // ungraded verdicts on the next run.
        console.error(`    ! ${m.home} vs ${m.away} ${m.date} failed: ${String(e.message).slice(0, 90)}`);
      }
    }
  } finally {
    await context.close();
  }

  const result = {
    fetched_at: new Date().toISOString(),
    source: "fbref",
    total_matches: Object.keys(matches).length,
    matches,
  };
  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 1) + "\n");
    console.log(`  Written ${result.total_matches} matches to ${path.relative(ROOT, outputPath)}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshWcMatchStats({ headed: process.argv.includes("--headed"), all: process.argv.includes("--all") })
    .then((r) => console.log(`\nDone: ${r.total_matches} matches in snapshot.`))
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
