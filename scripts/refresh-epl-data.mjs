// Refresh the Premier League data snapshots for the EPL model (this season
// only — see the epl-model plan):
//
//   data/epl-matches.json  fixtures (all 380) + every finished match: team
//                          stats (home/away) and one row per matchday-squad
//                          player (minutes, start/sub, position, shots, passes,
//                          tackles, clearances, saves, xG/xA, …)
//   data/epl-players.json  registry: FotMob player ↔ FPL element (joined on
//                          Opta ID), team ↔ FPL team/abbr, FPL availability
//                          (status, chance of playing, news), season totals
//
// Sources (both free, plain HTTP, verified 2026-09-18):
//   FotMob  league + match pages embed their data as __NEXT_DATA__ JSON
//           (parsed by api/_lib/epl/fotmob.js)
//   FPL     fantasy.premierleague.com/api/bootstrap-static/
//
// Incremental: matches already in the snapshot are kept and not re-fetched,
// except those kicked off within --refetch-days (default 2) in case FotMob
// revises post-match stats. --full re-fetches everything.
//
// Usage: npm run refresh-epl-data
//        node scripts/refresh-epl-data.mjs [--full] [--refetch-days N] [--dry-run]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractNextData, parseMatch, parseFixtures, matchPageUrl, FOTMOB_EPL_LEAGUE_ID } from "../api/_lib/epl/fotmob.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATCHES_PATH = path.join(ROOT, "data/epl-matches.json");
const PLAYERS_PATH = path.join(ROOT, "data/epl-players.json");

const FOTMOB = "https://www.fotmob.com";
const LEAGUE_URL = `${FOTMOB}/leagues/${FOTMOB_EPL_LEAGUE_ID}/fixtures/premier-league`;
const FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const PAGE_GAP_MS = 1200;

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const DRY = args.includes("--dry-run");
const refetchIdx = args.indexOf("--refetch-days");
const REFETCH_DAYS = refetchIdx >= 0 ? Number(args[refetchIdx + 1]) : 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { accept = "text/html", attempts = 3 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.text();
      console.error(`  HTTP ${res.status} ${url.slice(0, 100)} (attempt ${i}/${attempts})`);
    } catch (err) {
      console.error(`  fetch threw ${url.slice(0, 100)}: ${err.message} (attempt ${i}/${attempts})`);
    }
    if (i < attempts) await sleep(2000 * i);
  }
  return null;
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

const FPL_POSITION = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

// One array element per line, null fields dropped: ~half the size of plain
// JSON, and a weekly refresh appends lines instead of rewriting one giant
// line, so git diffs/deltas stay small as the season grows (~380 matches).
// Readers treat a missing field as null.
function lineJson(obj, arrayKeys) {
  const head = Object.entries(obj)
    .filter(([k]) => !arrayKeys.includes(k))
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const arrays = arrayKeys.map((k) => `${JSON.stringify(k)}: [\n${(obj[k] || []).map((e) => JSON.stringify(dropNulls(e))).join(",\n")}\n]`);
  return `{\n${[...head, ...arrays].join(",\n")}\n}`;
}

async function main() {
  console.log("=== refresh-epl-data ===");

  console.log("\n[1/4] FotMob fixtures...");
  const leagueProps = extractNextData(await fetchText(LEAGUE_URL));
  if (!leagueProps) throw new Error("FotMob league page unavailable or __NEXT_DATA__ missing");
  const season = leagueProps.details?.selectedSeason ?? null;
  const fixtures = parseFixtures(leagueProps);
  const finished = fixtures.filter((f) => f.finished && !f.cancelled);
  console.log(`  season ${season}: ${fixtures.length} fixtures, ${finished.length} finished`);
  if (!fixtures.length) throw new Error("no fixtures parsed — FotMob page shape changed?");

  const prior = FULL ? null : await readJson(MATCHES_PATH);
  const priorSeasonOk = prior?.season === season;
  const keep = new Map(); // match_id → { match, players }
  if (priorSeasonOk) {
    const rowsByMatch = new Map();
    for (const r of prior.player_matches || []) {
      if (!rowsByMatch.has(r.match_id)) rowsByMatch.set(r.match_id, []);
      rowsByMatch.get(r.match_id).push(r);
    }
    for (const m of prior.matches || []) keep.set(m.match_id, { match: m, players: rowsByMatch.get(m.match_id) || [] });
  }

  const refetchCutoff = Date.now() - REFETCH_DAYS * 86400000;
  const todo = finished.filter((f) => {
    if (!keep.has(f.match_id)) return true;
    const ko = f.kickoff_utc ? new Date(f.kickoff_utc).getTime() : 0;
    return ko >= refetchCutoff;
  });
  console.log(`\n[2/4] match pages: ${todo.length} to fetch (${keep.size} kept from snapshot)`);

  let failed = 0;
  for (const [i, f] of todo.entries()) {
    const props = extractNextData(await fetchText(matchPageUrl(f.match_id)));
    const parsed = props ? parseMatch(props, f) : null;
    if (!parsed) {
      failed++;
      console.warn(`  ! ${f.home.name} v ${f.away.name} (${f.match_id}): parse failed`);
    } else if (parsed.match.match_id !== f.match_id || parsed.match.league_id !== FOTMOB_EPL_LEAGUE_ID) {
      // Wrong page (another meeting of the same pair, e.g. a cup tie) —
      // never store it under this fixture.
      failed++;
      console.warn(`  ! ${f.home.name} v ${f.away.name} (${f.match_id}): page served match ${parsed.match.match_id} (league ${parsed.match.league_id}) — skipped`);
    } else {
      const played = parsed.players.filter((r) => r.minutes > 0).length;
      if (played < 22) console.warn(`  ! ${f.home.name} v ${f.away.name}: only ${played} players with minutes`);
      parsed.match.unavailable = parsed.unavailable;
      keep.set(f.match_id, { match: parsed.match, players: parsed.players.map((r) => ({ match_id: f.match_id, ...r })) });
      console.log(`  ${String(i + 1).padStart(3)}/${todo.length} R${f.round} ${f.home.name} ${parsed.match.home.score}-${parsed.match.away.score} ${f.away.name}  (${played} played)`);
    }
    if (i < todo.length - 1) await sleep(PAGE_GAP_MS);
  }

  // Only matches FotMob still lists as finished (drops anything since
  // cancelled/awarded), ordered by kickoff.
  const finishedIds = new Set(finished.map((f) => f.match_id));
  const entries = [...keep.values()]
    .filter((e) => finishedIds.has(e.match.match_id))
    .sort((a, b) => String(a.match.kickoff_utc).localeCompare(String(b.match.kickoff_utc)));
  if (!entries.length) throw new Error("0 finished matches parsed — refusing to write");
  if (priorSeasonOk && entries.length < (prior.matches || []).length) {
    throw new Error(`parsed ${entries.length} matches < ${prior.matches.length} in the existing snapshot — refusing to shrink it`);
  }

  console.log("\n[3/4] FPL bootstrap (availability + Opta join)...");
  const fplRaw = await fetchText(FPL_BOOTSTRAP, { accept: "application/json" });
  const fpl = fplRaw ? JSON.parse(fplRaw) : null;
  if (!fpl) console.warn("  ! FPL unavailable — registry written without availability/FPL ids");
  const fplTeams = new Map((fpl?.teams || []).map((t) => [t.id, t]));
  const fplByOpta = new Map();
  for (const e of fpl?.elements || []) {
    const opta = String(e.opta_code || "").replace(/^p/, "");
    if (opta) fplByOpta.set(opta, e);
  }

  // Registry: aggregate every player row, newest match last so team/position
  // reflect the player's latest appearance.
  const players = {};
  const teamVotes = new Map(); // fotmob team id → Map(fpl team id → count)
  const teamNames = new Map();
  for (const f of fixtures) {
    teamNames.set(f.home.team_id, { name: f.home.name, short: f.home.short });
    teamNames.set(f.away.team_id, { name: f.away.name, short: f.away.short });
  }
  for (const { players: rows } of entries) {
    for (const r of rows) {
      const p = (players[r.player_id] ??= {
        name: r.name, opta_id: r.opta_id, team_id: r.team_id,
        squads: 0, apps: 0, starts: 0, minutes: 0, gk: r.gk, position_ids: {},
      });
      p.name = r.name;
      p.team_id = r.team_id;
      p.squads += 1;
      if (r.minutes > 0) p.apps += 1;
      if (r.started) p.starts += 1;
      p.minutes += r.minutes || 0;
      if (r.minutes > 0 && r.position_id != null) p.position_ids[r.position_id] = (p.position_ids[r.position_id] || 0) + 1;
      const fe = r.opta_id ? fplByOpta.get(r.opta_id) : null;
      if (fe) {
        const votes = teamVotes.get(r.team_id) ?? new Map();
        votes.set(fe.team, (votes.get(fe.team) || 0) + 1);
        teamVotes.set(r.team_id, votes);
      }
    }
  }

  const teams = {};
  for (const [tid, meta] of teamNames) {
    const votes = [...(teamVotes.get(tid) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]);
    const ft = votes.length ? fplTeams.get(votes[0][0]) : null;
    teams[tid] = { name: meta.name, short: meta.short, abbr: ft?.short_name ?? null, fpl_team_id: ft?.id ?? null };
  }

  let joined = 0;
  const matchedFpl = new Set();
  for (const p of Object.values(players)) {
    p.abbr = teams[p.team_id]?.abbr ?? null;
    const fe = p.opta_id ? fplByOpta.get(p.opta_id) : null;
    if (fe) {
      joined++;
      matchedFpl.add(fe.id);
      Object.assign(p, {
        fpl_id: fe.id,
        fpl_name: fe.web_name,
        first_name: fe.first_name,
        second_name: fe.second_name,
        fpl_position: FPL_POSITION[fe.element_type] ?? null,
        status: fe.status, // a=available d=doubtful i=injured s=suspended u=unavailable n=not in squad
        chance_next: fe.chance_of_playing_next_round,
        news: fe.news || null,
        news_added: fe.news_added || null,
      });
    } else {
      p.fpl_id = null;
    }
  }
  // FPL players with no FotMob appearance yet (injured all season, new
  // signings) — kept so availability/news is known when they return.
  const fplOnly = (fpl?.elements || [])
    .filter((e) => !matchedFpl.has(e.id))
    .map((e) => ({
      fpl_id: e.id, name: `${e.first_name} ${e.second_name}`, fpl_name: e.web_name,
      opta_id: String(e.opta_code || "").replace(/^p/, "") || null,
      abbr: fplTeams.get(e.team)?.short_name ?? null, fpl_position: FPL_POSITION[e.element_type] ?? null,
      status: e.status, chance_next: e.chance_of_playing_next_round, news: e.news || null,
    }));

  const nPlayers = Object.keys(players).length;
  const nPlayed = Object.values(players).filter((p) => p.apps > 0).length;
  const unjoinedPlayed = Object.values(players).filter((p) => p.apps > 0 && !p.fpl_id);
  console.log(`  ${nPlayers} FotMob squad players (${nPlayed} with minutes); ${joined} joined to FPL by Opta ID`);
  if (unjoinedPlayed.length) console.log(`  unjoined (played): ${unjoinedPlayed.map((p) => `${p.name} (${p.abbr ?? p.team_id})`).join(", ")}`);
  const unmappedTeams = Object.entries(teams).filter(([, t]) => !t.abbr);
  if (unmappedTeams.length) console.warn(`  ! teams without an FPL abbr: ${unmappedTeams.map(([, t]) => t.name).join(", ")}`);

  const fetchedAt = new Date().toISOString();
  const matchesOut = {
    season,
    league: "EPL",
    fotmob_league_id: FOTMOB_EPL_LEAGUE_ID,
    fetched_at: fetchedAt,
    fixtures,
    matches: entries.map((e) => e.match),
    player_matches: entries.flatMap((e) => e.players),
  };
  const playersOut = { season, fetched_at: fetchedAt, teams, players, fpl_only: fplOnly };

  console.log("\n[4/4] writing snapshots...");
  const mJson = lineJson(matchesOut, ["fixtures", "matches", "player_matches"]);
  const pJson = JSON.stringify(playersOut, null, 1);
  console.log(`  epl-matches.json: ${entries.length} matches, ${matchesOut.player_matches.length} player rows, ${(mJson.length / 1024).toFixed(0)} KB`);
  console.log(`  epl-players.json: ${nPlayers} players + ${fplOnly.length} FPL-only, ${(pJson.length / 1024).toFixed(0)} KB`);
  if (failed) console.warn(`  ! ${failed} match page(s) failed — re-run to retry`);
  if (DRY) {
    console.log("  DRY RUN — nothing written");
    return;
  }
  await fs.writeFile(MATCHES_PATH, mJson + "\n");
  await fs.writeFile(PLAYERS_PATH, pJson + "\n");
  console.log("  done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
