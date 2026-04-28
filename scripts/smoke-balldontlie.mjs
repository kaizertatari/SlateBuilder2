// Exercise balldontlie helpers directly. Loads BALLDONTLIE_API_KEY from
// .env.local automatically. Doesn't touch stats.nba.com.
// Usage: node scripts/smoke-balldontlie.mjs ["Player Name"]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bdl from "../api/lib/balldontlie.js";
import { currentSeason } from "../api/lib/nba-stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

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
