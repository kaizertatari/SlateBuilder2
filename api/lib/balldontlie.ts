// balldontlie.io client. Used as a fallback when stats.nba.com 4xx's
// (e.g. Vercel's egress IPs are blocked from stats.nba.com).
//
// Auth: header `Authorization: <key>` (no "Bearer" prefix).
// Season convention: balldontlie uses the START year. 2025-26 → season=2025.

import { logPrefix } from "./request-context.ts";
import { fmtDate, normalizeLite } from "./string-utils.ts";
import { swr } from "./cache.ts";

const BASE = "https://api.balldontlie.io/v1";

// Teams change once a decade; players' team_abbr can change at the trade
// deadline. Both safe to cache for hours. Stale window doubles the freshness
// so an outage can serve a slightly old team_abbr rather than missing a pick.
const TEAMS_FRESH_MS = 24 * 60 * 60 * 1000;
const TEAMS_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYER_FRESH_MS = 6 * 60 * 60 * 1000;
const PLAYER_STALE_MS = 24 * 60 * 60 * 1000;

function authHeader() {
  const key = process.env.BALLDONTLIE_API_KEY;
  return key ? { Authorization: key } : null;
}

async function bdlFetch(path, params = {}) {
  const auth = authHeader();
  if (!auth) {
    console.error(`${logPrefix()}BALLDONTLIE_API_KEY not set`);
    return null;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const val of v) qs.append(k, val);
    else if (v != null) qs.set(k, String(v));
  }
  const url = `${BASE}${path}${qs.toString() ? "?" + qs.toString() : ""}`;
  try {
    const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`${logPrefix()}balldontlie ${path} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${logPrefix()}balldontlie ${path} threw:`, err.message);
    return null;
  }
}

function seasonStartYear(label) {
  if (typeof label === "number") return label;
  const m = String(label).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function parseMinutes(min) {
  if (typeof min !== "string") return min ?? null;
  const [m, s] = min.split(":").map(Number);
  if (Number.isNaN(m)) return null;
  return Number((m + (s || 0) / 60).toFixed(1));
}


async function getTeams() {
  // Cache as a plain object — swr won't reuse Map identity across instances
  // anyway, and JSON-shaped values play nicer with future cross-process moves.
  const obj = await swr("bdl:teams", async () => {
    const data = await bdlFetch("/teams");
    if (!data?.data) return null;
    return Object.fromEntries(data.data.map((t) => [t.id, t.abbreviation]));
  }, { freshTtlMs: TEAMS_FRESH_MS, staleTtlMs: TEAMS_STALE_MS });
  if (!obj) return null;
  return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
}

// Generational suffixes. We search by *first* name when one is present
// because the suffix implies a shared last name (e.g. Jabari Smith vs.
// Jabari Smith Jr.), so first name is more discriminative.
const SUFFIX_RE = /\s+(jr|sr|ii|iii|iv|v)\.?$/i;

function normName(s) {
  return normalizeLite(s.replace(SUFFIX_RE, ""));
}

export async function findPlayer(name) {
  // Wrap in an envelope so an unresolvable-name result still gets cached
  // (swr drops null values; we don't want to retry every call for a name
  // balldontlie can't resolve).
  const envelope = await swr(`bdl:player:${name}`, () => findPlayerUncached(name), {
    freshTtlMs: PLAYER_FRESH_MS,
    staleTtlMs: PLAYER_STALE_MS,
  });
  return envelope?.player ?? null;
}

async function findPlayerUncached(name) {
  const stripped = name.replace(SUFFIX_RE, "").trim();
  const parts = stripped.split(/\s+/).filter(Boolean);
  // Search by FIRST name — common surnames ("Williams", "Smith", "Johnson")
  // overflow the per_page cap and miss the target. First names are far more
  // discriminative ("Jalen" → ~7 hits vs. "Williams" → 100+).
  const searchToken = parts[0] || parts[parts.length - 1];
  const data = await bdlFetch("/players", { search: searchToken, per_page: 100 });
  if (!data?.data?.length) return { player: null };
  const fullLower = normalizeLite(name);
  // Tier 1: exact match with suffix preserved — disambiguates "Jabari Smith"
  // (elder, drafted 2000) from "Jabari Smith Jr." (current Rockets).
  const exactWithSuffix = data.data.find(
    (p) => normalizeLite(`${p.first_name} ${p.last_name}`) === fullLower
  );
  const target = normName(name);
  const lastNorm = normName(parts[parts.length - 1]);
  const exactFull = data.data.find((p) => normName(`${p.first_name} ${p.last_name}`) === target);
  // Tier 3: same last name + nickname (one first name is a prefix of the
  // other). Resolves "Steph Curry" → "Stephen Curry" but blocks
  // "Jalen Williams" → "Johnathan Williams" (which the old first-initial-only
  // rule accepted).
  const targetFirst = normalizeLite(parts[0] ?? "");
  const nicknameMatch = targetFirst && data.data.find((p) => {
    const apiFirst = normalizeLite(p.first_name);
    return normName(p.last_name) === lastNorm &&
      (apiFirst.startsWith(targetFirst) || targetFirst.startsWith(apiFirst));
  });
  const match = exactWithSuffix ?? exactFull ?? nicknameMatch;
  if (!match) return { player: null };
  if (!exactWithSuffix && !exactFull && nicknameMatch) {
    console.warn(`${logPrefix()}balldontlie nickname match for "${name}" → "${nicknameMatch.first_name} ${nicknameMatch.last_name}"`);
  }
  return {
    player: {
      id: match.id,
      full_name: `${match.first_name} ${match.last_name}`,
      team_id: match.team?.id ?? null,
      team_abbr: match.team?.abbreviation ?? null,
      team_name: match.team?.full_name ?? null,
    },
  };
}

export async function getSeasonAverages(playerName, { season } = {}) {
  const player = await findPlayer(playerName);
  if (!player) return null;
  const startYear = seasonStartYear(season);
  if (!startYear) return null;
  const data = await bdlFetch("/season_averages", {
    season: startYear,
    "player_ids[]": player.id,
  });
  const row = data?.data?.[0];
  if (!row) return null;
  return {
    season,
    season_type: "Regular Season",
    games: row.games_played,
    minutes: parseMinutes(row.min),
    ppg: row.pts,
    rpg: row.reb,
    apg: row.ast,
    fgm: row.fgm,
    fga: row.fga,
    fg_pct: row.fg_pct,
    fg3m: row.fg3m,
    fg3a: row.fg3a,
    fg3_pct: row.fg3_pct,
    ftm: row.ftm,
    fta: row.fta,
    ft_pct: row.ft_pct,
  };
}

export async function getLastNGames(playerName, n = 5, { season, postseason = false } = {}) {
  const player = await findPlayer(playerName);
  if (!player) return null;
  const startYear = seasonStartYear(season);
  if (!startYear) return null;

  const teams = await getTeams();

  const data = await bdlFetch("/stats", {
    "player_ids[]": player.id,
    "seasons[]": startYear,
    postseason: postseason,
    per_page: 100,
  });
  if (!data?.data?.length) return null;

  const sorted = [...data.data].sort(
    (a, b) => new Date(b.game.date).getTime() - new Date(a.game.date).getTime()
  );
  const games = sorted.slice(0, n).map((s) => {
    const g = s.game;
    const isHome = s.team.id === g.home_team_id;
    const oppId = isHome ? g.visitor_team_id : g.home_team_id;
    const oppAbbr = teams?.get(oppId) ?? "?";
    const ownAbbr = s.team.abbreviation;
    const teamScore = isHome ? g.home_team_score : g.visitor_team_score;
    const oppScore = isHome ? g.visitor_team_score : g.home_team_score;
    return {
      game_id: String(g.id),
      date: fmtDate(g.date),
      matchup: `${ownAbbr} ${isHome ? "vs." : "@"} ${oppAbbr}`,
      result: teamScore > oppScore ? "W" : teamScore < oppScore ? "L" : null,
      minutes: parseMinutes(s.min),
      pts: s.pts,
      reb: s.reb,
      ast: s.ast,
      fg3m: s.fg3m,
      fgm: s.fgm,
      fga: s.fga,
      fg_pct: s.fg_pct,
      pra: (s.pts ?? 0) + (s.reb ?? 0) + (s.ast ?? 0),
    };
  });
  if (!games.length) return null;

  const avg = (key) => Number(
    (games.reduce((a, g) => a + (g[key] ?? 0), 0) / games.length).toFixed(2)
  );
  return {
    season,
    season_type: postseason ? "Playoffs" : "Regular Season",
    n: games.length,
    games,
    averages: {
      ppg: avg("pts"),
      rpg: avg("reb"),
      apg: avg("ast"),
      fg3m: avg("fg3m"),
      fga: avg("fga"),
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
}
