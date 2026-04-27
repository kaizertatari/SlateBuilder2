// Quick edge-case checks: playoff season type + omitted-player path.
import { resolvePlayerId } from "../api/lib/player-ids.js";
import { getLastNGames } from "../api/lib/nba-stats.js";

const dump = (label, val) =>
  console.log("\n--- " + label + " ---\n" + JSON.stringify(val, null, 2));

console.log("Cooper Flagg (omitted) ->", resolvePlayerId("Cooper Flagg"));
console.log("LeBron James ->", resolvePlayerId("LeBron James"));

const jokicId = resolvePlayerId("Nikola Jokic");
dump(
  "Jokic L5 Playoffs",
  await getLastNGames(jokicId, 5, { seasonType: "Playoffs" })
);
