// Exercise api/lib/* end-to-end from the command line.
// Run: node scripts/smoke-data.mjs ["Player Name"]
// Default player: LeBron James (always rostered, predictable).

import { resolvePlayerId } from "../api/lib/player-ids.js";
import {
  currentSeason,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
  getCommonPlayerInfo,
} from "../api/lib/nba-stats.js";
import {
  getTodaysGames,
  findGameForTeamAbbr,
  homeAwayForTeam,
  opponentFor,
  getWinProbability,
  getTeamInjuries,
} from "../api/lib/espn.js";

const player = process.argv[2] || "LeBron James";

const header = (s) => console.log("\n=== " + s + " ===");
const dump = (label, val) =>
  console.log(label + ":", JSON.stringify(val, null, 2));

console.log("Player:", player);
console.log("Season:", currentSeason());

const id = resolvePlayerId(player);
console.log("Resolved PlayerID:", id);

if (!id) {
  console.log("No ID configured. Stopping.");
  process.exit(0);
}

header("Season averages");
dump("season", await getSeasonAverages(id));

header("Last 5 games");
dump("l5", await getLastNGames(id, 5));

header("Home/Away splits");
dump("splits", await getHomeAwaySplits(id));

header("Common player info");
const info = await getCommonPlayerInfo(id);
dump("info", info);

header("Today's games (ESPN)");
const games = await getTodaysGames();
console.log("count:", games?.length ?? "null");
if (games) {
  for (const g of games) {
    console.log(
      `  ${g.away.abbr} @ ${g.home.abbr} [${g.state}] event=${g.game_id}`
    );
  }
}

if (info?.team_abbr && games) {
  header(`Game for ${info.team_abbr}`);
  const game = findGameForTeamAbbr(games, info.team_abbr);
  dump("game", game);
  if (game) {
    console.log("home/away:", homeAwayForTeam(game, info.team_abbr));
    const opp = opponentFor(game, info.team_abbr);
    console.log("opponent:", opp);

    header("Win probability");
    dump("win_prob", await getWinProbability(game.game_id, game.competition_id));

    if (opp) {
      header(`Injuries: ${opp.name}`);
      dump("opponent_injuries", await getTeamInjuries(opp.team_id));
    }
  } else {
    console.log("No game scheduled for this team today.");
  }
}
