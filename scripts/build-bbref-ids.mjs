// Resolve every player in data/players.json to a Basketball-Reference slug
// via BR's search-results page, then merge the slug back into players.json
// as a "bbref" field alongside "nba" and "espn".
//
// BR slug shape: /players/{first-letter-of-last-name}/{slug}.html where the
// slug is something like "gilgesh01" or "jamesle01". The first 5 chars are
// usually last name + first 2 of first name, but collisions get higher
// numeric suffixes — don't try to derive it; ask BR.
//
// BR has a documented ~20 req/min cap. We throttle to one request every
// 3.5s. ~10 minutes for the full ~165-player table.
//
// Run: npm run build-bbref-ids
//      node scripts/build-bbref-ids.mjs            # all players
//      node scripts/build-bbref-ids.mjs --missing  # only those without bbref

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeName } from "../api/lib/string-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYERS_PATH = path.join(ROOT, "data/players.json");

const SEARCH = "https://www.basketball-reference.com/search/search.fcgi";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; PropsGenerator/1.0)" };
const THROTTLE_MS = 3500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Each <div class="search-item"> looks like:
//   <div class="search-item-name">
//     <strong> (only for the top-ranked hit)
//       <a href="/players/g/gilgesh01.html">Shai Gilgeous-Alexander (2019-2026)</a>
//     </strong>
//   </div>
//
// We skip /gleague/ and /wnba/ links. The trailing "(YYYY-YYYY)" is BR's
// active-years range; we strip it before name comparison.
const SEARCH_ITEM_RE = /<div class="search-item"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
const NBA_PLAYER_LINK_RE = /<a href="\/players\/[a-z]\/([a-z0-9]+)\.html">([^<]+)<\/a>/i;
// BR sometimes drops generational suffixes from the display name
// ("Robert Williams III" → "Robert Williams"). Strip on both sides.
const SUFFIX_RE = /\s+(jr|sr|ii|iii|iv|v)\.?$/i;

function stripSuffix(s) {
  return s.replace(SUFFIX_RE, "").trim();
}

function findSlug(html, targetName) {
  const target = normalizeName(stripSuffix(targetName));
  for (const block of html.matchAll(SEARCH_ITEM_RE)) {
    const m = block[1].match(NBA_PLAYER_LINK_RE);
    if (!m) continue;
    const [, slug, displayWithYears] = m;
    const display = displayWithYears.replace(/\s*\(\d{4}-\d{4}\)\s*$/, "").trim();
    if (normalizeName(stripSuffix(display)) === target) return { slug, display };
  }
  return null;
}

async function lookupSlug(name) {
  const url = `${SEARCH}?search=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();
  const hit = findSlug(html, name);
  if (!hit) return { error: "no NBA match in search results" };
  return hit;
}

async function main() {
  const players = JSON.parse(await fs.readFile(PLAYERS_PATH, "utf8"));
  const onlyMissing = process.argv.includes("--missing");
  const names = Object.keys(players)
    .filter((n) => !onlyMissing || !players[n].bbref)
    .sort();

  console.log(`Resolving BR slugs for ${names.length} player(s)${onlyMissing ? " (missing only)" : ""}...`);

  let resolved = 0;
  let failed = 0;
  for (const name of names) {
    const r = await lookupSlug(name);
    if (r.error) {
      console.error(`  FAIL  ${name}: ${r.error}`);
      failed++;
    } else {
      players[name].bbref = r.slug;
      console.log(`  ok    ${name.padEnd(28)} -> ${r.slug}`);
      resolved++;
    }
    await sleep(THROTTLE_MS);
  }

  await fs.writeFile(PLAYERS_PATH, JSON.stringify(players, null, 2) + "\n");
  console.log(`\nResolved ${resolved}, failed ${failed}. Wrote ${PLAYERS_PATH}.`);
}

// Only run when invoked as the entry point — guards against `import()` from
// other scripts (the smoke harness) accidentally kicking off a 10-minute job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
