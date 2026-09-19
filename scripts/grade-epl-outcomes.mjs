// EPL outcome grader. Settles logged EPL verdicts (engine_mode "epl-v1",
// from analyze-all / build-slate / sweep-epl-board) against FotMob's final
// player stats and writes one outcome event per join key — same Axiom
// dataset and join keys as the basketball grader, tagged league "EPL".
//
// PrizePicks settlement: DNP (0 minutes / not in the squad) → void; an exact
// tie on an integer line → push. FotMob's counts use Opta definitions (tackles
// and saves matched FPL exactly on 2026-09-18).
//
// Usage: npm run grade-epl-outcomes  [-- --lookback 10] [-- --dry-run]

import { loadEnvLocal } from "./_env.mjs";
import { queryAxiom } from "./_axiom.mjs";
import { extractNextData, matchPageUrl, parseMatch } from "../api/_lib/epl/fotmob.js";
import { gradeVerdict, latestBeforeKickoff, joinKey } from "../api/_lib/epl/grading.js";

loadEnvLocal();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const lbIdx = args.indexOf("--lookback");
const LOOKBACK_DAYS = lbIdx >= 0 ? Number(args[lbIdx + 1]) : 10;
const SETTLE_AFTER_MS = 2.5 * 3600 * 1000; // kickoff + 2.5h ≈ final whistle + stats
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFinishedMatch(matchId) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(matchPageUrl(matchId), { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000) });
      if (res.ok) {
        const props = extractNextData(await res.text());
        if (!props?.header?.status?.finished) return { finished: false };
        return { finished: true, parsed: parseMatch(props) };
      }
    } catch { /* retry */ }
    await sleep(1500 * i);
  }
  return null;
}

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

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) throw new Error("AXIOM_TOKEN not set");
  const D = `['${dataset}']`;
  const start = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  const verdicts = await queryAxiom(token, `${D} | where event_type == "verdict" and league == "EPL" and pre_filtered == false | limit 100000`, { start });
  const outcomes = await queryAxiom(token, `${D} | where event_type == "outcome" and league == "EPL" | project player, prop_type, line, direction, game_start_time | limit 100000`, { start: new Date(Date.now() - (LOOKBACK_DAYS + 10) * 86400000).toISOString() });
  const graded = new Set(outcomes.map(joinKey));
  const now = Date.now();
  const pending = latestBeforeKickoff(verdicts).filter((v) =>
    !graded.has(joinKey(v)) && v.fotmob_match_id && v.fotmob_player_id && v.epl_stat &&
    Date.parse(v.game_start_time) + SETTLE_AFTER_MS < now);
  console.log(`=== grade-epl-outcomes === lookback ${LOOKBACK_DAYS}d`);
  console.log(`  ${verdicts.length} EPL verdict events, ${graded.size} already graded, ${pending.length} ready to settle`);
  if (!pending.length) return;

  const byMatch = new Map();
  for (const v of pending) {
    if (!byMatch.has(v.fotmob_match_id)) byMatch.set(v.fotmob_match_id, []);
    byMatch.get(v.fotmob_match_id).push(v);
  }
  const events = [];
  const tally = { hit: 0, miss: 0, push: 0, void: 0 };
  let notFinished = 0;
  for (const [matchId, vs] of byMatch) {
    const m = await fetchFinishedMatch(matchId);
    if (!m) { console.warn(`  ! match ${matchId}: fetch failed — retry next run`); continue; }
    if (!m.finished || !m.parsed) { notFinished += vs.length; continue; }
    const rows = new Map(m.parsed.players.map((r) => [r.player_id, r]));
    for (const v of vs) {
      const g = gradeVerdict(v, rows.get(String(v.fotmob_player_id)) ?? null);
      tally[g.hit_or_miss]++;
      events.push({
        _time: new Date().toISOString(),
        event_type: "outcome",
        source: "grade-epl-outcomes",
        league: "EPL",
        player: v.player, prop_type: v.prop_type, line: v.line, direction: v.direction, game_start_time: v.game_start_time,
        fotmob_player_id: v.fotmob_player_id, fotmob_match_id: v.fotmob_match_id, epl_stat: v.epl_stat,
        actual_value: g.actual_value, hit_or_miss: g.hit_or_miss, reason: g.reason, minutes: g.minutes,
      });
    }
    console.log(`  ${m.parsed.match.home.name} ${m.parsed.match.home.score}-${m.parsed.match.away.score} ${m.parsed.match.away.name}: settled ${vs.length}`);
    await sleep(800);
  }
  console.log(`  result: ${JSON.stringify(tally)}${notFinished ? ` (${notFinished} waiting on unfinished matches)` : ""}`);
  if (DRY) {
    console.log(`  DRY RUN — ${events.length} outcomes not written. Sample: ${JSON.stringify(events[0])}`);
    return;
  }
  if (events.length) {
    await ingest(token, dataset, events);
    console.log(`  wrote ${events.length} EPL outcome events to ${dataset}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
