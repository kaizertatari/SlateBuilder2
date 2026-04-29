// Exercise balldontlie helpers directly. Loads BALLDONTLIE_API_KEY from
// .env.local automatically. Doesn't touch stats.nba.com.
// Usage: node scripts/smoke-balldontlie.mjs ["Player Name"]

import * as bdl from "../api/lib/balldontlie.js";
import { currentSeason } from "../api/lib/nba-stats.js";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();
if (!process.env.BALLDONTLIE_API_KEY) {
  console.error("BALLDONTLIE_API_KEY not found in .env.local");
  process.exit(1);
}

const player = process.argv[2] || "Nikola Jokic";
const season = currentSeason();
console.log(`Player: ${player}\nSeason: ${season}\n`);

const dump = (label, val) => console.log("\n=== " + label + " ===\n" + JSON.stringify(val, null, 2));

dump("findPlayer", await bdl.findPlayer(player));
dump("getSeasonAverages", await bdl.getSeasonAverages(player, { season }));
dump("getLastNGames (Playoffs)", await bdl.getLastNGames(player, 5, { season, postseason: true }));
dump("getLastNGames (Regular)", await bdl.getLastNGames(player, 5, { season, postseason: false }));
