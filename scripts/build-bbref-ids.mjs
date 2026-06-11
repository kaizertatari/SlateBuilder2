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
import { normalizeName } from "../api/_lib/string-utils.js";

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
// NBA mode matches /players/<letter>/<slug>.html (skips /gleague/ and
// /wnba/). WNBA mode matches /wnba/players/<letter>/<slug>.html instead.
// The trailing "(YYYY-YYYY)" is BR's active-years range; we strip it before
// name comparison.
const SEARCH_ITEM_RE = /<div class="search-item"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
const NBA_PLAYER_LINK_RE = /<a href="\/players\/[a-z]\/([a-z0-9]+)\.html">([^<]+)<\/a>/i;
const WNBA_PLAYER_LINK_RE = /<a href="\/wnba\/players\/[a-z]\/([a-z0-9]+)\.html">([^<]+)<\/a>/i;
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

function findSlug(html, targetName, league = "NBA") {
  const targetParts = stripSuffix(targetName).split(/\s+/).filter(Boolean);
  const targetLast = normalizeName(targetParts[targetParts.length - 1] ?? "");
  const targetFirst = normalizeName(targetParts[0] ?? "");
  const targetFull = normalizeName(stripSuffix(targetName));
  const linkRe = league === "WNBA" ? WNBA_PLAYER_LINK_RE : NBA_PLAYER_LINK_RE;

  let nicknameHit = null;
  for (const block of html.matchAll(SEARCH_ITEM_RE)) {
    const m = block[1].match(linkRe);
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

async function lookupSlug(name, league = "NBA") {
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
  const canonicalRe = league === "WNBA"
    ? /<link\s+rel="canonical"\s+href="https?:\/\/www\.basketball-reference\.com\/wnba\/players\/[a-z]\/([a-z0-9]+)\.html"/i
    : /<link\s+rel="canonical"\s+href="https?:\/\/www\.basketball-reference\.com\/players\/[a-z]\/([a-z0-9]+)\.html"/i;
  const canonical = html.match(canonicalRe);
  if (canonical) return { slug: canonical[1], display: name };

  const hit = findSlug(html, name, league);
  if (!hit) return { error: `no ${league} match in search results` };
  return hit;
}

async function main() {
  const players = JSON.parse(await fs.readFile(PLAYERS_PATH, "utf8"));
  const onlyMissing = process.argv.includes("--missing");
  const leagueIdx = process.argv.indexOf("--league");
  // --league filters to one league (NBA or WNBA). Default is whatever the
  // player entry says (league field, default NBA), so a full run resolves
  // both leagues' slugs using the correct BR URL family per entry.
  const explicitLeague = leagueIdx >= 0 ? process.argv[leagueIdx + 1]?.toUpperCase() : null;

  const names = Object.keys(players)
    .filter((n) => !onlyMissing || !players[n].bbref)
    .filter((n) => !explicitLeague || (players[n].league ?? "NBA") === explicitLeague)
    .sort();

  console.log(`Resolving BR slugs for ${names.length} player(s)${onlyMissing ? " (missing only)" : ""}${explicitLeague ? ` (${explicitLeague} only)` : ""}...`);

  let resolved = 0;
  let failed = 0;
  for (const name of names) {
    const league = players[name].league ?? "NBA";
    const r = await lookupSlug(name, league);
    if (r.error) {
      console.error(`  FAIL  ${name} (${league}): ${r.error}`);
      failed++;
    } else {
      players[name].bbref = r.slug;
      console.log(`  ok    ${name.padEnd(28)} [${league}] -> ${r.slug}`);
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
