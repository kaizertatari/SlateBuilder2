// Pull league-wide team defensive ratings from stats.nba.com / stats.wnba.com
// and write the committed fallback snapshot read by api/_lib/team-defense.js
// when live fetches fail (Vercel egress IPs are often 403'd, local laptops
// are not).
//
//   NBA  → data/team-defense.json
//   WNBA → data/team-defense-wnba.json
//
// Reuses getLeagueTeamDefense (the runtime fetcher) so the snapshot and the
// live path share one parser, one team-id map, and the right per-league
// headers.
//
// Usage: node scripts/refresh-team-defense.mjs [--league NBA|WNBA]
//        npm run refresh-team-defense:guarded [-- --league WNBA]

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getLeagueTeamDefense, currentSeason } from "../api/_lib/nba-stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_PATHS = {
  NBA: path.join(ROOT, "data/team-defense.json"),
  WNBA: path.join(ROOT, "data/team-defense-wnba.json"),
};

function parseLeague(argv) {
  const i = argv.indexOf("--league");
  const league = (i >= 0 ? argv[i + 1] : "NBA")?.toUpperCase();
  if (!SNAPSHOT_PATHS[league]) throw new Error(`--league must be NBA or WNBA (got ${league})`);
  return league;
}

async function buildSnapshot(league) {
  const season = currentSeason(new Date(), league);
  const out = { league, season, fetched_at: new Date().toISOString(), seasons: {} };

  for (const seasonType of ["Regular Season", "Playoffs"]) {
    console.log(`Fetching ${league} ${season} ${seasonType}...`);
    const teams = await getLeagueTeamDefense({ season, seasonType, league });
    if (!teams || Object.keys(teams).length === 0) {
      if (seasonType === "Playoffs") {
        console.error("  (skipping playoffs — likely no games yet)");
        continue;
      }
      throw new Error(`${league} ${seasonType}: no rows (fetch failed or season not started)`);
    }
    out.seasons[seasonType] = teams;
    console.log(`  ${Object.keys(teams).length} teams`);
  }
  return out;
}

async function main() {
  const league = parseLeague(process.argv.slice(2));
  console.log(`=== refresh-team-defense (${league}) ===`);
  const snapshot = await buildSnapshot(league);
  await fs.writeFile(SNAPSHOT_PATHS[league], JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`\nWrote ${SNAPSHOT_PATHS[league]}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
