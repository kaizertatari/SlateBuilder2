// Team + player name resolution for the EPL model, shared by the PrizePicks,
// DraftKings and FanDuel feeds. Everything resolves onto the model's ids:
// teams → FPL 3-letter abbr (registry.teams[*].abbr), players → FotMob player
// id (or "fpl:<id>" for prior-only entries).
//
// Books disagree on spelling: PrizePicks "Spurs"/"Forest"/"Villa", FanDuel
// "Man Utd"/"Nottm Forest", DraftKings "Tottenham"; player names differ by
// accents NFD can't strip (Kadıoğlu, Ødegaard), nicknames (Oli/Oliver) and
// long forms (Gabriel Magalhães vs "Gabriel").

import { normalizeName } from "../string-utils.js";

// Letters that don't decompose under NFD, so normalizeName keeps them.
const TRANSLIT = { ı: "i", ø: "o", Ø: "o", æ: "ae", Æ: "ae", ß: "ss", ł: "l", Ł: "l", đ: "d", Đ: "d", ð: "d", þ: "th", œ: "oe", Œ: "oe" };

// Hyphens become spaces first: normalizeName deletes them, which turns
// "Dewsbury-Hall" into "dewsburyhall" while books write "Dewsbury Hall".
export function normPlayer(name) {
  const t = String(name ?? "").replace(/[ıøØæÆßłŁđĐðþœŒ]/g, (c) => TRANSLIT[c] ?? c).replace(/[-‐‑]/g, " ");
  return normalizeName(t);
}

function normTeam(name) {
  return normalizeName(String(name ?? ""))
    .replace(/&/g, " and ")
    .replace(/\b(fc|afc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Book spellings that match neither FotMob's name/short name nor FPL's abbr.
const TEAM_ALIASES = {
  spurs: "TOT", tottenham: "TOT",
  forest: "NFO", "nottm forest": "NFO", "notts forest": "NFO",
  villa: "AVL",
  "man city": "MCI", "man utd": "MUN", "man united": "MUN",
  palace: "CRY", brighton: "BHA", "brighton and hove": "BHA",
  wolves: "WOL", "west ham": "WHU",
};

export function buildTeamResolver(registry) {
  const map = new Map(Object.entries(TEAM_ALIASES));
  for (const t of Object.values(registry?.teams ?? {})) {
    if (!t.abbr) continue;
    for (const n of [t.name, t.short, t.abbr]) if (n) map.set(normTeam(n), t.abbr);
  }
  return function resolveTeam(name) {
    const n = normTeam(name);
    if (!n) return null;
    if (map.has(n)) return map.get(n);
    // "Hull City AFC" → "hull city" → try progressively shorter prefixes.
    const words = n.split(" ");
    for (let k = words.length - 1; k >= 1; k--) {
      const hit = map.get(words.slice(0, k).join(" "));
      if (hit) return hit;
    }
    return null;
  };
}

/**
 * Player resolver over the model's players (fitted artifact) + FPL name
 * variants from the registry.
 * @returns {(name:string, teamAbbr?:string) => { id, name, how } | null}
 */
export function buildPlayerResolver(model, registry) {
  const abbrOf = (tid) => model.teams?.[tid]?.abbr ?? registry?.teams?.[tid]?.abbr ?? null;
  const byName = new Map(); // norm full name → [{ id, abbr }]
  const bySurname = new Map(); // `${abbr}|surname` → [id]
  const add = (map, key, val) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (!arr.some((x) => (x.id ?? x) === (val.id ?? val))) arr.push(val);
  };
  for (const [id, p] of Object.entries(model.players ?? {})) {
    const abbr = abbrOf(p.team_id);
    const reg = registry?.players?.[id];
    const names = [p.name, reg?.fpl_name, reg?.first_name && reg?.second_name ? `${reg.first_name} ${reg.second_name}` : null];
    for (const n of names) if (n) add(byName, normPlayer(n), { id, abbr });
    const surname = normPlayer(p.name).split(" ").pop();
    if (abbr && surname) add(bySurname, `${abbr}|${surname}`, id);
  }
  // Prior-only players ("fpl:<id>") are known by their FPL short name too
  // (Joelinton's full FPL name is five words long).
  for (const f of registry?.fpl_only ?? []) {
    const id = `fpl:${f.fpl_id}`;
    if (!model.players?.[id]) continue;
    for (const n of [f.fpl_name, f.name]) if (n) add(byName, normPlayer(n), { id, abbr: f.abbr ?? null });
  }
  return function resolvePlayer(name, teamAbbr = null) {
    const n = normPlayer(name);
    if (!n) return null;
    const cands = byName.get(n) ?? [];
    const onTeam = teamAbbr ? cands.filter((c) => c.abbr === teamAbbr) : cands;
    if (onTeam.length === 1) return { id: onTeam[0].id, how: "name" };
    if (!teamAbbr && cands.length === 1) return { id: cands[0].id, how: "name" };
    if (teamAbbr) {
      // Any name part as the surname within the team, last part first:
      // Oli/Oliver McBurnie, "Gabriel Magalhães" → Gabriel, "Carlos Baleba
      // Noom" → Baleba, "Mohamed-Ali Cho Momo" → Cho.
      const parts = n.split(" ");
      for (const s of [parts[parts.length - 1], parts[0], ...parts.slice(1, -1)]) {
        const ids = bySurname.get(`${teamAbbr}|${s}`) ?? [];
        if (ids.length === 1) return { id: ids[0], how: "surname" };
      }
      // Name known on another team (a transfer the snapshot hasn't seen).
      if (cands.length === 1) return { id: cands[0].id, how: "name_other_team" };
    }
    return null;
  };
}
