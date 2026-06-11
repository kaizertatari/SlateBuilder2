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

// World Cup (soccer) — v1 Shots/SOT plus the v2 expansion
// (WC_FRAMEWORK_SPEC.md §10). Still-excluded stats are listed in §9.
export const SOCCER_STATS = [
  "Shots",
  "Shots On Target",
  "Tackles",
  "Goalie Saves",
  "Clearances",
  "Passes Attempted",
  "Outfield Fantasy Score",
];

// Per-stat WC model config (spec §10.1) — the single switchboard the
// scrapers, ground truth, projection, and rules all key off:
//   dist        "poisson" | "normal_od" (overdispersed count, Var = φλ) |
//               "normal" (composite via moment matching)
//   field       key inside groundTruth.soccer.lambda (and PROP_TO_FIELD)
//   modelLed    true ⇒ no sharp anchor exists for this stat — market-edge
//               applies a B-tier cap instead of the no-ladder hard SKIP,
//               and wc-projection becomes the spine (spec §10.2)
//   gk          "only" (non-GK SKIP) | "allowed" | "skip" (GK SKIP; default)
export const WC_STAT_MODEL = {
  Shots: { dist: "poisson", field: "shots", modelLed: false, gk: "skip" },
  "Shots On Target": { dist: "poisson", field: "sot", modelLed: false, gk: "skip" },
  Tackles: { dist: "poisson", field: "tackles", modelLed: false, gk: "skip" },
  "Goalie Saves": { dist: "poisson", field: "saves", modelLed: false, gk: "only" },
  Clearances: { dist: "poisson", field: "clearances", modelLed: true, gk: "skip" },
  "Passes Attempted": { dist: "normal_od", field: "passes_att", phi: 3.5, modelLed: true, gk: "allowed" },
  "Outfield Fantasy Score": { dist: "normal", field: "fantasy", composite: true, modelLed: true, gk: "skip" },
};

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
  Tackles: "tackles",
  "Goalie Saves": "saves",
  Clearances: "clearances",
  "Passes Attempted": "passes_att",
  "Outfield Fantasy Score": "fantasy",
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
  "tackles": "Tackles",
  "goalie saves": "Goalie Saves",
  "clearances": "Clearances",
  "passes attempted": "Passes Attempted",
  "outfield fantasy score": "Outfield Fantasy Score",
};

export function mapPrizePicksStatType(statType) {
  if (!statType) return null;
  return PRIZEPICKS_TO_CANONICAL[statType.toLowerCase()] || null;
}
