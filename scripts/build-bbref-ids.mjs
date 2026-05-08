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

// BR appends one of:
//   "(2019-2026)"  retired/active range
//   "(2026)"       rookies / first-season players
//   "Overview"     some result rows (e.g. Wembanyama, Poeltl)
function cleanDisplay(s) {
  return s
    .replace(/\s*\(\d{4}(?:-\d{4})?\)\s*$/, "")
    .replace(/\s+Overview\s*$/i, "")
    .trim();
}

function findSlug(html, targetName) {
  const targetParts = stripSuffix(targetName).split(/\s+/).filter(Boolean);
  const targetLast = normalizeName(targetParts[targetParts.length - 1] ?? "");
  const targetFirst = normalizeName(targetParts[0] ?? "");
  const targetFull = normalizeName(stripSuffix(targetName));

  let nicknameHit = null;
  for (const block of html.matchAll(SEARCH_ITEM_RE)) {
    const m = block[1].match(NBA_PLAYER_LINK_RE);
    if (!m) continue;
    const [, slug, raw] = m;
    const display = cleanDisplay(raw);
    if (normalizeName(stripSuffix(display)) === targetFull) return { slug, display };

    // Nickname fallback (Ron Holland ↔ Ronald Holland). Same last name + one
    // first name is a prefix of the other. Tracked separately so an exact
    // match later in the page still wins.
    if (!nicknameHit && targetFirst) {
      const dispParts = stripSuffix(display).split(/\s+/).filter(Boolean);
      const dispLast = normalizeName(dispParts[dispParts.length - 1] ?? "");
      const dispFirst = normalizeName(dispParts[0] ?? "");
      if (dispLast === targetLast && dispFirst &&
          (dispFirst.startsWith(targetFirst) || targetFirst.startsWith(dispFirst))) {
        nicknameHit = { slug, display: `${display} [nickname]` };
      }
    }
  }
  return nicknameHit;
}

async function lookupSlug(name) {
  // BR's search treats "III" / "Jr." as literal tokens and returns zero hits
  // for "Robert Williams III" while "Robert Williams" finds slug williro04.
  // Search by the suffix-stripped form; comparison still uses stripSuffix on
  // both sides, so a real "Smith Jr." won't be confused for "Smith".
  const query = stripSuffix(name);
  const url = `${SEARCH}?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const html = await res.text();

  // For unique-name searches BR serves the player page directly (no
  // search-results template). Trust the <link rel="canonical"> tag in that
  // case; otherwise scan the search-item blocks.
  const canonical = html.match(
    /<link\s+rel="canonical"\s+href="https?:\/\/www\.basketball-reference\.com\/players\/[a-z]\/([a-z0-9]+)\.html"/i
  );
  if (canonical) return { slug: canonical[1], display: name };

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
