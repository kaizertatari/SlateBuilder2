// ESPN athlete-stats client — fallback for stats.nba.com (which 4xxs from
// Vercel egress IPs). One gamelog call covers both season averages and L5,
// since ESPN buckets events by season type (Regular / Postseason) and
// includes per-game positional stat arrays.
//
// Endpoint: site.web.api.espn.com/.../athletes/{id}/gamelog?season={endYear}
// where season is the END year of the season label, e.g. 2026 for "2025-26".

const GAMELOG = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes";

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

function endYearFromSeasonLabel(label) {
  if (typeof label === "number") return label;
  const m = String(label).match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  return start + 1;
}

function seasonLabelFromEndYear(endYear) {
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

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}, ${d.getUTCFullYear()}`;
}

async function fetchGamelog(athleteId, endYear) {
  const url = `${GAMELOG}/${athleteId}/gamelog?season=${endYear}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`espn gamelog ${athleteId} ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`espn gamelog ${athleteId} threw:`, err.message);
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

export async function getSeasonAverages(athleteId, { season } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, false);
  const events = flatEvents(bucket);
  if (!events.length) return null;
  const rows = events.map((e) => parseStatsRow(e.stats));
  const avg = (k) => Number((rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear),
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

export async function getLastNGames(athleteId, n = 5, { season, postseason = false } = {}) {
  if (!athleteId) return null;
  const endYear = endYearFromSeasonLabel(season);
  if (!endYear) return null;
  const data = await fetchGamelog(athleteId, endYear);
  if (!data) return null;
  const bucket = findBucket(data.seasonTypes, postseason);
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
    pra: g.pts + g.reb + g.ast,
  }));
  if (!games.length) return null;
  const avg = (k) => Number((games.reduce((s, g) => s + (g[k] || 0), 0) / games.length).toFixed(2));
  return {
    season: seasonLabelFromEndYear(endYear),
    season_type: postseason ? "Playoffs" : "Regular Season",
    n: games.length,
    games,
    averages: {
      ppg: avg("pts"),
      rpg: avg("reb"),
      apg: avg("ast"),
      fg3m: avg("fg3m"),
      pra: avg("pra"),
      minutes: avg("minutes"),
    },
  };
}
