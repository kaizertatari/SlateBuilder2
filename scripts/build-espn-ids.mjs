// One-time: hit ESPN search for every player in PLAYER_IDS and emit
// a JS object literal mapping name -> { nba, espn }. Paste the output
// into api/_lib/player-ids.js.
//
// Run: node scripts/build-espn-ids.mjs

import { PLAYER_IDS } from "../api/_lib/player-ids.js";

const SEARCH = "https://site.web.api.espn.com/apis/search/v2";

async function lookupEspnId(name) {
  const url = `${SEARCH}?query=${encodeURIComponent(name)}&type=player&limit=5`;
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    data = await res.json();
  } catch (err) {
    return { error: err.message };
  }
  const players = data?.results?.find((r) => r.type === "player")?.contents ?? [];
  // Prefer NBA-current player; fall back to any basketball match.
  const nbaMatch = players.find(
    (p) =>
      p.sport === "basketball" &&
      p.defaultLeagueSlug === "nba" &&
      p.displayName.toLowerCase() === name.toLowerCase()
  ) ?? players.find(
    (p) => p.sport === "basketball" && p.defaultLeagueSlug === "nba"
  );
  if (!nbaMatch) return { error: "no NBA match" };
  // uid format: "s:40~l:46~a:1966" — athlete id is after `a:`
  const m = nbaMatch.uid?.match(/a:(\d+)/);
  if (!m) return { error: `uid not parseable: ${nbaMatch.uid}` };
  return { id: Number(m[1]), team: nbaMatch.subtitle ?? null };
}

const names = Object.keys(PLAYER_IDS).sort();
console.log(`Looking up ${names.length} players via ESPN search...\n`);

const results = {};
for (const name of names) {
  const r = await lookupEspnId(name);
  if (r.error) {
    console.error(`  FAIL  ${name}: ${r.error}`);
  } else {
    results[name] = r;
    console.log(`  ok    ${name.padEnd(28)} espn=${r.id}  team=${r.team ?? "?"}`);
  }
  // light politeness — ESPN's edge will rate-limit if hammered
  await new Promise((res) => setTimeout(res, 100));
}

console.log("\n--- Paste this into api/_lib/player-ids.js ---\n");
console.log("export const PLAYER_INFO = {");
for (const name of names) {
  const nba = PLAYER_IDS[name];
  const espn = results[name]?.id;
  if (espn) {
    console.log(`  "${name}": { nba: ${nba}, espn: ${espn} },`);
  } else {
    console.log(`  // "${name}": { nba: ${nba} }, // ESPN id missing`);
  }
}
console.log("};");
