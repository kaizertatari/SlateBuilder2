// Display name -> stats.nba.com PERSON_ID.
// Names match src/App.jsx NBA_PLAYERS exactly.
//
// To regenerate / verify, fetch (with the headers in nba-stats.js):
//   https://stats.nba.com/stats/commonallplayers?LeagueID=00&Season=2025-26&IsOnlyCurrentSeason=1
// then map DISPLAY_FIRST_LAST -> PERSON_ID from resultSets[0].rowSet.
//
// Players omitted from this map (e.g. recent draftees not yet verified) will
// resolve to null and the orchestrator returns SKIP with a clear flag.

export const PLAYER_IDS = {
  "Jalen Brunson": 1628973,
  "Karl-Anthony Towns": 1626157,
  "OG Anunoby": 1628384,
  "Mikal Bridges": 1628969,
  "Josh Hart": 1628404,
  "Jalen Johnson": 1630552,
  "CJ McCollum": 203468,
  "Nickeil Alexander-Walker": 1629638,
  "Onyeka Okongwu": 1630168,
  "Victor Wembanyama": 1641705,
  "LaMelo Ball": 1630163,
  "Shai Gilgeous-Alexander": 1628983,
  "Donovan Mitchell": 1628378,
  "Evan Mobley": 1630596,
  "Jarrett Allen": 1628386,
  "Devin Booker": 1626164,
  "Paolo Banchero": 1631094,
  "James Harden": 201935,
  "Kevin Durant": 201142,
  "Giannis Antetokounmpo": 203507,
  "Jayson Tatum": 1628369,
  "Jaylen Brown": 1627759,
  "Anthony Davis": 203076,
  "LeBron James": 2544,
  "Stephen Curry": 201939,
  "Nikola Jokic": 203999,
  "Joel Embiid": 203954,
  "Damian Lillard": 203081,
  "Trae Young": 1629027,
  "Luka Doncic": 1629029,
  "Anthony Edwards": 1630162,
  "Cade Cunningham": 1630595,
  "Tyrese Haliburton": 1630169,
  "Darius Garland": 1629636,
  "De'Aaron Fox": 1628368,
  "Zach LaVine": 203897,
  "Julius Randle": 203944,
  "DeMar DeRozan": 201942,
  "Jimmy Butler": 202710,
  "Bam Adebayo": 1628389,
  "Tyler Herro": 1629639,
  "Scottie Barnes": 1630567,
  "RJ Barrett": 1629628,
  "Franz Wagner": 1630532,
  "Alperen Sengun": 1630578,
  "Fred VanVleet": 1627832,
  // Recent rookies / 2025 draft — left out until verified at runtime:
  //   "Cooper Flagg", "Kon Knueppel", "Dyson Daniels", "Moussa Diabate"
};

export function resolvePlayerId(playerName) {
  return PLAYER_IDS[playerName] ?? null;
}
