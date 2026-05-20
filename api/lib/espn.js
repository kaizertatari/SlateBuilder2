// ESPN public APIs. No auth, no special headers required.
// Used for game schedule, win probability, and injury reports — fields that
// stats.nba.com doesn't expose cleanly.

import * as cache from "./cache.js";
import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";

const LEAGUE_SLUG = { NBA: "nba", WNBA: "wnba" };

function leagueSlug(league) {
  return LEAGUE_SLUG[league] ?? "nba";
}

function scoreboardUrl(league) {
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/${leagueSlug(league)}/scoreboard`;
}

function coreUrl(league) {
  return `https://sports.core.api.espn.com/v2/sports/basketball/leagues/${leagueSlug(league)}`;
}

function siteUrl(league) {
  return `https://site.api.espn.com/apis/site/v2/sports/basketball/${leagueSlug(league)}`;
}

const TTL_SCOREBOARD_MS = 60_000;
const TTL_INJURIES_FRESH_MS = 120_000;
const TTL_INJURIES_STALE_MS = 600_000;

// 8s upstream timeout. Bounds inflight SWR promise lifetime — without it, a
// hung connection would pin the inflight entry past the stale window and
// cold callers would await a dead promise.
async function jsonFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // ESPN is normally reliable, so any non-2xx is news. Treat 408/429
      // as warn (transient backoff worth retrying); the rest as error.
      const level = (res.status === 408 || res.status === 429) ? "warn" : "error";
      console.error(`${logPrefix()}espn ${url} ${res.status}`);
      logEvent({
        level,
        source: "espn",
        message: `espn ${url} HTTP ${res.status}`,
        errorStatus: res.status,
        context: { url },
      });
      return null;
    }
    return await res.json();
  } catch (err) {
    const isTimeout = err.name === "AbortError" || /timeout/i.test(err.message);
    console.error(`${logPrefix()}espn ${url} threw:`, err.message);
    logEvent({
      level: isTimeout ? "warn" : "error",
      source: "espn",
      message: `espn ${url} threw: ${err.message}`,
      errorName: err.name,
      context: { url, timeout_ms: 8000 },
    });
    return null;
  }
}

function parseEvent(event) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === "home");
  const away = comp.competitors?.find((c) => c.homeAway === "away");
  if (!home || !away) return null;
  return {
    game_id: event.id,
    competition_id: comp.id,
    date: event.date,
    status: event.status?.type?.name,
    state: event.status?.type?.state, // "pre" | "in" | "post"
    // Playoff series state, present only on playoff events. Authoritative —
    // ground-truth uses this to avoid reconstructing series from gamelog.
    series: comp.series ?? null,
    round: comp.type?.abbreviation ?? null, // e.g. "RD16" | "RD8" | "RD4" | "RD2"
    home: {
      team_id: home.team.id,
      name: home.team.displayName,
      abbr: home.team.abbreviation,
    },
    away: {
      team_id: away.team.id,
      name: away.team.displayName,
      abbr: away.team.abbreviation,
    },
  };
}

export async function getTodaysGames(date, { league = "NBA" } = {}) {
  // date: optional "YYYYMMDD"
  const cacheKey = `scoreboard:${league}:${date ?? "today"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const base = scoreboardUrl(league);
  const url = date ? `${base}?dates=${date}` : base;
  const data = await jsonFetch(url);
  if (!data) return null;
  const events = (data.events || []).map(parseEvent).filter(Boolean);
  cache.set(cacheKey, events, TTL_SCOREBOARD_MS);
  return events;
}

// stats.nba.com and ESPN disagree on a handful of team abbreviations. Normalise
// stats-side abbrs onto ESPN's spelling before comparing scoreboard events.
const NBA_TO_ESPN_ABBR = {
  NYK: "NY",
  SAS: "SA",
  NOP: "NO",
  GSW: "GS",
  UTA: "UTAH",
  WAS: "WSH",
};

// WNBA: stats.wnba.com uses 3-letter codes (LVA, LAS, NYL, GSV); ESPN uses
// shorter forms (LV, LA, NY, GS) in most endpoints. PrizePicks publishes the
// shorter forms too. Keep both directions of the alias in sync.
const WNBA_TO_ESPN_ABBR = {
  LVA: "LV",
  LAS: "LA",
  NYL: "NY",
  GSV: "GS",
};

const ESPN_TO_NBA_ABBR = Object.fromEntries(
  Object.entries(NBA_TO_ESPN_ABBR).map(([nba, espn]) => [espn, nba])
);

const ESPN_TO_WNBA_ABBR = Object.fromEntries(
  Object.entries(WNBA_TO_ESPN_ABBR).map(([wnba, espn]) => [espn, wnba])
);

export function toEspnAbbr(abbr, league = "NBA") {
  if (!abbr) return null;
  const upper = abbr.toUpperCase();
  const map = league === "WNBA" ? WNBA_TO_ESPN_ABBR : NBA_TO_ESPN_ABBR;
  return map[upper] || upper;
}

export function toNbaAbbr(abbr, league = "NBA") {
  if (!abbr) return null;
  const upper = abbr.toUpperCase();
  const map = league === "WNBA" ? ESPN_TO_WNBA_ABBR : ESPN_TO_NBA_ABBR;
  return map[upper] || upper;
}

export function findGameForTeamAbbr(games, abbr, { league = "NBA" } = {}) {
  if (!games || !abbr) return null;
  const upper = toEspnAbbr(abbr, league);
  return (
    games.find(
      (g) => g.home.abbr === upper || g.away.abbr === upper
    ) || null
  );
}

function formatYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// Fetches the next `daysAhead` scoreboards in parallel, then picks the
// smallest days_out match. Returns { game, days_out } or null. The serial
// version's worst case was ~8s on cold days; parallel is bounded by ESPN's
// slowest single-day response (~1-2s). Cached scoreboard hits become free.
export async function findNextGameForTeamAbbr(abbr, daysAhead = 7, { league = "NBA" } = {}) {
  if (!abbr) return null;
  const upper = toEspnAbbr(abbr, league);
  const today = new Date();

  const dayResults = await Promise.all(
    Array.from({ length: daysAhead + 1 }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() + i);
      return getTodaysGames(formatYYYYMMDD(d), { league });
    })
  );

  for (let i = 0; i < dayResults.length; i++) {
    const games = dayResults[i];
    if (!games?.length) continue;
    const found = games.find(
      (g) => g.home.abbr === upper || g.away.abbr === upper
    );
    if (found) return { game: found, days_out: i };
  }
  return null;
}

export function homeAwayForTeam(game, abbr, { league = "NBA" } = {}) {
  if (!game) return null;
  const upper = toEspnAbbr(abbr, league);
  if (game.home.abbr === upper) return "home";
  if (game.away.abbr === upper) return "away";
  return null;
}

export function opponentFor(game, abbr, { league = "NBA" } = {}) {
  if (!game) return null;
  const upper = toEspnAbbr(abbr, league);
  if (game.home.abbr === upper) return game.away;
  if (game.away.abbr === upper) return game.home;
  return null;
}

function pickGameProjection(side) {
  const stat = side?.statistics?.find((s) => s.name === "gameProjection");
  if (!stat || stat.value == null) return null;
  return stat.value > 1 ? stat.value / 100 : stat.value; // ESPN reports 0–100; normalise to 0–1
}

export async function getWinProbability(eventId, competitionId, { league = "NBA" } = {}) {
  if (!eventId || !competitionId) return null;
  const CORE = coreUrl(league);
  // Pre-game: ESPN's BPI predictor.
  const predictor = await jsonFetch(
    `${CORE}/events/${eventId}/competitions/${competitionId}/predictor`
  );
  if (predictor) {
    const home = pickGameProjection(predictor.homeTeam);
    const away = pickGameProjection(predictor.awayTeam);
    if (home != null || away != null) {
      return {
        source: "predictor",
        home_win_pct: home ?? (away != null ? 1 - away : null),
        away_win_pct: away ?? (home != null ? 1 - home : null),
      };
    }
  }
  // In-game / post-game fallback.
  const probs = await jsonFetch(
    `${CORE}/events/${eventId}/competitions/${competitionId}/probabilities?limit=200`
  );
  const items = probs?.items || [];
  if (!items.length) return null;
  const latest = items[items.length - 1];
  const home = latest.homeWinPercentage;
  const away = latest.awayWinPercentage;
  if (home == null && away == null) return null;
  return {
    source: "probabilities",
    home_win_pct: home,
    away_win_pct: away ?? (home != null ? 1 - home : null),
  };
}

function normalizeInjury(entry) {
  return {
    player: entry.athlete?.displayName || entry.athlete?.fullName || null,
    status: entry.status || entry.type?.description || null,
    type: entry.type?.description || entry.details?.type || null,
    detail: entry.shortComment || entry.longComment || entry.details?.detail || null,
    date: entry.date || null,
  };
}

export async function getAllInjuries({ league = "NBA" } = {}) {
  return cache.swr(
    `injuries:all:${league}`,
    async () => {
      const SITE = siteUrl(league);
      const data = await jsonFetch(`${SITE}/injuries`);
      if (!data) return null;
      const groups = data.injuries || [];
      return groups.map((g) => ({
        team_id: String(g.id),
        team_name: g.displayName,
        injuries: (g.injuries || []).map(normalizeInjury),
      }));
    },
    { freshTtlMs: TTL_INJURIES_FRESH_MS, staleTtlMs: TTL_INJURIES_STALE_MS }
  );
}

export async function getTeamInjuries(teamId, { league = "NBA" } = {}) {
  if (!teamId) return null;
  const all = await getAllInjuries({ league });
  if (!all) return null;
  const id = String(teamId);
  const group = all.find((g) => g.team_id === id);
  return group?.injuries ?? [];
}
