// ESPN athlete-stats client — fallback for stats.nba.com (which 4xxs from
// Vercel egress IPs). One gamelog call covers both season averages and L5,
// since ESPN buckets events by season type (Regular / Postseason) and
// includes per-game positional stat arrays.
//
// Endpoint: site.web.api.espn.com/.../athletes/{id}/gamelog?season={endYear}
// where season is the END year of the season label, e.g. 2026 for "2025-26".

import { logPrefix } from "./request-context.js";
import { logEvent } from "./verdict-logger.js";
import { fmtDate } from "./string-utils.js";

const LEAGUE_SLUG = { NBA: "nba", WNBA: "wnba" };

function gamelogBase(league) {
  const slug = LEAGUE_SLUG[league] ?? "nba";
  return `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${slug}/athletes`;
}

// Column positions in event.stats[] differ by league — NBA uses
// [MIN, FG, FG%, 3PT, 3P%, FT, FT%, REB, AST, BLK, STL, PF, TO, PTS] while
// WNBA returns [MIN, PTS, REB, AST, STL, BLK, TO, FG, FG%, 3PT, 3P%, FT,
// FT%, PF]. ESPN ships the actual column order in `data.labels` (top level
// of the gamelog response), so we resolve indices per-request rather than
// hard-coding a league-specific layout that silently scrambles when ESPN
// reorders or when the league differs.
const LABEL_TO_KEY = {
  "MIN": "minutes",
  "FG": "fgma",
  "FG%": "fg_pct",
  "3PT": "fg3ma",
  "3P%": "fg3_pct",
  "FT": "ftma",
  "FT%": "ft_pct",
  "REB": "reb",
  "AST": "ast",
  "BLK": "blk",
  "STL": "stl",
  "PF": "pf",
  "TO": "to",
  "PTS": "pts",
};

const REQUIRED_KEYS = [
  "minutes", "fgma", "fg_pct", "fg3ma", "fg3_pct", "ftma", "ft_pct",
  "reb", "ast", "blk", "stl", "pts",
];

function resolveIdx(labels) {
  if (!Array.isArray(labels) || !labels.length) return null;
  const idx = {};
  for (let i = 0; i < labels.length; i++) {
    const key = LABEL_TO_KEY[String(labels[i]).toUpperCase()];
    if (key) idx[key] = i;
  }
  for (const k of REQUIRED_KEYS) {
    if (idx[k] == null) return null;
  }
  return idx;
}

function endYearFromSeasonLabel(label, league = "NBA") {
  if (typeof label === "number") return label;
  if (league === "WNBA") {
    // WNBA seasons are single calendar years (e.g. "2025"). ESPN's gamelog
    // endpoint expects the same single-year value.
    const m = String(label).match(/^(\d{4})$/);
    return m ? Number(m[1]) : null;
  }
  const m = String(label).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  return start + 1;
}

function seasonLabelFromEndYear(endYear, league = "NBA") {
  if (league === "WNBA") return String(endYear);
  return `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`;
}

function num(s) {
  if (s == null || s === "") return 0;
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

function splitFgPair(s) {
  if (typeof s !== "string") return [0, 0];
  const [m, a] = s.split("-").map(num);
  return [m, a];
}

function parseStatsRow(stats, idx) {
  const [fgm, fga] = splitFgPair(stats[idx.fgma]);
  const [fg3m, fg3a] = splitFgPair(stats[idx.fg3ma]);
  const [ftm, fta] = splitFgPair(stats[idx.ftma]);
  return {
    minutes: num(stats[idx.minutes]),
    fgm, fga,
    fg_pct: num(stats[idx.fg_pct]) / 100,
    fg3m, fg3a,
    fg3_pct: num(stats[idx.fg3_pct]) / 100,
    ftm, fta,
    ft_pct: num(stats[idx.ft_pct]) / 100,
    reb: num(stats[idx.reb]),
    ast: num(stats[idx.ast]),
    blk: num(stats[idx.blk]),
    stl: num(stats[idx.stl]),
    // tov: needed for Fantasy Score (FanDuel formula penalizes -1 per TO).
    // idx.to is null in older snapshots where ESPN omitted TO; fall back to
    // 0 in that case rather than NaN-ing the downstream average.
    tov: idx.to != null ? num(stats[idx.to]) : 0,
    pts: num(stats[idx.pts]),
  };
}

async function fetchGamelog(athleteId, endYear, league = "NBA") {
  const url = `${gamelogBase(league)}/${athleteId}/gamelog?season=${endYear}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const level = (res.status === 408 || res.status === 429) ? "warn" : "error";
      console.error(`${logPrefix()}espn gamelog ${athleteId} ${res.status}`);
      logEvent({
        level,
        source: "espn-stats",
        message: `espn gamelog ${athleteId} HTTP ${res.status}`,
        errorStatus: res.status,
        context: { url, athlete_id: athleteId, end_year: endYear, league },
      });
      return null;
    }
    return await res.json();
  } catch (err) {
    const isTimeout = err.name === "AbortError" || /timeout/i.test(err.message);
    console.error(`${logPrefix()}espn gamelog ${athleteId} threw:`, err.message);
    logEvent({
      level: isTimeout ? "warn" : "error",
      source: "espn-stats",
      message: `espn gamelog ${athleteId} threw: ${err.message}`,
      errorName: err.name,
      context: { url, athlete_id: athleteId, end_year: endYear, league, timeout_ms: 8000 },
    });
    return null;
  }
}

function findBucket(seasonTypes, postseason) {
  if (!Array.isArray(seasonTypes)) return null;
  const re = postseason ? /post/i : /regular/i;
  return seasonTypes.find((s) => re.test(s.displayName)) ?? null;
}

function flatEvents(bucket) {
  if (!bucket?.categories) return [];
  return bucket.categories.flatMap((c) => c.events ?? []).filter((e) => Array.isArray(e.stats));
}

// Pull the column-name array from the response. ESPN puts the canonical
// order at the top level (`data.labels`); buckets and categories don't
// carry their own labels, so the previous bucket-scoped lookup always
// returned null and the layout check fell through.
function findLabels(data) {
  if (!data) return null;
  if (Array.isArray(data.labels) && data.labels.length) return data.labels;
  if (Array.isArray(data.names) && data.names.length) return data.names;
  if (Array.isArray(data.displayNames) && data.displayNames.length) return data.displayNames;
  return null;
}

function resolveDataIdx(data) {
  const labels = findLabels(data);
  if (!labels) {
    // ESPN returns just `{filters}` for athletes with zero games in the
    // requested season — no labels, no seasonTypes. That's a clean
    // no-data signal, not a schema break, so it shouldn't log an error.
    if (!Array.isArray(data?.seasonTypes) || data.seasonTypes.length === 0) {
      return null;
    }
    const msg = "espn gamelog response missing labels array";
    console.error(`${logPrefix()}${msg}`);
    logEvent({ level: "error", source: "espn-stats", message: msg });
    return null;
  }
  const idx = resolveIdx(labels);
  if (!idx) {
    const msg = `espn gamelog labels missing required columns; got ${labels.join(",")}`;
    console.error(`${logPrefix()}${msg}`);
    logEvent({ level: "error", source: "espn-stats", message: msg, context: { labels } });
    return null;
  }
  return idx;
}

export async function getSeasonAverages(athleteId, { season, league = "NBA" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season, league);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const idx = resolveDataIdx(data);
  if (!idx) return null;
  const bucket = findBucket(data.seasonTypes, false);
  const events = flatEvents(bucket);
  if (!events.length) return null;
  const rows = events.map((e) => parseStatsRow(e.stats, idx));
  const avg = (k) => Number((rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear, league),
    season_type: "Regular Season",
    games: rows.length,
    minutes: avg("minutes"),
    ppg: avg("pts"),
    rpg: avg("reb"),
    apg: avg("ast"),
    fgm: avg("fgm"),
    fga: avg("fga"),
    fg_pct: avg("fg_pct"),
    fg3m: avg("fg3m"),
    fg3a: avg("fg3a"),
    fg3_pct: avg("fg3_pct"),
    ftm: avg("ftm"),
    fta: avg("fta"),
    ft_pct: avg("ft_pct"),
    // Surfaced for the Blocks+Stls and Fantasy Score baselines. bpg/spg
    // also feed Rule 5b's foul-prone gate when extended to block props.
    bpg: avg("blk"),
    spg: avg("stl"),
    topg: avg("tov"),
  };
}

export async function getLastNGames(athleteId, n = 5, { season, postseason = false, league = "NBA" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season, league);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const idx = resolveDataIdx(data);
  if (!idx) return null;
  const bucket = findBucket(data.seasonTypes, postseason);
  const events = flatEvents(bucket);
  if (!events.length) return null;

  const meta = data.events ?? {};
  const enriched = events.map((e) => {
    const m = meta[e.eventId];
    const row = parseStatsRow(e.stats, idx);
    const oppAbbr = m?.opponent?.abbreviation ?? "?";
    const ownAbbr = m?.team?.abbreviation ?? "";
    const atVs = m?.atVs ?? "vs";
    const matchup = ownAbbr ? `${ownAbbr} ${atVs} ${oppAbbr}` : `${atVs} ${oppAbbr}`;
    return {
      eventId: e.eventId,
      gameDate: m?.gameDate,
      matchup,
      result: m?.gameResult ?? null,
      ...row,
    };
  });
  enriched.sort((a, b) => new Date(b.gameDate || 0).getTime() - new Date(a.gameDate || 0).getTime());

  const top = enriched.slice(0, n);
  const games = top.map((g) => ({
    game_id: String(g.eventId),
    date: fmtDate(g.gameDate),
    matchup: g.matchup,
    result: g.result,
    minutes: g.minutes,
    pts: g.pts,
    reb: g.reb,
    ast: g.ast,
    fg3m: g.fg3m,
    fg3a: g.fg3a,
    fgm: g.fgm,
    fga: g.fga,
    fg_pct: g.fg_pct,
    // Rule 5i (playoff override) needs l5 FT volume + percentage when the
    // l5 sample is playoff games, so propagate these from the parsed row
    // rather than dropping them at the slice boundary.
    ftm: g.ftm,
    fta: g.fta,
    ft_pct: g.ft_pct,
    // Blocks/steals/turnovers feed the new prop families (Blks+Stls,
    // Fantasy Score). weighted-l5 already references these keys; keeping
    // them on the per-game shape so the weighted averages don't silently
    // re-normalize on missing fields.
    blk: g.blk,
    stl: g.stl,
    tov: g.tov,
    pra: g.pts + g.reb + g.ast,
  }));
  if (!games.length) return null;
  const avg = (k) => Number((games.reduce((s, g) => s + (g[k] || 0), 0) / games.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear, league),
    season_type: postseason ? "Playoffs" : "Regular Season",
    n: games.length,
    games,
    averages: {
      ppg: avg("pts"),
      rpg: avg("reb"),
      apg: avg("ast"),
      fg3m: avg("fg3m"),
      fg3a: avg("fg3a"),
      fga: avg("fga"),
      ftm: avg("ftm"),
      fta: avg("fta"),
      ft_pct: avg("ft_pct"),
      pra: avg("pra"),
      minutes: avg("minutes"),
      // For Blks+Stls and Fantasy Score baselines on L5.
      bpg: avg("blk"),
      spg: avg("stl"),
      topg: avg("tov"),
    },
  };
}
