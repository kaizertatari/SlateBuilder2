// Display name -> { nba: stats.nba.com PERSON_ID, espn: ESPN athlete id }.
// Names match src/App.jsx NBA_PLAYERS exactly.
//
// Regenerate via: node scripts/build-espn-ids.mjs (one-time, hits ESPN search).
// Players omitted here resolve to null and the orchestrator returns SKIP
// with a clear flag.

export const PLAYER_INFO = {
  "Alperen Sengun":         { nba: 1630578, espn: 4871144 },
  "Anthony Davis":          { nba: 203076,  espn: 6583    },
  "Anthony Edwards":        { nba: 1630162, espn: 4594268 },
  "Bam Adebayo":            { nba: 1628389, espn: 4066261 },
  "CJ McCollum":            { nba: 203468,  espn: 2490149 },
  "Cade Cunningham":        { nba: 1630595, espn: 4432166 },
  "Damian Lillard":         { nba: 203081,  espn: 6606    },
  "Darius Garland":         { nba: 1629636, espn: 4396907 },
  "De'Aaron Fox":           { nba: 1628368, espn: 4066259 },
  "DeMar DeRozan":          { nba: 201942,  espn: 3978    },
  "Devin Booker":           { nba: 1626164, espn: 3136193 },
  "Donovan Mitchell":       { nba: 1628378, espn: 3908809 },
  "Evan Mobley":            { nba: 1630596, espn: 4432158 },
  "Franz Wagner":           { nba: 1630532, espn: 4566434 },
  "Fred VanVleet":          { nba: 1627832, espn: 2991230 },
  "Giannis Antetokounmpo":  { nba: 203507,  espn: 3032977 },
  "Jalen Brunson":          { nba: 1628973, espn: 3934672 },
  "Jalen Johnson":          { nba: 1630552, espn: 4701230 },
  "James Harden":           { nba: 201935,  espn: 3992    },
  "Jarrett Allen":          { nba: 1628386, espn: 4066328 },
  "Jaylen Brown":           { nba: 1627759, espn: 3917376 },
  "Jayson Tatum":           { nba: 1628369, espn: 4065648 },
  "Jimmy Butler":           { nba: 202710,  espn: 6430    },
  "Joel Embiid":            { nba: 203954,  espn: 3059318 },
  "Josh Hart":              { nba: 1628404, espn: 3062679 },
  "Julius Randle":          { nba: 203944,  espn: 3064514 },
  "Karl-Anthony Towns":     { nba: 1626157, espn: 3136195 },
  "Kevin Durant":           { nba: 201142,  espn: 3202    },
  "LaMelo Ball":            { nba: 1630163, espn: 4432816 },
  "LeBron James":           { nba: 2544,    espn: 1966    },
  "Luka Doncic":            { nba: 1629029, espn: 3945274 },
  "Mikal Bridges":          { nba: 1628969, espn: 3147657 },
  "Nickeil Alexander-Walker": { nba: 1629638, espn: 4278039 },
  "Nikola Jokic":           { nba: 203999,  espn: 3112335 },
  "OG Anunoby":             { nba: 1628384, espn: 3934719 },
  "Onyeka Okongwu":         { nba: 1630168, espn: 4431680 },
  "Paolo Banchero":         { nba: 1631094, espn: 4432573 },
  "RJ Barrett":             { nba: 1629628, espn: 4395625 },
  "Scottie Barnes":         { nba: 1630567, espn: 4433134 },
  "Shai Gilgeous-Alexander": { nba: 1628983, espn: 4278073 },
  "Stephen Curry":          { nba: 201939,  espn: 3975    },
  "Trae Young":             { nba: 1629027, espn: 4277905 },
  "Tyler Herro":            { nba: 1629639, espn: 4395725 },
  "Tyrese Haliburton":      { nba: 1630169, espn: 4396993 },
  "Victor Wembanyama":      { nba: 1641705, espn: 5104157 },
  "Zach LaVine":            { nba: 203897,  espn: 3064440 },
};

// Back-compat helper used by analyze.js + smoke scripts.
export function resolvePlayerId(name) {
  return PLAYER_INFO[name]?.nba ?? null;
}

export function resolveEspnId(name) {
  return PLAYER_INFO[name]?.espn ?? null;
}

// Legacy export retained for build-espn-ids.mjs and any other consumers
// that just want { name: nba_id }.
export const PLAYER_IDS = Object.fromEntries(
  Object.entries(PLAYER_INFO).map(([k, v]) => [k, v.nba])
);
