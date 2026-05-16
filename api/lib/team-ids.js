// Authoritative team-id ↔ abbreviation mappings for NBA and WNBA. Single
// source of truth for both api/ runtime and offline scripts. ESPN's
// abbreviations differ in a few cases (handled in api/lib/espn.js).

export const TEAM_ID_BY_ABBR = {
  ATL: 1610612737, BOS: 1610612738, CLE: 1610612739, NOP: 1610612740,
  CHI: 1610612741, DAL: 1610612742, DEN: 1610612743, GSW: 1610612744,
  HOU: 1610612745, LAC: 1610612746, LAL: 1610612747, MIA: 1610612748,
  MIL: 1610612749, MIN: 1610612750, BKN: 1610612751, NYK: 1610612752,
  ORL: 1610612753, IND: 1610612754, PHI: 1610612755, PHX: 1610612756,
  POR: 1610612757, SAC: 1610612758, SAS: 1610612759, OKC: 1610612760,
  TOR: 1610612761, UTA: 1610612762, MEM: 1610612763, WAS: 1610612764,
  DET: 1610612765, CHA: 1610612766,
};

export const ABBR_BY_TEAM_ID = Object.fromEntries(
  Object.entries(TEAM_ID_BY_ABBR).map(([abbr, id]) => [id, abbr])
);

// WNBA team IDs (stats.wnba.com convention). 15 teams as of 2026 (13
// holdovers + Portland Fire and Toronto Tempo expansion). Abbreviations
// match stats.wnba.com — PrizePicks publishes slight variants (LV, LA, NY,
// GS) which are aliased to these in api/lib/espn.js.
//
// POR/TOR team IDs are not yet known until stats.wnba.com publishes their
// rosters; they live in the map without an ID so the def_rank lookup
// returns null cleanly (framework caps at A-tier when opponent_defense is
// absent — same fallback as any other missing-data path).
export const WNBA_TEAM_ID_BY_ABBR = {
  ATL: 1611661330, // Atlanta Dream
  CHI: 1611661329, // Chicago Sky
  CON: 1611661323, // Connecticut Sun
  DAL: 1611661321, // Dallas Wings
  GSV: 1611661331, // Golden State Valkyries (2025 expansion)
  IND: 1611661325, // Indiana Fever
  LAS: 1611661324, // Los Angeles Sparks
  LVA: 1611661319, // Las Vegas Aces
  MIN: 1611661322, // Minnesota Lynx
  NYL: 1611661313, // New York Liberty
  PHX: 1611661317, // Phoenix Mercury
  POR: null,       // Portland Fire (2026 expansion — id pending)
  SEA: 1611661328, // Seattle Storm
  TOR: null,       // Toronto Tempo (2026 expansion — id pending)
  WAS: 1611661320, // Washington Mystics
};

export const WNBA_ABBR_BY_TEAM_ID = Object.fromEntries(
  Object.entries(WNBA_TEAM_ID_BY_ABBR)
    .filter(([, id]) => id != null)
    .map(([abbr, id]) => [id, abbr])
);

// League-aware lookups. league: "NBA" | "WNBA" (default "NBA" for legacy
// callers). Pass an unknown abbr → undefined, same as the underlying maps.
// Pass an abbr whose value is intentionally null (e.g. POR pending) → null
// — distinguish "we know the team, no id yet" from "we don't know this
// team" upstream by checking for `null` vs `undefined`.
export function teamIdByAbbr(abbr, league = "NBA") {
  const map = league === "WNBA" ? WNBA_TEAM_ID_BY_ABBR : TEAM_ID_BY_ABBR;
  return map[String(abbr || "").toUpperCase()];
}

export function abbrByTeamId(teamId, league = "NBA") {
  const map = league === "WNBA" ? WNBA_ABBR_BY_TEAM_ID : ABBR_BY_TEAM_ID;
  return map[teamId];
}
