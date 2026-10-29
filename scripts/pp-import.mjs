// Manual PrizePicks board import (2026-10-29). PerimeterX blocks the automated
// browser's API calls, but the operator's own browser loads the board fine —
// so the operator opens each league's projections URL in their normal browser,
// saves the JSON into data/pp-import/, and this module serves those files to
// scrapePrizePicksForToday as its fetchJson. Parsing, salvage, refuse-write and
// the validator are unchanged.
//
// URLs to open + save (any filename; the league is read from the contents):
//   NBA   https://api.prizepicks.com/projections?league_id=7&per_page=10&single_stat=true
//   WNBA  https://api.prizepicks.com/projections?league_id=3&per_page=10&single_stat=true

import fs from "node:fs";
import path from "node:path";

const STALE_WARN_MS = 2 * 60 * 60 * 1000;

// League id of a saved projections response: the projections' league
// relationship, falling back to a league_id-<n> / nba / wnba filename hint.
function leagueIdOf(json, file) {
  for (const d of json?.data ?? []) {
    const id = d?.relationships?.league?.data?.id;
    if (id != null) return String(id);
  }
  const name = path.basename(file).toLowerCase();
  const m = name.match(/league_id[=_-]?(\d+)/);
  if (m) return m[1];
  if (/wnba/.test(name)) return "3";
  if (/nba/.test(name)) return "7";
  return null;
}

// Loads every file under the given files/dirs → Map(league_id → response).
export function loadImportedBoards(inputs) {
  const files = [];
  for (const input of inputs) {
    const st = fs.statSync(input);
    if (st.isDirectory()) {
      // Any extension: Chrome's Ctrl+S names the API response unpredictably
      // (seen: "projections.customization"); non-JSON files are skipped below.
      for (const f of fs.readdirSync(input)) {
        if (!f.startsWith(".") && fs.statSync(path.join(input, f)).isFile()) files.push(path.join(input, f));
      }
    } else {
      files.push(input);
    }
  }
  const boards = new Map();
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`  ! ${file}: not valid JSON (${e.message}) — a block page saved instead of the board?`);
      continue;
    }
    if (!Array.isArray(json?.data)) {
      console.warn(`  ! ${file}: no data[] array — not a projections response, skipped`);
      continue;
    }
    const id = leagueIdOf(json, file);
    if (!id) {
      console.warn(`  ! ${file}: could not tell the league — rename it e.g. pp-nba.json / pp-wnba.json`);
      continue;
    }
    const ageMs = Date.now() - fs.statSync(file).mtimeMs;
    const age = `${Math.round(ageMs / 60000)} min old`;
    if (ageMs > STALE_WARN_MS) console.warn(`  ! ${file}: ${age} — lines may have moved; re-save for a fresh board`);
    console.log(`  imported league_id=${id} from ${path.basename(file)} (${json.data.length} items, ${age})`);
    boards.set(id, json);
  }
  return boards;
}

// fetchJson for scrapePrizePicksForToday: answers from the imported files;
// a league with no file returns null → the scraper salvages it from the
// previous snapshot like any failed fetch.
export function makeImportFetchJson(boards) {
  return async function fetchJson(url) {
    const id = new URL(url).searchParams.get("league_id");
    return boards.get(id) ?? null;
  };
}
