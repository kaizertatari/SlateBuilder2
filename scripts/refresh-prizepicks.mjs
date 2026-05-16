// Refresh PrizePicks NBA + WNBA lines for upcoming games.
// Fetches current projections, filters to games that haven't tipped yet,
// and writes data/prizepicks-lines.json with player name matching to
// players.json.
//
// Usage: node scripts/refresh-prizepicks.mjs
//        npm run refresh-prizepicks

import { loadEnvLocal } from "./_env.mjs";
import { scrapePrizePicksForToday } from "./scrape-prizepicks.mjs";
import { writeLines } from "../api/lib/lines-store.js";

loadEnvLocal();

async function main() {
  console.log("=== refresh-prizepicks ===");

  console.log("\n[1/2] Scraping PrizePicks NBA + WNBA lines for today...");
  const result = await scrapePrizePicksForToday();

  console.log(`\n  ${result.total_props} props scraped for ${result.total_players} players`);
  console.log(`  Games: ${Object.keys(result.games).join(", ")}`);
  console.log(`  Fetched at: ${result.fetched_at}`);
  if (result.leagues) {
    for (const [league, stats] of Object.entries(result.leagues)) {
      console.log(`  ${league}: ${stats.total_props ?? 0} props${stats.error ? ` (error: ${stats.error})` : ""}`);
    }
  }

  if (result.note) {
    console.log(`\n  Note: ${result.note}`);
  }

  // Show unmatched players
  const unmatched = [];
  for (const [player, props] of Object.entries(result.by_player)) {
    if (props.some((p) => p.player_key === null)) {
      unmatched.push(player);
    }
  }
  if (unmatched.length > 0) {
    console.log(`\n  Unmatched players (not in players.json):`);
    for (const u of unmatched.sort()) {
      console.log(`    ! ${u}`);
    }
  }

  // PrizePicks blocks cloud-provider IPs (Vercel's iad1 returns 403), so the
  // deployed cron can't refresh. Push from this residential-IP run instead;
  // every Fluid Compute instance reads from the same blob.
  console.log("\n[2/2] Uploading to Vercel Blob...");
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log("  Skipped: BLOB_READ_WRITE_TOKEN not set in .env.local");
    console.log("  Deployed app will continue to see stale lines until the token is added.");
    return;
  }
  const url = await writeLines(result);
  console.log(`  Pushed: ${url}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
