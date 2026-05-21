import fs from "node:fs";
import { getSeasonAverages, getLastNGames } from "../api/lib/espn-stats.js";

const players = JSON.parse(fs.readFileSync("data/players.json", "utf8"));
const targets = [
  "A'ja Wilson",
  "Breanna Stewart",
  "Caitlin Clark",
  "Angel Reese",
  "Sabrina Ionescu",
  "Napheesa Collier",
  "Alyssa Thomas",
  "Jewell Loyd",
  "Arike Ogunbowale",
  "Nneka Ogwumike",
  "Paige Bueckers",
  "Kelsey Plum",
];

for (const name of targets) {
  const e = players[name];
  if (!e?.espn) {
    console.log(`-- ${name}: no espn id in players.json`);
    continue;
  }
  const avg = await getSeasonAverages(e.espn, { season: "2026", league: "WNBA" });
  const l5 = await getLastNGames(e.espn, 5, { season: "2026", postseason: false, league: "WNBA" });
  if (!avg) {
    console.log(`-- ${name} (${e.espn} / ${e.team_abbr}): no 2026 season data`);
    continue;
  }
  console.log(
    `${name.padEnd(20)} (${e.espn}/${e.team_abbr ?? "?"}) ` +
    `g=${avg.games} min=${avg.minutes} ppg=${avg.ppg} rpg=${avg.rpg} apg=${avg.apg} ` +
    `fg%=${avg.fg_pct} 3p%=${avg.fg3_pct} ft%=${avg.ft_pct} ` +
    `| l5 n=${l5?.n ?? 0} ppg=${l5?.averages?.ppg ?? "-"}`
  );
}
