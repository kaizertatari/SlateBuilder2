// Scrape the PrizePicks NFL board → data/nfl-pp-lines.json.
//
// Same pattern as refresh-epl-prizepicks: the production browser scraper
// (PerimeterX-cleared profile, the one request shape PX accepts) writing its
// OWN snapshot, so the basketball snapshot and the bridge are untouched.
//
// NFL is league 9 (confirmed on the live board 2026-10-14). The guard below
// still refuses the write unless most props' teams resolve to NFL teams, so
// a renumbered league can't land a different sport in the NFL snapshot.
//
// The profile is shared with the Refresh Bridge daemon — stop it first
// (Stop-ScheduledTask "Refresh Bridge"), restart after (RUNBOOK).
//
// Usage: npm run refresh-nfl-prizepicks [-- --league-id 9] [-- --headed] [-- --push]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapePrizePicksViaBrowser } from "./scrape-prizepicks-browser.mjs";
import { nflTeam } from "../api/_lib/nfl/names.js";
import { mapNflStat } from "../api/_lib/nfl/verdict.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data/nfl-pp-lines.json");
const args = process.argv.slice(2);
const idArg = args.indexOf("--league-id");
export const NFL_PP_LEAGUE = { league: "NFL", league_id: idArg >= 0 ? Number(args[idArg + 1]) : 9 };

async function main() {
  console.log(`=== refresh-nfl-prizepicks (league_id=${NFL_PP_LEAGUE.league_id}) ===`);
  const result = await scrapePrizePicksViaBrowser({
    headed: args.includes("--headed"),
    leagues: [NFL_PP_LEAGUE],
    outputPath: OUT,
    write: false,
  });
  const n = result?.leagues?.NFL?.total_props ?? 0;
  if (!n) {
    // Refuse-write: an empty scrape (PX block, off-day) must not clobber the
    // last good board.
    console.error(`  ! 0 NFL props (${result?.leagues?.NFL?.error ?? "empty board"}) — keeping the existing snapshot`);
    process.exit(1);
  }
  const props = Object.values(result.by_player).flat();
  const nflShare = props.filter((p) => nflTeam(p.player_team) && nflTeam(p.opponent)).length / props.length;
  if (nflShare < 0.8) {
    console.error(`  ! only ${Math.round(nflShare * 100)}% of props have NFL teams — league_id ${NFL_PP_LEAGUE.league_id} is probably not NFL; not writing`);
    console.error(`    sample teams: ${[...new Set(props.slice(0, 40).map((p) => p.player_team))].join(", ")}`);
    process.exit(1);
  }
  const { promises: fs } = await import("node:fs");
  await fs.writeFile(OUT, JSON.stringify(result, null, 2) + "\n");
  const byStat = {};
  const byType = {};
  for (const p of props) {
    const k = `${p.stat_type}${mapNflStat(p.stat_type) ? "" : " (UNMAPPED)"}`;
    byStat[k] = (byStat[k] || 0) + 1;
    byType[p.odds_type ?? "standard"] = (byType[p.odds_type ?? "standard"] || 0) + 1;
  }
  console.log(`  ${n} NFL props, ${result.total_players} players, ${Object.keys(result.games).length} team-games`);
  console.log(`  by stat: ${JSON.stringify(byStat)}`);
  console.log(`  by odds type: ${JSON.stringify(byType)}`);
  console.log(`  wrote ${path.relative(ROOT, OUT)}`);
  if (args.includes("--push")) {
    // Blob copy for the deployed app (api/_lib/nfl/store.js nflLinesStore).
    const { loadEnvLocal } = await import("./_env.mjs");
    loadEnvLocal();
    if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn("  --push: BLOB_READ_WRITE_TOKEN not set — skipped");
    else {
      const { nflLinesStore } = await import("../api/_lib/nfl/store.js");
      console.log(`  pushed to blob: ${await nflLinesStore.write(result)}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
