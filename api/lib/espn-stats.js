// ESPN athlete-stats client — fallback for stats.nba.com (which 4xxs from
// Vercel egress IPs). One gamelog call covers both season averages and L5,
// since ESPN buckets events by season type (Regular / Postseason) and
// includes per-game positional stat arrays.
//
// Endpoint: site.web.api.espn.com/.../athletes/{id}/gamelog?season={endYear}
// where season is the END year of the season label, e.g. 2026 for "2025-26".

import { logPrefix } from "./request-context.js";
import { fmtDate } from "./string-utils.js";

const LEAGUE_SLUG = { NBA: "nba", WNBA: "wnba" };

function gamelogBase(league) {
  const slug = LEAGUE_SLUG[league] ?? "nba";
  return `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${slug}/athletes`;
}

// Statistic positions in event.stats[] are defined by the response's `names`
// array. Hard-coded indices to avoid an extra lookup per event.
const IDX = {
  minutes: 0,
  fgma: 1,        // "FGM-FGA"
  fg_pct: 2,
  fg3ma: 3,       // "3PM-3PA"
  fg3_pct: 4,
  ftma: 5,        // "FTM-FTA"
  ft_pct: 6,
  reb: 7,
  ast: 8,
  blk: 9,
  stl: 10,
  pf: 11,
  to: 12,
  pts: 13,
};

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

function parseStatsRow(stats) {
  const [fgm, fga] = splitFgPair(stats[IDX.fgma]);
  const [fg3m, fg3a] = splitFgPair(stats[IDX.fg3ma]);
  const [ftm, fta] = splitFgPair(stats[IDX.ftma]);
  return {
    minutes: num(stats[IDX.minutes]),
    fgm, fga,
    fg_pct: num(stats[IDX.fg_pct]) / 100,
    fg3m, fg3a,
    fg3_pct: num(stats[IDX.fg3_pct]) / 100,
    ftm, fta,
    ft_pct: num(stats[IDX.ft_pct]) / 100,
    reb: num(stats[IDX.reb]),
    ast: num(stats[IDX.ast]),
    blk: num(stats[IDX.blk]),
    stl: num(stats[IDX.stl]),
    pts: num(stats[IDX.pts]),
  };
}

async function fetchGamelog(athleteId, endYear, league = "NBA") {
  const url = `${gamelogBase(league)}/${athleteId}/gamelog?season=${endYear}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`${logPrefix()}espn gamelog ${athleteId} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`${logPrefix()}espn gamelog ${athleteId} threw:`, err.message);
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

// ESPN's gamelog response carries a column-name array on the season-type
// bucket (or per category). If they ever reorder or insert a column, the
// hard-coded IDX positions silently produce wrong averages. Validate the
// layout matches expectations before trusting parseStatsRow output.
const EXPECTED_LABELS = [
  "MIN", "FG", "FG%", "3PT", "3P%", "FT", "FT%",
  "REB", "AST", "BLK", "STL", "PF", "TO", "PTS",
];

function findLabels(bucket) {
  if (!bucket) return null;
  if (Array.isArray(bucket.labels) && bucket.labels.length) return bucket.labels;
  if (Array.isArray(bucket.names) && bucket.names.length) return bucket.names;
  if (Array.isArray(bucket.displayNames) && bucket.displayNames.length) return bucket.displayNames;
  for (const c of bucket.categories ?? []) {
    if (Array.isArray(c.labels) && c.labels.length) return c.labels;
    if (Array.isArray(c.names) && c.names.length) return c.names;
  }
  return null;
}

function bucketLayoutOk(bucket) {
  const labels = findLabels(bucket);
  if (!labels) return true; // absent — happy path, IDX assumed
  if (labels.length < EXPECTED_LABELS.length) {
    console.error(`${logPrefix()}espn gamelog layout diverged: expected >=${EXPECTED_LABELS.length} cols, got ${labels.length}`);
    return false;
  }
  for (let i = 0; i < EXPECTED_LABELS.length; i++) {
    if (String(labels[i]).toUpperCase() !== EXPECTED_LABELS[i]) {
      console.error(`${logPrefix()}espn gamelog layout diverged at col ${i}: expected "${EXPECTED_LABELS[i]}", got "${labels[i]}"`);
      return false;
    }
  }
  return true;
}

export async function getSeasonAverages(athleteId, { season, league = "NBA" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season, league);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, false);
  if (!bucketLayoutOk(bucket)) return null;
  const events = flatEvents(bucket);
  if (!events.length) return null;
  const rows = events.map((e) => parseStatsRow(e.stats));
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
  };
}

export async function getLastNGames(athleteId, n = 5, { season, postseason = false, league = "NBA" } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season, league);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear, league);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, postseason);
  if (!bucketLayoutOk(bucket)) return null;
  const events = flatEvents(bucket);
  if (!events.length) return null;

  const meta = data.events ?? {};
  const enriched = events.map((e) => {
    const m = meta[e.eventId];
    const row = parseStatsRow(e.stats);
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
    fgm: g.fgm,
    fga: g.fga,
    fg_pct: g.fg_pct,
    // Rule 5i (playoff override) needs l5 FT volume + percentage when the
    // l5 sample is playoff games, so propagate these from the parsed row
    // rather than dropping them at the slice boundary.
    ftm: g.ftm,
    fta: g.fta,
    ft_pct: g.ft_pct,
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
      fga: avg("fga"),
      ftm: avg("ftm"),
      fta: avg("fta"),
      ft_pct: avg("ft_pct"),
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
}
