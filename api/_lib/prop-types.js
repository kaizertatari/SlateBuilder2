// Single source of truth for the prop catalog. All three layers (UI,
// analyze.js, analyze-all.js) import from here so adding a stat is a
// one-file change.

// Canonical stat names — the UI lists these, the API validates against
// them, and PROP_TO_FIELD/mapPrizePicksStatType key off them.
export const BASKETBALL_STATS = [
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

// World Cup (soccer) v1 covers Shots + SOT only — see WC_FRAMEWORK_SPEC.md §9
// for what's deliberately excluded (fouls/tackles/goals/cards/passes).
export const SOCCER_STATS = [
  "Shots",
  "Shots On Target",
];

// Full whitelist (cross-league). League-aware callers (UI stat picker,
// slate filters) should use STATS_BY_LEAGUE instead so basketball lists
// don't grow soccer entries and vice versa.
export const STATS = [...BASKETBALL_STATS, ...SOCCER_STATS];

export const STATS_BY_LEAGUE = {
  NBA: BASKETBALL_STATS,
  WNBA: BASKETBALL_STATS,
  WC: SOCCER_STATS,
};

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
  // Soccer (WC): keys inside soccer ground-truth averages objects.
  Shots: "shots",
  "Shots On Target": "sot",
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
  // Soccer (WC). PrizePicks publishes these capitalized; keys here are
  // lowercase because mapPrizePicksStatType lowercases before lookup.
  "shots": "Shots",
  "shots on target": "Shots On Target",
};

export function mapPrizePicksStatType(statType) {
  if (!statType) return null;
  return PRIZEPICKS_TO_CANONICAL[statType.toLowerCase()] || null;
}
