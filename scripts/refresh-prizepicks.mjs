// Refresh PrizePicks NBA + WNBA lines for upcoming games.
// Fetches current projections, filters to games that haven't tipped yet,
// and writes data/prizepicks-lines.json with player name matching to
// players.json.
//
// Usage: node scripts/refresh-prizepicks.mjs
//        npm run refresh-prizepicks

import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvLocal } from "./_env.mjs";
import { scrapePrizePicksForToday, OUTPUT } from "./scrape-prizepicks.mjs";
import { writeLines } from "../api/_lib/lines-store.js";

loadEnvLocal();

async function main() {
  console.log("=== refresh-prizepicks ===");

  console.log("\n[1/2] Scraping PrizePicks NBA + WNBA lines for today...");
  // Scrape WITHOUT writing. A 0-prop scrape (rate-limit 429, cloud-IP block,
  // PrizePicks outage) must never clobber the good local file or blob — we
  // persist only after confirming the result is non-empty, mirroring the
  // guard in api/refresh-lines.js.
  const result = await scrapePrizePicksForToday({ write: false });

  console.log(`\n  ${result.total_props} props scraped for ${result.total_players} players`);
  console.log(`  Games: ${Object.keys(result.games).join(", ")}`);
  console.log(`  Fetched at: ${result.fetched_at}`);
  if (result.leagues) {
    for (const [league, stats] of Object.entries(result.leagues)) {
      const note = stats.salvaged
        ? ` (salvaged from ${stats.salvaged_from} after: ${stats.error})`
        : stats.error ? ` (error: ${stats.error})` : "";
      console.log(`  ${league}: ${stats.total_props ?? 0} props${note}`);
    }
  }

  if (result.note) {
    console.log(`\n  Note: ${result.note}`);
  }

  // Guard: refuse to persist an empty scrape — keep the prior good snapshot
  // (local file + blob) intact and exit non-zero so callers/Task Scheduler see
  // the failure.
  if (!result.total_props) {
    console.error(
      "\n  Scrape returned 0 props — refusing to overwrite file or blob. Prior snapshot kept.",
    );
    process.exit(1);
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

  // Persist locally now that we know the scrape is non-empty (same path +
  // format scrapePrizePicksForToday uses when write:true).
  await fs.writeFile(OUTPUT, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n  Written to ${path.relative(process.cwd(), OUTPUT)}`);

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
