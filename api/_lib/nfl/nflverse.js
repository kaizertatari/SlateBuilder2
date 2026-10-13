// nflverse data parsers for the NFL model (step 1). Pure — the refresh script
// does the downloads. Source: github.com/nflverse/nflverse-data releases
// (free, updated nightly in season):
//   stats_player/stats_player_week_<season>.csv   one row per player-game
//   schedules/games.csv                            every game + closing
//                                                  spread/total/moneylines,
//                                                  roof, wind, temp
//   snap_counts/snap_counts_<season>.csv           offense/defense/ST snaps
//                                                  (PFR ids)
//   injuries/injuries_<season>.csv                 weekly practice + game
//                                                  status
//   players/players.csv                            id registry (gsis ↔ pfr ↔
//                                                  espn ↔ display name)
//
// nflverse writes missing values as "NA"; every parser maps them to null and
// drops null fields from the compact rows it returns.

/** RFC 4180 CSV → array of objects keyed by the header row. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQuotes = false;
  const raw = String(text);
  const s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // strip a UTF-8 BOM
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])));
}

const isNA = (v) => v == null || v === "" || v === "NA";
const num = (v) => { if (isNA(v)) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => (isNA(v) ? null : String(v));
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

// Weekly stat columns kept for the model (nflverse name → our name). Covers
// every PrizePicks NFL prop family plus the volume/role inputs behind them.
export const STAT_FIELDS = {
  completions: "completions", attempts: "pass_att", passing_yards: "pass_yds", passing_tds: "pass_td",
  passing_interceptions: "pass_int", sacks_suffered: "sacks_taken", passing_air_yards: "pass_air_yds",
  carries: "rush_att", rushing_yards: "rush_yds", rushing_tds: "rush_td",
  targets: "targets", receptions: "rec", receiving_yards: "rec_yds", receiving_tds: "rec_td",
  receiving_air_yards: "rec_air_yds", target_share: "target_share", air_yards_share: "air_yards_share",
  rushing_fumbles_lost: "rush_fum_lost", receiving_fumbles_lost: "rec_fum_lost", sack_fumbles_lost: "sack_fum_lost",
  passing_2pt_conversions: "pass_2pt", rushing_2pt_conversions: "rush_2pt", receiving_2pt_conversions: "rec_2pt",
  def_tackles_solo: "tackles_solo", def_tackle_assists: "tackle_ast", def_sacks: "def_sacks", def_interceptions: "def_int",
  fg_made: "fg_made", fg_att: "fg_att", fg_long: "fg_long", pat_made: "pat_made", pat_att: "pat_att",
  fantasy_points_ppr: "fantasy_ppr",
};

/**
 * stats_player_week rows → compact player-game rows. Zero-valued stats are
 * dropped (a missing stat reads as 0 — see statOf); name/position live on
 * the row only for registry building and are stripped before writing.
 */
export function parseWeeklyStats(rows) {
  const out = [];
  for (const r of rows) {
    const season = num(r.season), week = num(r.week);
    if (!r.player_id || !season || !week || isNA(r.game_id)) continue;
    const g = {
      player_id: r.player_id,
      name: str(r.player_display_name) ?? str(r.player_name),
      position: str(r.position),
      group: str(r.position_group),
      season, week,
      season_type: str(r.season_type),
      game_id: r.game_id,
      team: str(r.team),
      opponent: str(r.opponent_team),
    };
    for (const [src, dst] of Object.entries(STAT_FIELDS)) { const v = num(r[src]); g[dst] = v === 0 ? null : v; }
    out.push(compact(g));
  }
  return out;
}

/** A stat off a compact player-game row (absent → 0). */
export const statOf = (row, field) => row?.[field] ?? 0;

/** games.csv → compact game rows (one per game_id). */
export function parseSchedule(rows, seasons = null) {
  const keep = seasons ? new Set(seasons.map(Number)) : null;
  const out = [];
  for (const r of rows) {
    const season = num(r.season);
    if (!r.game_id || (keep && !keep.has(season))) continue;
    out.push(compact({
      game_id: r.game_id, season, week: num(r.week), game_type: str(r.game_type),
      gameday: str(r.gameday), gametime: str(r.gametime),
      away: str(r.away_team), home: str(r.home_team),
      away_score: num(r.away_score), home_score: num(r.home_score),
      // nflverse spread_line is from the HOME side's perspective as a margin:
      // positive = home favored by that many points.
      spread_line: num(r.spread_line), total_line: num(r.total_line),
      away_moneyline: num(r.away_moneyline), home_moneyline: num(r.home_moneyline),
      roof: str(r.roof), surface: str(r.surface), temp: num(r.temp), wind: num(r.wind),
      away_rest: num(r.away_rest), home_rest: num(r.home_rest), div_game: num(r.div_game),
      espn: str(r.espn), pfr: str(r.pfr),
    }));
  }
  return out;
}

/** snap_counts rows → compact player-game snap rows (PFR ids). */
export function parseSnapCounts(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.pfr_player_id || isNA(r.game_id)) continue;
    out.push(compact({
      pfr_id: r.pfr_player_id, name: str(r.player), position: str(r.position),
      game_id: r.game_id, season: num(r.season), week: num(r.week), team: str(r.team),
      off_snaps: num(r.offense_snaps), off_pct: num(r.offense_pct),
      def_snaps: num(r.defense_snaps), def_pct: num(r.defense_pct),
      st_snaps: num(r.st_snaps),
    }));
  }
  return out;
}

/** injuries rows → compact weekly status rows (gsis ids). */
export function parseInjuries(rows) {
  const out = [];
  for (const r of rows) {
    if (!r.gsis_id) continue;
    out.push(compact({
      player_id: r.gsis_id, name: str(r.full_name), position: str(r.position), team: str(r.team),
      season: num(r.season), week: num(r.week), game_type: str(r.game_type),
      report_status: str(r.report_status), practice_status: str(r.practice_status),
      primary_injury: str(r.report_primary_injury),
    }));
  }
  return out;
}

/**
 * players.csv → registry keyed by gsis id, with the ids we join on. Only
 * players whose last_season is ≥ minSeason (the history window) are kept.
 */
export function parsePlayers(rows, { minSeason = null } = {}) {
  const out = {};
  for (const r of rows) {
    if (!r.gsis_id) continue;
    if (minSeason != null && !(num(r.last_season) >= minSeason)) continue;
    out[r.gsis_id] = compact({
      name: str(r.display_name), first: str(r.first_name), last: str(r.last_name),
      position: str(r.position), team: str(r.latest_team), status: str(r.status),
      pfr_id: str(r.pfr_id), espn_id: str(r.espn_id), last_season: num(r.last_season),
    });
  }
  return out;
}
