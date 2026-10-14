// NFL outcome grader. Settles logged NFL verdicts (engine_mode "nfl-v1",
// from analyze-all / build-slate / sweep-nfl-board) against nflverse's final
// weekly player stats and writes one outcome event per join key — same Axiom
// dataset and join keys as the other graders, tagged league "NFL".
//
// PrizePicks settlement: no snap played → void; an exact tie on an integer
// line → push. nflverse rebuilds nightly, so a game settles the morning
// after. Weekly stats only list players who touched the ball (or made a
// tackle), so snap counts decide whether a missing row is a 0 or a DNP; until
// the snap counts for that game are out, such lines wait (void "unverified"
// after SNAP_WAIT_MS).
//
// Each outcome also records the closing line: the books' price for the
// picked side at the first vs the last pre-kickoff verdict (CLV) and the
// closing spread/total from the nflverse schedule.
//
// Usage: npm run grade-nfl-outcomes  [-- --lookback 10] [-- --dry-run]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./_env.mjs";
import { queryAxiom } from "./_axiom.mjs";
import { getCsv } from "./refresh-nfl-data.mjs";
import { parseWeeklyStats, parseSnapCounts, parseSchedule, parsePlayers } from "../api/_lib/nfl/nflverse.js";
import { gradeVerdict, playedState, latestBeforeKickoff, joinKey, openClose, clvFor, SETTLE_AFTER_MS, SNAP_WAIT_MS } from "../api/_lib/nfl/grading.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvLocal();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const lbIdx = args.indexOf("--lookback");
const LOOKBACK_DAYS = lbIdx >= 0 ? Number(args[lbIdx + 1]) : 10;

async function ingest(token, dataset, events) {
  for (let i = 0; i < events.length; i += 500) {
    const res = await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(events.slice(i, i + 500)),
    });
    if (!res.ok) throw new Error(`Axiom ingest HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

/** GSIS → PFR ids: the committed registry, topped up from players.csv for anyone missing. */
async function pfrIds(gsisIds) {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, "data/nfl-players.json"), "utf8")).players ?? {};
  const out = new Map();
  for (const g of gsisIds) if (reg[g]?.pfr_id) out.set(g, reg[g].pfr_id);
  if (out.size < gsisIds.size) {
    const all = parsePlayers(await getCsv("players/players.csv"));
    for (const g of gsisIds) if (!out.has(g) && all[g]?.pfr_id) out.set(g, all[g].pfr_id);
  }
  return out;
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) throw new Error("AXIOM_TOKEN not set");
  const D = `['${dataset}']`;
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  const verdicts = await queryAxiom(token, `${D} | where event_type == "verdict" and league == "NFL" and pre_filtered == false and source != "smoke-app" | limit 100000`, { start });
  const outcomes = await queryAxiom(token, `${D} | where event_type == "outcome" and league == "NFL" | project player, prop_type, line, direction, game_start_time | limit 100000`, { start: new Date(Date.now() - (LOOKBACK_DAYS + 10) * 86400000).toISOString() });
  const graded = new Set(outcomes.map(joinKey));
  const now = Date.now();
  const pending = latestBeforeKickoff(verdicts).filter((v) =>
    !graded.has(joinKey(v)) && v.gsis_id && v.nfl_game_id && v.nfl_stat &&
    Date.parse(v.game_start_time) + SETTLE_AFTER_MS < now);
  console.log(`=== grade-nfl-outcomes === lookback ${LOOKBACK_DAYS}d`);
  console.log(`  ${verdicts.length} NFL verdict events, ${graded.size} already graded, ${pending.length} ready to settle`);
  if (!pending.length) return;
  const oc = openClose(verdicts);

  const seasons = [...new Set(pending.map((v) => Number(String(v.nfl_game_id).slice(0, 4))))].filter(Number.isFinite);
  const games = new Map(parseSchedule(await getCsv("schedules/games.csv"), seasons).map((g) => [g.game_id, g]));
  const stats = new Map(), snaps = new Map(), statGames = new Set(), snapGames = new Set();
  for (const s of seasons) {
    const [st, sn] = await Promise.all([getCsv(`stats_player/stats_player_week_${s}.csv`), getCsv(`snap_counts/snap_counts_${s}.csv`)]);
    for (const r of st ? parseWeeklyStats(st) : []) { stats.set(`${r.game_id}|${r.player_id}`, r); statGames.add(r.game_id); }
    for (const r of sn ? parseSnapCounts(sn) : []) { snaps.set(`${r.game_id}|${r.pfr_id}`, r); snapGames.add(r.game_id); }
  }
  const pfr = await pfrIds(new Set(pending.map((v) => v.gsis_id)));

  const events = [];
  const tally = { hit: 0, miss: 0, push: 0, void: 0 };
  const waiting = { not_final: 0, no_stats: 0, no_snaps: 0 };
  const byGame = new Map();
  for (const v of pending) {
    const g = games.get(v.nfl_game_id);
    if (!g || g.home_score == null) { waiting.not_final++; continue; }
    if (!statGames.has(v.nfl_game_id)) { waiting.no_stats++; continue; }
    const statRow = stats.get(`${v.nfl_game_id}|${v.gsis_id}`) ?? null;
    const snapRow = pfr.has(v.gsis_id) ? snaps.get(`${v.nfl_game_id}|${pfr.get(v.gsis_id)}`) ?? null : null;
    let played = playedState({ statRow, snapRow, snapsPublished: snapGames.has(v.nfl_game_id) });
    let reason = null;
    if (played == null) {
      if (now - Date.parse(v.game_start_time) < SNAP_WAIT_MS) { waiting.no_snaps++; continue; }
      played = false;
      reason = "unverified";
    }
    const res = gradeVerdict(v, { statRow, played });
    tally[res.hit_or_miss]++;
    const lines = oc.get(joinKey(v)) ?? { open: v, close: v, n: 1 };
    events.push({
      _time: new Date().toISOString(),
      event_type: "outcome",
      source: "grade-nfl-outcomes",
      league: "NFL",
      player: v.player, prop_type: v.prop_type, line: v.line, direction: v.direction, game_start_time: v.game_start_time,
      gsis_id: v.gsis_id, nfl_game_id: v.nfl_game_id, nfl_stat: v.nfl_stat,
      actual_value: res.actual_value, hit_or_miss: res.hit_or_miss, reason: reason ?? res.reason,
      nfl_snaps: snapRow ? (snapRow.off_snaps ?? 0) + (snapRow.def_snaps ?? 0) + (snapRow.st_snaps ?? 0) : null,
      nfl_open_time: lines.open._time, nfl_close_time: lines.close._time, nfl_verdicts_n: lines.n,
      nfl_open_p_market: lines.open.nfl_p_market ?? null, nfl_close_p_market: lines.close.nfl_p_market ?? null,
      nfl_open_book_line: lines.open.nfl_book_line ?? null, nfl_close_book_line: lines.close.nfl_book_line ?? null,
      nfl_clv: clvFor(lines),
      nfl_close_spread_home: g.spread_line ?? null, nfl_close_total: g.total_line ?? null,
      nfl_final: `${g.away} ${g.away_score}-${g.home_score} ${g.home}`,
    });
    byGame.set(v.nfl_game_id, (byGame.get(v.nfl_game_id) ?? 0) + 1);
  }
  for (const [id, n] of [...byGame.entries()].sort()) {
    const g = games.get(id);
    console.log(`  ${g.away} ${g.away_score}-${g.home_score} ${g.home}: settled ${n}`);
  }
  const wait = Object.entries(waiting).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  console.log(`  result: ${JSON.stringify(tally)}${wait.length ? ` (waiting: ${wait.join(", ")})` : ""}`);
  if (DRY) {
    console.log(`  DRY RUN — ${events.length} outcomes not written. Sample: ${JSON.stringify(events[0] ?? null)}`);
    return;
  }
  if (events.length) {
    await ingest(token, dataset, events);
    console.log(`  wrote ${events.length} NFL outcome events to ${dataset}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
