// Single source of truth for the prop catalog. All three layers (UI,
// analyze.js, analyze-all.js) import from here so adding a stat is a
// one-file change.

// Canonical stat names — the UI lists these, the API validates against
// them, and PROP_TO_FIELD/mapPrizePicksStatType key off them.
export const STATS = [
  "Points",
  "Rebounds",
  "Assists",
  "PRA",
  "PR",
  "PA",
  "RA",
  "3-Pointers Made",
  "3-Pointers Attempted",
  "FG Attempted",
  "Blocks+Steals",
  "Fantasy Score",
];

// Stat name → key inside an averages object (groundTruth.season.averages,
// groundTruth.l5.averages). pra/pr/pa/ra are computed in ground-truth.js.
export const PROP_TO_FIELD = {
  Points: "ppg",
  Rebounds: "rpg",
  Assists: "apg",
  PRA: "pra",
  PR: "pr",
  PA: "pa",
  RA: "ra",
  "3-Pointers Made": "fg3m",
  "3-Pointers Attempted": "fg3a",
  "FG Attempted": "fga",
  "Blocks+Steals": "bs",
  "Fantasy Score": "fs",
};

// PrizePicks publishes stat types under abbreviated lowercase labels; map
// them onto the canonical STATS values above.
const PRIZEPICKS_TO_CANONICAL = {
  "pts+rebs+asts": "PRA",
  "pts+rebs": "PR",
  "pts+asts": "PA",
  "rebs+asts": "RA",
  "3-pt made": "3-Pointers Made",
  "3-pt attempted": "3-Pointers Attempted",
  "fg attempted": "FG Attempted",
  "points": "Points",
  "rebounds": "Rebounds",
  "assists": "Assists",
  "blks+stls": "Blocks+Steals",
  "fantasy score": "Fantasy Score",
};

export function mapPrizePicksStatType(statType) {
  if (!statType) return null;
  return PRIZEPICKS_TO_CANONICAL[statType.toLowerCase()] || null;
}
