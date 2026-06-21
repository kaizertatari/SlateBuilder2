// Refresh data/wc-fotmob-stats.json — per-player WC actuals from FotMob
// match pages, the grader's PRIMARY fallback for the stats ESPN doesn't
// carry (Tackles / Clearances / Passes Attempted / key passes / crosses /
// dribbles → also unlocks the Outfield Fantasy Score composite).
// WC_FRAMEWORK_SPEC.md §7, §10.6; consumed via scripts/_wc-actuals.mjs.
//
// WHY FotMob and not FBref: as of 2026-06-21 FBref had posted ZERO advanced
// (Opta) match tables for the tournament — every report is "basic only", so
// the FBref fallback graded nothing model-led. FotMob's matchDetails API
// carries the full per-player set. Its /api/data/* endpoints are gated by a
// signed, rotating header (x-mas / x-fm-req), so a plain fetch 401s — BUT a
// real browser signs its own requests, so we navigate the match page with
// Playwright and intercept the matchDetails JSON response (no header
// reverse-engineering). Same launch recipe as refresh-wc-match-stats.mjs.
//
// Incremental: /api/data/leagues?id=77 lists all 104 fixtures with a
// finished flag; only completed matches missing from the snapshot are
// scraped (~4s apart). --all rescrapes everything.
//
// Usage: node scripts/refresh-wc-fotmob-stats.mjs --headed [--all]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeName } from "../api/_lib/string-utils.js";
import { WC_FOTMOB_STATS_PATH, loadWcMatchStats } from "./_wc-actuals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".fotmob-profile");
const PAGE_GAP_MS = 4000;
const WC_LEAGUE_ID = 77;
const FIXTURES_URL = `https://www.fotmob.com/leagues/${WC_LEAGUE_ID}/matches/world-cup`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (x) => (Number.isFinite(x) ? x : null);

// Output field → FotMob stat name(s) + whether the attempted-count lives in
// `.total` (FotMob stores "accurate X" as {value:accurate, total:attempted}).
// PrizePicks settles Passes/Dribbles/Crosses on ATTEMPTS, so those read
// `.total`. `tk` reads "Tackles" only (NOT "tackles won" — PP Tackles is
// total tackles; won-only would lowball every line, same caveat as FBref).
const FM_FIELDS = {
  min: { names: ["minutes played"], total: false },
  sh: { names: ["total shots"], total: false },
  st: { names: ["shots on target"], total: false },
  g: { names: ["goals"], total: false },
  a: { names: ["assists"], total: false },
  tk: { names: ["tackles"], total: false },
  clr: { names: ["clearances"], total: false },
  pa: { names: ["accurate passes"], total: true },
  kp: { names: ["chances created"], total: false },
  drb: { names: ["successful dribbles"], total: true },
  cr: { names: ["accurate crosses"], total: true },
  fc: { names: ["fouls committed"], total: false },
  sv: { names: ["saves", "goalkeeper saves"], total: false },
};

// Countable fields that FotMob OMITS when zero. For a player with a real
// stats block (played), an absent countable is a true 0 — defaulting lets
// the all-or-nothing fantasy composite grade. NOT defaulted: sv (keepers
// only — set per isGoalkeeper below).
const ZERO_DEFAULT = ["sh", "st", "g", "a", "tk", "clr", "pa", "kp", "drb", "cr", "fc"];

// Flatten a FotMob player's grouped stats → Map(lowercased stat name → {value,total}).
function flattenStats(player) {
  const flat = new Map();
  for (const g of player?.stats ?? []) {
    for (const [name, obj] of Object.entries(g?.stats ?? {})) {
      if (obj?.stat) flat.set(name.toLowerCase(), obj.stat);
    }
  }
  return flat;
}

function readField(flat, { names, total }) {
  for (const n of names) {
    const s = flat.get(n);
    if (!s) continue;
    const v = total ? s.total : s.value;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// matchFacts events → Map(normName → {yc, rc}). A second yellow is a red,
// so any card event whose color reads "red" (incl. "yellowred") counts as rc.
export function parseFotmobCards(matchDetails) {
  const out = new Map();
  const raw = matchDetails?.content?.matchFacts?.events;
  const events = Array.isArray(raw) ? raw : raw?.events ?? [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!/card/i.test(e?.type ?? "")) continue;
    const name = e?.player?.name;
    if (!name) continue;
    const key = normalizeName(name);
    const row = out.get(key) ?? { yc: 0, rc: 0 };
    const color = `${e.card ?? ""}${e.cardType ?? ""}${e.isRed ? "red" : ""}`.toLowerCase();
    if (/red/.test(color)) row.rc += 1; else row.yc += 1;
    out.set(key, row);
  }
  return out;
}

// Pure composer: FotMob matchDetails → { normName: row } with the grader's
// field names so mergeWcEntry is a straight overlay. Exported for the smoke.
export function composeFotmobPlayers(matchDetails) {
  const ps = matchDetails?.content?.playerStats;
  if (!ps || typeof ps !== "object") return {};
  const cards = parseFotmobCards(matchDetails);
  const players = {};
  for (const p of Object.values(ps)) {
    const name = p?.name?.trim();
    if (!name) continue;
    const flat = flattenStats(p);
    const min = readField(flat, FM_FIELDS.min);
    if (!Number.isFinite(min)) continue; // no stats block = didn't play / no data
    const key = normalizeName(name);
    const row = { name, team: p.teamName ?? null, played: min > 0 };
    for (const [field, spec] of Object.entries(FM_FIELDS)) {
      const v = readField(flat, spec);
      if (v != null) row[field] = v;
    }
    for (const f of ZERO_DEFAULT) if (!Number.isFinite(row[f])) row[f] = 0;
    if (p.isGoalkeeper && !Number.isFinite(row.sv)) row.sv = 0;
    const c = cards.get(key);
    row.yc = c?.yc ?? 0;
    row.rc = c?.rc ?? 0;
    players[key] = row;
  }
  return players;
}

// Advanced stats present? FotMob always carries them, so a scraped match is
// complete; this just guards against an empty/failed capture being kept.
export const hasFotmobStats = (match) =>
  Object.values(match?.players ?? {}).some((p) => Number.isFinite(p.tk) || Number.isFinite(p.clr) || Number.isFinite(p.pa));

export const needsScrape = (match) => !match?.players || !hasFotmobStats(match);

// utcTime → America/New_York date (YYYY-MM-DD). WC verdicts log ESPN's
// ET-offset game_start_time, and the grader keys the snapshot on that date
// (game_start_time.slice(0,10)); converting FotMob's UTC instant to ET keeps
// late games from landing a calendar day off.
export function etDate(utcTime) {
  if (!utcTime) return null;
  const d = new Date(utcTime);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// leagues payload → [{ id, pageUrl, date, home, away }] for finished matches.
// The fixtures list lives under fixtures.allMatches (canonical) with
// overview.leagueOverviewMatches as a fallback; each row carries id, pageUrl,
// status.{finished,utcTime} and home/away {name}.
export function finishedMatchesFromLeagues(leagues) {
  const all = leagues?.fixtures?.allMatches
    ?? leagues?.overview?.leagueOverviewMatches
    ?? (Array.isArray(leagues?.matches) ? leagues.matches : leagues?.matches?.allMatches)
    ?? [];
  const out = [];
  for (const m of all) {
    if (!m?.status?.finished || m?.status?.cancelled) continue;
    if (!m.id || !m.pageUrl) continue;
    out.push({
      id: String(m.id),
      pageUrl: m.pageUrl,
      date: etDate(m.status.utcTime),
      home: m.home?.name ?? m.home?.shortName ?? null,
      away: m.away?.name ?? m.away?.shortName ?? null,
    });
  }
  return out;
}

async function refreshWcFotmobStats({ headed = false, all = false, outputPath = WC_FOTMOB_STATS_PATH, write = true } = {}) {
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

  // Intercept the signed JSON the page fetches for us.
  let leaguesJson = null;
  const mdById = new Map();
  context.on("response", async (resp) => {
    const u = resp.url();
    if (!/fotmob\.com\/api\/data\//.test(u)) return;
    try {
      if (/\/leagues\?id=77/.test(u)) leaguesJson = await resp.json();
      else if (/\/matchDetails\?matchId=(\d+)/.test(u)) {
        const id = u.match(/matchId=(\d+)/)[1];
        mdById.set(id, await resp.json());
      }
    } catch { /* non-JSON / parse race — ignore */ }
  });

  const existing = (!all && (await loadWcMatchStats(outputPath))) || null;
  const matches = { ...(existing?.matches ?? {}) };

  const page = await context.newPage();
  try {
    console.log("  FotMob WC fixtures...");
    await page.goto(FIXTURES_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    for (let i = 0; i < 15 && !leaguesJson; i++) await sleep(500);
    if (!leaguesJson) throw new Error("never captured /api/data/leagues?id=77 (FotMob layout/header change?)");

    const finished = finishedMatchesFromLeagues(leaguesJson);
    const todo = all ? finished : finished.filter((m) => needsScrape(matches[m.id]));
    console.log(`    ${finished.length} finished WC matches on FotMob; ${todo.length} to scrape`);

    for (const m of todo) {
      await sleep(PAGE_GAP_MS);
      const url = m.pageUrl.startsWith("http") ? m.pageUrl : `https://www.fotmob.com${m.pageUrl}`;
      try {
        mdById.delete(m.id);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        for (let i = 0; i < 20 && !mdById.has(m.id); i++) await sleep(500);
        const md = mdById.get(m.id);
        if (!md) { console.error(`    ! ${m.home} vs ${m.away} ${m.date}: no matchDetails captured — skipped`); continue; }
        const players = composeFotmobPlayers(md);
        const n = Object.keys(players).length;
        if (n === 0) { console.error(`    ! ${m.home} vs ${m.away} ${m.date}: 0 players parsed — skipped`); continue; }
        matches[m.id] = { date: m.date, home: m.home, away: m.away, scraped_at: new Date().toISOString(), players };
        console.log(`    ${m.date}  ${m.home} vs ${m.away}: ${n} players`);
      } catch (e) {
        console.error(`    ! ${m.home} vs ${m.away} ${m.date} failed: ${String(e.message).slice(0, 90)}`);
      }
    }
  } finally {
    await context.close();
  }

  const result = {
    fetched_at: new Date().toISOString(),
    source: "fotmob",
    total_matches: Object.keys(matches).length,
    matches,
  };
  if (write) {
    await fs.writeFile(outputPath, JSON.stringify(result, null, 1) + "\n");
    console.log(`  Written ${result.total_matches} matches to ${path.relative(ROOT, outputPath)}`);
  }
  return result;
}

export { refreshWcFotmobStats };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshWcFotmobStats({ headed: process.argv.includes("--headed"), all: process.argv.includes("--all") })
    .then((r) => console.log(`\nDone: ${r.total_matches} matches in snapshot.`))
    .catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}
