// Pull regular-season home/road splits from Basketball-Reference for every
// player with a `bbref` slug in data/players.json, and write
// data/bbref-splits.json. The runtime adapter (api/lib/bbref.js) reads this
// snapshot as the primary source for splits — stats.nba.com is the fallback,
// since Vercel egress IPs are throttled by NBA Stats.
//
// BR caps polite scraping at ~20 req/min. This script throttles to one
// request every 3.5s; ~10 minutes for the full ~180-player table.
//
// Usage: npm run refresh-bbref-splits
//        node scripts/refresh-bbref-splits.mjs
//        node scripts/refresh-bbref-splits.mjs --season 2026  (end year)
//
// Recommended cadence: 1×/day. Wire via a scheduled CI run (e.g. GitHub
// Actions with `cron: "0 8 * * *"`) that commits the regenerated
// data/bbref-splits.json back to the repo. Vercel Cron is a worse fit —
// the output is committed JSON, not an HTTP endpoint.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYERS_PATH = path.join(ROOT, "data/players.json");
const OUT_PATH = path.join(ROOT, "data/bbref-splits.json");

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; PropsGenerator/1.0)" };
const THROTTLE_MS = 3500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// BR uses the END year of the NBA season (2025-26 → 2026).
function defaultSeasonEndYear(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= 9 ? y + 1 : y;
}

function nbaSeasonLabel(endYear) {
  return `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`;
}

function splitsUrl(slug, endYear) {
  const firstLetter = slug[0];
  return `https://www.basketball-reference.com/players/${firstLetter}/${slug}/splits/${endYear}/`;
}

// Match the entire <tr>…</tr> block whose split_value cell equals the given
// label ("Home" or "Road"). The Place section's two rows are the only places
// these literal values appear in the splits table.
function rowFor(html, label) {
  const re = new RegExp(
    `<tr[^>]*>(?:(?!<\\/tr>)[\\s\\S]){0,4000}data-stat="split_value"[^>]*>${label}<[\\s\\S]{0,4000}?<\\/tr>`,
    "i"
  );
  const m = html.match(re);
  return m ? m[0] : null;
}

function cellsOf(rowHtml) {
  const out = {};
  for (const m of rowHtml.matchAll(/data-stat="([^"]+)"[^>]*>([^<]*)</g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function num(s) {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Convert BR row totals + provided percentages into the per-game shape that
// nba-stats.js getHomeAwaySplits returns. BR pre-computes a few *_per_g
// fields (mp_per_g, pts_per_g, trb_per_g, ast_per_g); for the rest we divide
// totals by games. Field names match api/lib/nba-stats.js pickAverages.
function rowToAverages(c) {
  const games = num(c.g);
  if (!games) return null;
  const div = (k) => {
    const v = num(c[k]);
    return v == null ? null : Number((v / games).toFixed(2));
  };
  return {
    games,
    minutes: num(c.mp_per_g) ?? div("mp"),
    ppg: num(c.pts_per_g) ?? div("pts"),
    rpg: num(c.trb_per_g) ?? div("trb"),
    apg: num(c.ast_per_g) ?? div("ast"),
    fgm: div("fg"),
    fga: div("fga"),
    fg_pct: num(c.fg_pct),
    fg3m: div("fg3"),
    fg3a: div("fg3a"),
    fg3_pct: num(c.fg3_pct),
    ftm: div("ft"),
    fta: div("fta"),
    ft_pct: num(c.ft_pct),
  };
}

export async function fetchPlayerSplits(slug, endYear) {
  const res = await fetch(splitsUrl(slug, endYear), {
    headers: HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = (await res.text()).replace(/<!--/g, "").replace(/-->/g, "");
  const homeRow = rowFor(html, "Home");
  const roadRow = rowFor(html, "Road");
  if (!homeRow && !roadRow) return { error: "no Place rows" };
  return {
    home: homeRow ? rowToAverages(cellsOf(homeRow)) : null,
    road: roadRow ? rowToAverages(cellsOf(roadRow)) : null,
  };
}

async function main() {
  const flagIndex = process.argv.indexOf("--season");
  const endYear = flagIndex >= 0 ? Number(process.argv[flagIndex + 1]) : defaultSeasonEndYear();
  if (!Number.isFinite(endYear)) {
    console.error("--season expects a 4-digit end year (e.g. 2026)");
    process.exit(1);
  }

  const players = JSON.parse(await fs.readFile(PLAYERS_PATH, "utf8"));
  const slugged = Object.entries(players).filter(([, v]) => v?.bbref);
  console.log(`Fetching splits for ${slugged.length}/${Object.keys(players).length} players (season ${endYear})...`);

  const out = {
    season: nbaSeasonLabel(endYear),
    fetched_at: new Date().toISOString(),
    players: {},
  };
  let ok = 0, failed = 0;
  for (const [name, info] of slugged) {
    const r = await fetchPlayerSplits(info.bbref, endYear);
    if (r.error) {
      console.error(`  FAIL  ${name}: ${r.error}`);
      failed++;
    } else {
      out.players[name] = { bbref: info.bbref, home: r.home, road: r.road };
      const ph = r.home?.games ?? 0;
      const pr = r.road?.games ?? 0;
      console.log(`  ok    ${name.padEnd(28)} home=${ph}g road=${pr}g`);
      ok++;
    }
    await sleep(THROTTLE_MS);
  }

  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nResolved ${ok}, failed ${failed}. Wrote ${OUT_PATH}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
