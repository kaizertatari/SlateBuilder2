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

// Premier League (PrizePicks league 14) — canonical names are PrizePicks'
// own labels. Priced by the EPL verdict engine (api/_lib/epl/verdict.js),
// not the basketball rule engine. "Goalie Fantasy Score" is deliberately
// absent: PrizePicks' keeper scoring isn't modelled.
export const EPL_STATS = [
  "Shots",
  "Shots On Target",
  "Goals",
  "Assists",
  "Goal + Assist",
  "Shots Assisted",
  "Tackles",
  "Fouls",
  "Passes Attempted",
  "Clearances",
  "Crosses",
  "Attempted Dribbles",
  "Goalie Saves",
  "Goals Allowed",
  "Outfield Fantasy Score",
];

// NFL display labels (api/_lib/nfl/verdict.js NFL_STAT_LABEL order). The
// NFL engine maps PrizePicks spellings itself (mapNflStat) — PrizePicks'
// NFL names are unverified until the board is captured, and "Fantasy
// Score" would collide with basketball's here.
export const NFL_STATS = [
  "Pass Yards",
  "Pass Attempts",
  "Pass Completions",
  "Pass TDs",
  "INT",
  "Rush Yards",
  "Rush Attempts",
  "Receiving Yards",
  "Receptions",
  "Rec Targets",
  "Rush+Rec Yds",
  "Pass+Rush Yds",
  "Rush+Rec TDs",
  "Fantasy Score",
  "Tackles+Ast",
  "Sacks",
  "FG Made",
  "Kicking Points",
];

// Full whitelist (cross-league). League-aware callers (UI stat picker,
// slate filters) should use STATS_BY_LEAGUE so per-league lists stay
// independent ("Assists" is shared by name across sports).
export const STATS = [...new Set([...BASKETBALL_STATS, ...EPL_STATS])];

export const STATS_BY_LEAGUE = {
  NBA: BASKETBALL_STATS,
  WNBA: BASKETBALL_STATS,
  EPL: EPL_STATS,
  NFL: NFL_STATS,
};

// Slate-builder calibration gate (shared by the API + UI so they agree).
// A league only publishes a slate EV once its standard-line calibration is
// validated — otherwise the market-fair probs are trusted blind and read as
// wildly +EV (see slate-builder-pivot). PENDING maps league → the target
// checkpoint surfaced to users while its outcomes are still ungraded.
export const SLATE_CALIBRATED_LEAGUES = ["WNBA"];
// Shadow mode: verdicts + would-be slates are computed and logged, but no
// slate EV is published until the target below is met. EPL: until ~150 EPL
// picks are graded. NBA (2026-10-13): the basketball rules engine graded
// badly on WNBA 09-13→10-13 (tiers inverted, model probs worse than a coin
// flip), so NBA stays in shadow until basketball is ported to the
// probability + market-blend pipeline and re-validated.
export const SLATE_PENDING_LEAGUES = {
  EPL: "~150 graded EPL picks",
  NBA: "basketball port to the probability pipeline + ~150 graded NBA picks",
  NFL: "~150 graded NFL picks",
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
  // EPL (identity onto EPL_STATS; "assists" above is shared)
  "shots": "Shots",
  "shots on target": "Shots On Target",
  "goals": "Goals",
  "goal + assist": "Goal + Assist",
  "shots assisted": "Shots Assisted",
  "tackles": "Tackles",
  "fouls": "Fouls",
  "passes attempted": "Passes Attempted",
  "clearances": "Clearances",
  "crosses": "Crosses",
  "attempted dribbles": "Attempted Dribbles",
  "goalie saves": "Goalie Saves",
  "goals allowed": "Goals Allowed",
  "outfield fantasy score": "Outfield Fantasy Score",
};

export function mapPrizePicksStatType(statType) {
  if (!statType) return null;
  return PRIZEPICKS_TO_CANONICAL[statType.toLowerCase()] || null;
}
