// Refresh PrizePicks NBA lines for today's games.
// Fetches current projections, filters to today's matchups, and writes
// data/prizepicks-lines.json with player name matching to players.json.
//
// Usage: node scripts/refresh-prizepicks.mjs
//        npm run refresh-prizepicks

import { loadEnvLocal } from "./_env.mjs";
import { scrapePrizePicksForToday } from "./scrape-prizepicks.mjs";

loadEnvLocal();

async function main() {
  console.log("=== refresh-prizepicks ===");

  console.log("\n[1/1] Scraping PrizePicks NBA lines for today...");
  const result = await scrapePrizePicksForToday();

  console.log(`\n  ${result.total_props} props scraped for ${result.total_players} players`);
  console.log(`  Games: ${Object.keys(result.games).join(", ")}`);
  console.log(`  Fetched at: ${result.fetched_at}`);

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
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
