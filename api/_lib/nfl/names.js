// NFL name resolution: PrizePicks / DraftKings / FanDuel spellings → nflverse
// team abbreviations and gsis player ids (the model artifact's keys).
//
// Players resolve in order: alias table → exact normalized name on the team
// → exact name anywhere (unique) → last name + first initial on the team
// (unique; covers "Cam"/"Cameron", "Hollywood"/"Marquise" needs the alias).
// Suffixes (Jr./Sr./II/III), punctuation and accents are dropped first, so
// "Kyle Pitts Sr." and "Marvin Mims" match "Kyle Pitts" / "Marvin Mims Jr.".

import { teamAbbr, TEAM_BY_NICKNAME } from "./market.js";

// PrizePicks / book abbreviations that differ from nflverse.
const ABBR_ALIASES = { LAR: "LA", WSH: "WAS", JAC: "JAX", LVR: "LV", OAK: "LV", SD: "LAC", STL: "LA", GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB" };
const NFLVERSE = new Set(Object.values(TEAM_BY_NICKNAME));

/** "LAR" / "Los Angeles Rams" / "Rams" / "LA" → "LA" (null when unknown). */
export function nflTeam(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (NFLVERSE.has(up)) return up;
  if (ABBR_ALIASES[up]) return ABBR_ALIASES[up];
  return teamAbbr(raw);
}

// Book/PrizePicks spelling → nflverse registry spelling (normalized form is
// matched, so only genuine nicknames belong here).
export const PLAYER_ALIASES = {
  "hollywood brown": "marquise brown",
  "gabe davis": "gabriel davis",
  "chig okonkwo": "chigoziem okonkwo",
  "josh palmer": "joshua palmer",
  "tank dell": "nathaniel dell",
  "scotty miller": "scott miller",
};

export function normName(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/-/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {Object<string,{name?:string, team?:string, roster_team?:string, last?:{season:number,week:number}}>} players
 *   model.players (build-nfl-model attaches name + roster_team)
 * @returns {(name:string, team?:string|null) => string|null}  gsis id
 */
export function buildPlayerResolver(players) {
  const byName = new Map(); // norm → [id]
  const byLastInit = new Map(); // "last|f|team" → [id]
  for (const [id, p] of Object.entries(players || {})) {
    if (!p.name) continue;
    const n = normName(p.name);
    (byName.get(n) ?? byName.set(n, []).get(n)).push(id);
    const parts = n.split(" ");
    if (parts.length >= 2) {
      for (const t of new Set([p.team, p.roster_team].filter(Boolean))) {
        const k = `${parts.slice(1).join(" ")}|${parts[0][0]}|${t}`;
        (byLastInit.get(k) ?? byLastInit.set(k, []).get(k)).push(id);
      }
    }
  }
  const onTeam = (id, team) => !team || players[id].team === team || players[id].roster_team === team;
  // Most recent appearance wins a same-name tie on one team.
  const recent = (ids) => [...ids].sort((a, b) => {
    const x = players[a].last ?? {}, y = players[b].last ?? {};
    return (y.season ?? 0) - (x.season ?? 0) || (y.week ?? 0) - (x.week ?? 0);
  })[0];
  return (name, team = null) => {
    let n = normName(name);
    n = PLAYER_ALIASES[n] ?? n;
    const ids = byName.get(n) ?? [];
    const mine = ids.filter((id) => onTeam(id, team));
    if (mine.length) return recent(mine);
    if (ids.length === 1) return ids[0];
    const parts = n.split(" ");
    if (team && parts.length >= 2) {
      const cand = byLastInit.get(`${parts.slice(1).join(" ")}|${parts[0][0]}|${team}`) ?? [];
      if (cand.length === 1) return cand[0];
    }
    return null;
  };
}
