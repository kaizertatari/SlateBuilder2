// Scrape the PrizePicks EPL board (league 14) → data/epl-pp-lines.json.
//
// Reuses the production browser scraper (PerimeterX-cleared persistent
// profile, the one request shape PX accepts) but writes its OWN snapshot:
// the basketball snapshot (data/prizepicks-lines.json + Blob) and the
// scheduled/bridge refreshes stay untouched until the EPL engine ships.
//
// League ids (from the app's own /leagues response, 2026-09-19): EPL = 14,
// EPL1H = 529, EPL2H = 530. Only full-match EPL is scraped.
//
// The profile is shared with the Refresh Bridge daemon — stop it first
// (Stop-ScheduledTask "Refresh Bridge"), restart after (RUNBOOK).
//
// Usage: npm run refresh-epl-prizepicks  [-- --headed] [-- --push]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapePrizePicksViaBrowser } from "./scrape-prizepicks-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data/epl-pp-lines.json");
export const EPL_PP_LEAGUE = { league: "EPL", league_id: 14 };

async function main() {
  console.log("=== refresh-epl-prizepicks ===");
  const result = await scrapePrizePicksViaBrowser({
    headed: process.argv.includes("--headed"),
    leagues: [EPL_PP_LEAGUE],
    outputPath: OUT,
    write: false,
  });
  const n = result?.leagues?.EPL?.total_props ?? 0;
  if (!n) {
    // Refuse-write: an empty scrape (PX block, off-day) must not clobber the
    // last good board.
    console.error(`  ! 0 EPL props (${result?.leagues?.EPL?.error ?? "empty board"}) — keeping the existing snapshot`);
    process.exit(1);
  }
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + "\n");
  const byStat = {};
  const byType = {};
  for (const props of Object.values(result.by_player)) {
    for (const p of props) {
      byStat[p.stat_type] = (byStat[p.stat_type] || 0) + 1;
      byType[p.odds_type ?? "standard"] = (byType[p.odds_type ?? "standard"] || 0) + 1;
    }
  }
  console.log(`  ${n} EPL props, ${result.total_players} players, ${Object.keys(result.games).length} team-games`);
  console.log(`  by stat: ${JSON.stringify(byStat)}`);
  console.log(`  by odds type: ${JSON.stringify(byType)}`);
  console.log(`  wrote ${path.relative(ROOT, OUT)}`);
  if (process.argv.includes("--push")) {
    // Blob copy for the deployed app (api/_lib/epl/store.js eplLinesStore).
    const { loadEnvLocal } = await import("./_env.mjs");
    loadEnvLocal();
    if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn("  --push: BLOB_READ_WRITE_TOKEN not set — skipped");
    else {
      const { eplLinesStore } = await import("../api/_lib/epl/store.js");
      console.log(`  pushed to blob: ${await eplLinesStore.write(result)}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
