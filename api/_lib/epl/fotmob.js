// FotMob parsing for the Premier League model. Pure functions — no I/O — so
// the refresh script (scripts/refresh-epl-data.mjs) and any runtime caller
// (e.g. a confirmed-lineup re-run) share one parser.
//
// FotMob pages are Next.js: every league/match page embeds its full data as
// JSON in <script id="__NEXT_DATA__">, so a plain HTTP GET is enough (no
// signed API headers, no browser). Verified 2026-09-18:
//   league  /leagues/47/fixtures/premier-league → pageProps.fixtures.allMatches
//   match   /match/<matchId>                    → pageProps.content.{playerStats,
//           lineup, stats.Periods.All, matchFacts}, pageProps.header.teams
// Fetch matches by id (matchPageUrl), NOT fixture.pageUrl: that path names
// the team PAIRING and serves their latest meeting — for Forest v Leeds it
// returned an EFL Cup tie — and the "#<matchId>" fragment never reaches the
// server.
//
// Player stats arrive grouped (top_stats / attack / defense / duels / …) and
// keyed by FotMob stat keys; the same key can appear in several groups with
// the same value. PLAYER_FIELDS maps each canonical field to the FotMob key
// and which part of the stat to read ("value", or "total" for fraction stats
// like accurate_passes = { value: accurate, total: attempted }).

export const FOTMOB_EPL_LEAGUE_ID = 47;

export function matchPageUrl(matchId) {
  return `https://www.fotmob.com/match/${matchId}`;
}

export function extractNextData(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1])?.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

// canonical field → [fotmob key, "value" | "total"]
const PLAYER_FIELDS = {
  minutes: ["minutes_played", "value"],
  rating: ["rating_title", "value"],
  goals: ["goals", "value"],
  assists: ["assists", "value"],
  xg: ["expected_goals", "value"],
  npxg: ["expected_goals_non_penalty", "value"],
  xgot: ["expected_goals_on_target_variant", "value"],
  xa: ["expected_assists", "value"],
  shots: ["total_shots", "value"],
  sot: ["ShotsOnTarget", "value"],
  shots_off: ["ShotsOffTarget", "value"],
  shots_blocked: ["blocked_shots", "value"], // this player's shots that were blocked
  key_passes: ["chances_created", "value"], // = shots assisted
  big_chances_created: ["big_chance_created_team_title", "value"],
  big_chances_missed: ["big_chance_missed_title", "value"],
  passes_acc: ["accurate_passes", "value"],
  passes_att: ["accurate_passes", "total"],
  final_third_passes: ["passes_into_final_third", "value"],
  line_breaking_passes: ["line_breaking_passes", "value"],
  crosses_acc: ["accurate_crosses", "value"],
  crosses_att: ["accurate_crosses", "total"],
  long_balls_acc: ["long_balls_accurate", "value"],
  long_balls_att: ["long_balls_accurate", "total"],
  touches: ["touches", "value"],
  touches_box: ["touches_opp_box", "value"],
  dispossessed: ["dispossessed", "value"],
  dribbles_succ: ["dribbles_succeeded", "value"],
  dribbles_att: ["dribbles_succeeded", "total"],
  offsides: ["Offsides", "value"],
  corners: ["corners", "value"],
  tackles: ["matchstats.headers.tackles", "value"],
  interceptions: ["interceptions", "value"],
  clearances: ["clearances", "value"],
  headed_clearances: ["headed_clearance", "value"],
  blocks: ["shot_blocks", "value"], // opponent shots this player blocked
  recoveries: ["recoveries", "value"],
  dribbled_past: ["dribbled_past", "value"],
  defensive_actions: ["defensive_actions", "value"],
  duels_won: ["duel_won", "value"],
  duels_lost: ["duel_lost", "value"],
  ground_duels_won: ["ground_duels_won", "value"],
  ground_duels_att: ["ground_duels_won", "total"],
  aerials_won: ["aerials_won", "value"],
  aerials_att: ["aerials_won", "total"],
  fouls: ["fouls", "value"],
  fouled: ["was_fouled", "value"],
  // Goalkeeper
  saves: ["saves", "value"],
  goals_conceded: ["goals_conceded", "value"],
  xgot_faced: ["expected_goals_on_target_faced", "value"],
  goals_prevented: ["goals_prevented", "value"],
  saves_in_box: ["saves_inside_box", "value"],
  high_claims: ["keeper_high_claim", "value"],
  punches: ["punches", "value"],
  sweeper_actions: ["keeper_sweeper", "value"],
  throws: ["player_throws", "value"],
  // Physical
  distance_m: ["physical_metrics_distance_covered", "value"],
  sprints: ["physical_metrics_number_of_sprints", "value"],
};

// Leading number only: team rows carry "565 (92%)" — stripping non-digits
// would glue the percentage on (56592).
function num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Flatten FotMob's grouped player stats into { fotmobKey: {value, total} }.
function flattenPlayerStats(groups) {
  const flat = {};
  for (const g of groups || []) {
    for (const [title, s] of Object.entries(g?.stats || {})) {
      const key = s?.key || title;
      if (!s?.stat || flat[key]) continue;
      flat[key] = { value: num(s.stat.value), total: num(s.stat.total) };
    }
  }
  return flat;
}

// Lineup lookup: fotmob player id → { started, sub_in, sub_out, position_id,
// usual_position_id, layout {x,y} } for everyone in the matchday squad.
function lineupIndex(lineup) {
  const idx = new Map();
  for (const side of ["homeTeam", "awayTeam"]) {
    const t = lineup?.[side];
    if (!t) continue;
    const add = (p, started) => {
      const subs = p?.performance?.substitutionEvents || [];
      const subIn = subs.find((e) => e.type === "subIn")?.time ?? null;
      const subOut = subs.find((e) => e.type === "subOut")?.time ?? null;
      idx.set(String(p.id), {
        team_id: String(t.id),
        started,
        sub_in: num(subIn),
        sub_out: num(subOut),
        position_id: p.positionId ?? null,
        usual_position_id: p.usualPlayingPositionId ?? null,
        layout: started && p.verticalLayout ? { x: num(p.verticalLayout.x), y: num(p.verticalLayout.y) } : null,
      });
    };
    for (const p of t.starters || []) add(p, true);
    for (const p of t.subs || []) add(p, false);
  }
  return idx;
}

function unavailableList(lineup) {
  const out = [];
  for (const side of ["homeTeam", "awayTeam"]) {
    const t = lineup?.[side];
    for (const p of t?.unavailable || []) {
      out.push({
        player_id: String(p.id),
        name: p.name,
        team_id: String(t.id),
        type: p.unavailability?.type ?? null, // "injury" | "suspension" | …
        expected_return: p.unavailability?.expectedReturn ?? null,
      });
    }
  }
  return out;
}

// Team stats: stats.Periods.All.stats is a list of groups, each with
// stats: [{ key, stats: [home, away] }]. Values are numbers or strings like
// "565 (92%)" (accurate count + share) — keep the leading count.
const TEAM_FIELDS = {
  possession: "BallPossesion",
  xg: "expected_goals",
  xg_open_play: "expected_goals_open_play",
  xg_set_play: "expected_goals_set_play",
  npxg: "expected_goals_non_penalty",
  xgot: "expected_goals_on_target",
  shots: "total_shots",
  sot: "ShotsOnTarget",
  shots_off: "ShotsOffTarget",
  shots_blocked: "blocked_shots",
  woodwork: "shots_woodwork",
  shots_in_box: "shots_inside_box",
  shots_out_box: "shots_outside_box",
  big_chances: "big_chance",
  big_chances_missed: "big_chance_missed_title",
  touches_box: "touches_opp_box",
  passes_att: "passes",
  passes_acc: "accurate_passes",
  own_half_passes: "own_half_passes",
  opp_half_passes: "opposition_half_passes",
  long_balls_acc: "long_balls_accurate",
  crosses_acc: "accurate_crosses",
  throws: "player_throws",
  offsides: "Offsides",
  corners: "corners",
  tackles: "matchstats.headers.tackles",
  interceptions: "interceptions",
  blocks: "shot_blocks",
  clearances: "clearances",
  keeper_saves: "keeper_saves",
  duels_won: "duel_won",
  ground_duels_won: "ground_duels_won",
  aerials_won: "aerials_won",
  dribbles_succ: "dribbles_succeeded",
  yellow_cards: "yellow_cards",
  red_cards: "red_cards",
  fouls: "fouls",
  distance_m: "physical_metrics_distance_covered",
  sprints: "physical_metrics_number_of_sprints",
};

function parseTeamStats(periods) {
  const byKey = {};
  for (const g of periods?.All?.stats || []) {
    for (const s of g?.stats || []) {
      const key = s?.key;
      if (!key || !Array.isArray(s.stats) || byKey[key]) continue;
      if (s.stats[0] == null && s.stats[1] == null) continue; // group header row
      byKey[key] = s.stats;
    }
  }
  const home = {};
  const away = {};
  for (const [field, key] of Object.entries(TEAM_FIELDS)) {
    const pair = byKey[key];
    home[field] = pair ? num(pair[0]) : null;
    away[field] = pair ? num(pair[1]) : null;
  }
  return { home, away };
}

// Attempt counts for fraction stats come from summing player totals — the
// team rows only carry "accurate (pct%)", and back-solving attempts from a
// rounded percentage is lossy.
const TEAM_SUM_FROM_PLAYERS = ["crosses_att", "long_balls_att", "dribbles_att", "ground_duels_att", "aerials_att", "fouled"];

function cardsByPlayer(matchFacts) {
  const cards = new Map();
  for (const e of matchFacts?.events?.events || []) {
    if (e?.type !== "Card" || !e.player?.id) continue;
    const id = String(e.player.id);
    const c = cards.get(id) ?? { yellow: 0, red: 0 };
    if (/red/i.test(String(e.card ?? ""))) c.red += 1;
    else c.yellow += 1;
    cards.set(id, c);
  }
  return cards;
}

/**
 * Parse one finished match page's pageProps into a compact record.
 * @returns {{ match: Object, players: Array<Object>, unavailable: Array<Object> } | null}
 */
export function parseMatch(pageProps, fixture = {}) {
  const content = pageProps?.content;
  const teams = pageProps?.header?.teams;
  if (!content?.playerStats || !Array.isArray(teams) || teams.length !== 2) return null;
  const [homeT, awayT] = teams;
  const homeId = String(homeT.id);
  const awayId = String(awayT.id);
  const general = pageProps.general || {};
  const info = content.matchFacts?.infoBox || {};

  const lineup = lineupIndex(content.lineup);
  const cards = cardsByPlayer(content.matchFacts);
  const players = [];
  for (const p of Object.values(content.playerStats)) {
    const id = String(p.id);
    const flat = flattenPlayerStats(p.stats);
    const lu = lineup.get(id) || {};
    const row = {
      player_id: id,
      opta_id: p.optaId != null ? String(p.optaId) : null,
      name: p.name,
      team_id: String(p.teamId ?? lu.team_id ?? ""),
      side: String(p.teamId) === homeId ? "home" : "away",
      gk: !!p.isGoalkeeper,
      started: lu.started ?? null,
      sub_in: lu.sub_in ?? null,
      sub_out: lu.sub_out ?? null,
      position_id: lu.position_id ?? p.positionId ?? null,
      usual_position_id: lu.usual_position_id ?? p.usualPosition ?? null,
      layout: lu.layout ?? null,
      yellow_cards: cards.get(id)?.yellow ?? 0,
      red_cards: cards.get(id)?.red ?? 0,
    };
    for (const [field, [key, part]] of Object.entries(PLAYER_FIELDS)) {
      const s = flat[key];
      row[field] = s ? s[part] : null;
    }
    // Unused subs carry no stats at all; minutes 0 keeps them countable as
    // "in squad, did not play" for the minutes model.
    if (row.minutes == null) row.minutes = 0;
    players.push(row);
  }

  const teamStats = parseTeamStats(content.stats?.Periods);
  for (const field of TEAM_SUM_FROM_PLAYERS) {
    for (const [side, tid] of [["home", homeId], ["away", awayId]]) {
      const vals = players.filter((r) => r.team_id === tid).map((r) => r[field]).filter((v) => v != null);
      teamStats[side][field] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    }
  }

  const match = {
    match_id: String(general.matchId ?? fixture.id ?? ""),
    league_id: num(general.leagueId),
    round: num(general.matchRound ?? fixture.round),
    kickoff_utc: info["Match Date"]?.utcTime ?? fixture.status?.utcTime ?? null,
    home: { team_id: homeId, name: homeT.name, score: num(homeT.score) },
    away: { team_id: awayId, name: awayT.name, score: num(awayT.score) },
    referee: info.Referee?.text ?? null,
    stadium: info.Stadium?.name ?? null,
    page_url: fixture.pageUrl ?? null,
    team_stats: teamStats,
  };
  return { match, players, unavailable: unavailableList(content.lineup) };
}

/**
 * League fixtures page → compact fixture list (all 380, any status).
 */
export function parseFixtures(pageProps) {
  const all = pageProps?.fixtures?.allMatches || [];
  return all.map((m) => ({
    match_id: String(m.id),
    round: num(m.round),
    kickoff_utc: m.status?.utcTime ?? null,
    home: { team_id: String(m.home?.id), name: m.home?.name, short: m.home?.shortName },
    away: { team_id: String(m.away?.id), name: m.away?.name, short: m.away?.shortName },
    finished: !!m.status?.finished,
    started: !!m.status?.started,
    cancelled: !!m.status?.cancelled,
    score: m.status?.scoreStr ?? null,
    page_url: m.pageUrl ?? null,
  }));
}
