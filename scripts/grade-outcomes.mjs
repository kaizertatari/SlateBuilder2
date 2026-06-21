// Outcome grader. Joins yesterday's verdicts (stored in Axiom by the
// analyze + analyze-all endpoints) against final ESPN box scores and
// emits one outcome event per verdict. Same Axiom dataset as the
// verdict events, discriminated by event_type:"outcome".
//
// Run locally (consistent with refresh-prizepicks.mjs). PrizePicks blocks
// Vercel egress IPs; ESPN does not, but keeping all grading local makes
// the cron story uniform: one Windows Task Scheduler entry per script.
//
// Usage:
//   node scripts/grade-outcomes.mjs                        # window ends today UTC, 7d back
//   node scripts/grade-outcomes.mjs --date 2026-05-19      # window ends on that UTC date
//   node scripts/grade-outcomes.mjs --lookback 14          # extend backfill / retry window
//   node scripts/grade-outcomes.mjs --dry-run              # show what would emit, don't write
//
// Default --date is today UTC (not yesterday): a 10am-ET run is 15:00 UTC,
// and the prior ET evening's slate straddles the UTC midnight boundary
// (east-coast tip-offs on the prior UTC day, west-coast late games on
// today's UTC day). A "today UTC" window covers both halves; the 7-day
// lookback handles retries for postponed games.
//
// Postponed games stay ungraded automatically: when no gamelog entry
// matches the verdict's game_start_time, we skip and the next run
// (within the lookback window) will pick it up after the game plays.
//
// DNP rule (minutes == 0): emit outcome with hit_or_miss="void",
// reason="dnp". Excluded from hit-rate aggregations.

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

import { getLastNGames } from "../api/_lib/espn-stats.js";
import { currentSeason } from "../api/_lib/nba-stats.js";
import { normalizeName } from "../api/_lib/string-utils.js";
import { loadWcMatchStats, indexWcMatchStatsByDate, mergeWcEntry, pickWcStat, wcActualFor, WC_FOTMOB_STATS_PATH } from "./_wc-actuals.mjs";

const AXIOM_INGEST_URL_BASE = "https://api.axiom.co/v1/datasets";
const AXIOM_QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// Per-stat extractor against an ESPN gamelog entry. Composites are summed
// in JS so we don't depend on the gamelog shipping a PRA/PR/PA/RA field
// (it doesn't — getLastNGames computes PRA but not the partials).
//
// Fantasy Score uses the FanDuel formula:
//   pts + 1.2·reb + 1.5·ast + 3·stl + 3·blk − 1·tov
// matching api/_lib/ground-truth.js fantasyScoreFanDuel. Missing tov in the
// gamelog (rare; ESPN ships TO in the column map) underestimates the
// penalty by at most ~2-3 pts on a ~50-pt baseline — acceptable risk for
// hit/miss decisions; if it becomes a problem we can return null and
// treat the grade as unknown like postponed games.
const STAT_TO_ACTUAL = {
  Points: (g) => num(g.pts),
  Rebounds: (g) => num(g.reb),
  Assists: (g) => num(g.ast),
  PRA: (g) => num(g.pts) + num(g.reb) + num(g.ast),
  PR: (g) => num(g.pts) + num(g.reb),
  PA: (g) => num(g.pts) + num(g.ast),
  RA: (g) => num(g.reb) + num(g.ast),
  "3-Pointers Made": (g) => num(g.fg3m),
  "3-Pointers Attempted": (g) => num(g.fg3a),
  "FG Attempted": (g) => num(g.fga),
  "Blocks+Steals": (g) => num(g.blk) + num(g.stl),
  "Fantasy Score": (g) =>
    num(g.pts)
    + 1.2 * num(g.reb)
    + 1.5 * num(g.ast)
    + 3 * num(g.stl)
    + 3 * num(g.blk)
    - num(g.tov),
};

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) {
    console.error("AXIOM_TOKEN not set in .env.local — nothing to query.");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const targetDate = opts.date ?? todayUTCDate();
  const lookbackDays = opts.lookback ?? 7;
  const dryRun = !!opts.dryRun;

  // Scan window covers the target date + lookback (for postponed retries).
  // Use UTC day boundaries so a verdict logged at 03:00 ET (07:00 UTC)
  // and its outcome at 03:00 next day land in adjacent days the same way
  // every day, regardless of DST.
  const windowEnd = new Date(`${targetDate}T23:59:59.999Z`);
  const windowStart = new Date(windowEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  console.log(`=== grade-outcomes ===`);
  console.log(`Target: ${targetDate}  Lookback: ${lookbackDays}d  Window: [${iso(windowStart)} → ${iso(windowEnd)}]`);
  console.log(`Dataset: ${dataset}${dryRun ? "  (DRY RUN)" : ""}`);

  // Pull verdicts + existing outcomes in the window in two queries; join
  // in JS. APL has a join operator but the syntax is fussier than this
  // two-shot approach, and the dataset is small.
  //
  // We DON'T filter by isnotnull(game_start_time) in APL because Axiom's
  // schema is data-driven: a where-clause referencing a field that has
  // never been ingested throws "invalid field" at query time. Instead we
  // pull all verdict events in the window and filter in JS. Old-schema
  // events (without game_start_time / espn_id) drop out naturally.
  // `| limit 100000` is REQUIRED: Axiom returns only 1000 rows when no limit is
  // given, silently truncating the window. A busy slate logs >1000 verdicts in a
  // few days, so without this the grader (and its WC leg, which reads verdictsRaw
  // below) only ever sees an arbitrary 1000-row slice and leaves the rest
  // ungraded — starving calibration of outcomes. Mirrors _axiom.mjs.
  const verdictsRaw = await queryAxiom(token, dataset, {
    apl: `['${dataset}'] | where event_type == "verdict" | limit 100000`,
    startTime: iso(windowStart),
    endTime: iso(windowEnd),
  });
  const verdicts = verdictsRaw.filter((v) => v.game_start_time && v.espn_id);
  const outcomes = await queryAxiom(token, dataset, {
    apl: `['${dataset}'] | where event_type == "outcome" | limit 100000`,
    startTime: iso(windowStart),
    endTime: iso(windowEnd),
  });
  console.log(`Found ${verdicts.length}/${verdictsRaw.length} usable verdict events (with game_start_time + espn_id), ${outcomes.length} existing outcome events in window`);

  // Build a Set of join keys that ALREADY have outcomes — we won't regrade.
  const graded = new Set();
  for (const o of outcomes) graded.add(joinKey(o));

  // Filter to ungraded verdicts. Dedupe by join key (a single prop may
  // have multiple verdict events if the user hit analyze repeatedly).
  const ungradedByKey = new Map();
  for (const v of verdicts) {
    const k = joinKey(v);
    if (graded.has(k)) continue;
    if (!ungradedByKey.has(k)) ungradedByKey.set(k, v);
  }
  const ungraded = [...ungradedByKey.values()];
  console.log(`${ungraded.length} ungraded verdicts to evaluate`);
  if (ungraded.length === 0) {
    console.log("Nothing to grade. Done.");
    return;
  }

  // Group by (espn_id, league, is_playoff, game_start_time's UTC date) so
  // we make one ESPN gamelog call per player+date. ESPN gamelogs are
  // season-scoped, so grouping by season-end-year is implicit via the
  // game_start_time year.
  const groups = new Map();
  for (const v of ungraded) {
    const k = `${v.espn_id}::${v.league}::${v.is_playoff ? "1" : "0"}::${seasonEndYearForDate(v.game_start_time, v.league)}`;
    if (!groups.has(k)) groups.set(k, { espn_id: v.espn_id, league: v.league, is_playoff: !!v.is_playoff, season: seasonLabel(v.league, seasonEndYearForDate(v.game_start_time, v.league)), verdicts: [] });
    groups.get(k).verdicts.push(v);
  }
  console.log(`Grouped into ${groups.size} player+season gamelog fetches`);

  let hits = 0, misses = 0, pushes = 0, voids = 0, postponed = 0, unmatched = 0, errors = 0;
  // Audit counters for the LLM hallucination + unjustified-SKIP guardrails.
  // These describe behavior the verifier tagged on the verdict; they aren't
  // affected by the win/loss grading above.
  let auditRetryRecovered = 0;          // retry fired and salvaged the pick
  let auditUnjustifiedAfterRetry = 0;   // retry fired and still came back unjustified
  let auditMissedPicks = 0;             // unjustified_after_retry that the actual outcome shows would have hit
  let auditMismatches = 0;              // verdicts where data_used disagreed with groundTruth
  const missedPickSamples = [];
  const outcomeEvents = [];

  for (const g of groups.values()) {
    // Fetch a generous L50 so the lookback window is fully covered.
    let gamelog = null;
    try {
      gamelog = await getLastNGames(g.espn_id, 50, {
        season: g.season,
        postseason: g.is_playoff,
        league: g.league,
      });
    } catch (err) {
      errors += g.verdicts.length;
      console.warn(`  ESPN gamelog fetch failed for espn_id=${g.espn_id} ${g.league} ${g.season}: ${err.message}`);
      continue;
    }
    const games = gamelog?.games ?? [];

    for (const v of g.verdicts) {
      // Audit counters — tally regardless of whether the actual game is
      // gradeable. These reflect verifier decisions on the verdict itself.
      if (v.retry_recovered === true) auditRetryRecovered++;
      if (v.skip_kind === "unjustified_after_retry") auditUnjustifiedAfterRetry++;
      if (Array.isArray(v.data_used_mismatches) && v.data_used_mismatches.length > 0) auditMismatches++;

      // Match on calendar date. game_start_time is an ISO string with TZ
      // ("2026-05-22T23:30Z"); gamelog `date` is the human-readable
      // "MMM DD, YYYY" format from fmtDate (string-utils.js). Parse the
      // gamelog date into ISO YYYY-MM-DD before comparing — earlier
      // versions of fmtDate emitted YYYY-MM-DD which is why the comment
      // claimed direct equality; that contract changed but this matcher
      // was never updated.
      const targetDay = v.game_start_time ? v.game_start_time.slice(0, 10) : null;
      const entry = games.find((x) => {
        const d = new Date(x.date);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === targetDay;
      });
      if (!entry) {
        postponed++;
        continue;
      }
      const stat = canonicalStat(v.prop_type);
      const getActual = STAT_TO_ACTUAL[stat];
      if (!getActual) {
        unmatched++;
        continue;
      }
      const actual = getActual(entry);
      const minutes = num(entry.minutes);

      // Missed-picks report: SKIP verdicts the LLM never grounded in a rule.
      // If the actual outcome would have hit the requested direction, that's
      // edge the model left on the table. Skip DNPs — a void doesn't reveal
      // anything about model judgment.
      if (v.skip_kind === "unjustified_after_retry" && minutes > 0) {
        const wouldHaveBeen = gradeRaw(actual, num(v.line), v.direction);
        if (wouldHaveBeen === "hit") {
          auditMissedPicks++;
          if (missedPickSamples.length < 10) {
            missedPickSamples.push({
              player: v.player,
              prop_type: v.prop_type,
              direction: v.direction,
              line: v.line,
              actual,
              date: targetDay,
            });
          }
        }
      }

      let outcome;
      if (minutes === 0) {
        outcome = { hit_or_miss: "void", reason: "dnp", actual_value: null };
        voids++;
      } else {
        const r = gradeRaw(actual, num(v.line), v.direction);
        outcome = { hit_or_miss: r, reason: null, actual_value: actual };
        if (r === "hit") hits++;
        else if (r === "miss") misses++;
        else pushes++;
      }
      outcomeEvents.push(buildOutcomeEvent(v, entry, outcome));
    }
  }

  // ── World Cup (soccer) leg — WC_FRAMEWORK_SPEC.md §7 ──────────────────────
  // WC verdicts carry no espn_id (soccer identity never touches players.json),
  // so the basketball gamelog join above filtered them out. Actuals come from
  // ESPN fifa.world match summaries (per-player shots / shots on target),
  // matched by normalized player name on the verdict's match date.
  const wcUngradedByKey = new Map();
  for (const v of verdictsRaw) {
    if (v.league !== "WC" || !v.game_start_time) continue;
    const k = joinKey(v);
    if (graded.has(k) || wcUngradedByKey.has(k)) continue;
    wcUngradedByKey.set(k, v);
  }
  const wcUngraded = [...wcUngradedByKey.values()];
  let wcHits = 0, wcMisses = 0, wcPushes = 0, wcVoids = 0, wcPostponed = 0, wcUnmatched = 0;
  const wcUngradeableByStat = new Map();
  let wcFbFilled = 0;
  if (wcUngraded.length) {
    console.log(`\n=== World Cup leg: ${wcUngraded.length} ungraded WC verdicts ===`);
    // Snapshot fallbacks — fill the stats ESPN rosters don't carry
    // (tk/clr/pa/kp/cr/drb → Tackles/Clearances/Passes Attempted/fantasy).
    // FotMob is preferred (it carries the advanced Opta stats; FBref has
    // posted none this tournament), FBref fills any gap, ESPN wins overall.
    const fbSnap = await loadWcMatchStats();
    const fbByDate = indexWcMatchStatsByDate(fbSnap);
    const fmSnap = await loadWcMatchStats(WC_FOTMOB_STATS_PATH);
    const fmByDate = indexWcMatchStatsByDate(fmSnap);
    const snapDesc = (label, snap, hint) => snap
      ? `  ${label}: ${snap.total_matches ?? Object.keys(snap.matches).length} match reports (fetched ${snap.fetched_at})`
      : `  ${label}: none — ${hint}`;
    console.log(snapDesc("FotMob fallback", fmSnap, "node scripts/refresh-wc-fotmob-stats.mjs --headed"));
    console.log(snapDesc("FBref fallback", fbSnap, "node scripts/refresh-wc-match-stats.mjs --headed"));
    const byDate = new Map();
    for (const v of wcUngraded) {
      const d = v.game_start_time.slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(v);
    }
    for (const [date, vs] of byDate) {
      let actuals;
      try {
        actuals = await fetchWorldCupActuals(date);
      } catch (err) {
        console.warn(`  WC actuals fetch failed for ${date}: ${err.message}`);
        wcPostponed += vs.length;
        continue;
      }
      const fbDay = fbByDate.get(date);
      const fmDay = fmByDate.get(date);
      for (const v of vs) {
        const espnEntry = actuals.players.get(normalizeName(v.player)) ?? null;
        const fbEntry = fbDay?.get(normalizeName(v.player)) ?? null;
        const fmEntry = fmDay?.get(normalizeName(v.player)) ?? null;
        // FotMob preferred over FBref, then ESPN wins over both.
        const snapEntry = mergeWcEntry(fmEntry, fbEntry);
        const entry = mergeWcEntry(espnEntry, snapEntry);
        if (!entry) {
          // Not on any completed match's roster that day: match still in
          // progress/postponed (retry within the lookback window) or a
          // PP↔ESPN name mismatch (counted, surfaced, never auto-graded).
          if (actuals.completed_events === 0) wcPostponed++;
          else wcUnmatched++;
          continue;
        }
        if (!entry.played) {
          outcomeEvents.push(buildWcOutcomeEvent(v, entry, { hit_or_miss: "void", reason: "dnp", actual_value: null }));
          wcVoids++;
          continue;
        }
        const stat = canonicalStat(v.prop_type);
        const actual = wcActualFor(stat, entry);
        if (actual == null) {
          wcUnmatched++;
          wcUngradeableByStat.set(stat, (wcUngradeableByStat.get(stat) || 0) + 1);
          continue;
        }
        // FBref provided what ESPN couldn't (or the whole entry) — telemetry
        // for how load-bearing the fallback is per slate.
        if (espnEntry == null || wcActualFor(stat, espnEntry) == null) wcFbFilled++;
        const r = gradeRaw(actual, num(v.line), v.direction);
        outcomeEvents.push(buildWcOutcomeEvent(v, entry, { hit_or_miss: r, reason: null, actual_value: actual }));
        if (r === "hit") wcHits++;
        else if (r === "miss") wcMisses++;
        else wcPushes++;
      }
    }
    console.log(`WC result: hits=${wcHits}  misses=${wcMisses}  pushes=${wcPushes}  voids=${wcVoids}  postponed=${wcPostponed}  unmatched=${wcUnmatched}  snap_filled=${wcFbFilled}`);
    if (wcUngradeableByStat.size) {
      // Neither ESPN nor the FBref snapshot resolved these — spec §10.6:
      // surface, never guess. Usually means data/wc-match-stats.json is
      // stale for the date: run refresh-wc-match-stats and re-grade (the
      // lookback window retries automatically).
      for (const [stat, n] of wcUngradeableByStat) {
        console.warn(`  UNGRADEABLE: ${stat} ×${n} — no stat resolved from ESPN or FBref snapshot`);
      }
    }
  }

  console.log(`\nResult: hits=${hits}  misses=${misses}  pushes=${pushes}  voids=${voids}`);
  console.log(`Ungraded (postponed / no gamelog yet): ${postponed}`);
  if (unmatched) console.log(`Unknown stat type: ${unmatched}`);
  if (errors) console.log(`Gamelog fetch errors: ${errors}`);
  const graded_count = hits + misses + pushes + voids;
  const non_void = hits + misses + pushes;
  if (non_void > 0) {
    console.log(`Hit rate: ${((hits / non_void) * 100).toFixed(1)}%  (excludes pushes? no — pushes counted in denominator)`);
  }

  // LLM-guardrail audit summary. Surfaces (a) whether the one-shot retry
  // for unjustified SKIPs is paying for itself, (b) how much edge the
  // model leaves on the table when it SKIPs without grounding, (c) the
  // hallucination rate on data_used echoes.
  const retryAttempts = auditRetryRecovered + auditUnjustifiedAfterRetry;
  console.log(`\n--- LLM audit ---`);
  console.log(`Retry attempts: ${retryAttempts}  (recovered ${auditRetryRecovered}, still unjustified ${auditUnjustifiedAfterRetry})`);
  if (retryAttempts > 0) {
    console.log(`Retry recovery rate: ${((auditRetryRecovered / retryAttempts) * 100).toFixed(1)}%`);
  }
  if (auditUnjustifiedAfterRetry > 0) {
    console.log(`Missed picks (unjustified SKIP would have hit): ${auditMissedPicks}/${auditUnjustifiedAfterRetry}  (${((auditMissedPicks / auditUnjustifiedAfterRetry) * 100).toFixed(1)}%)`);
    if (missedPickSamples.length) {
      console.log(`Sample missed picks:`);
      for (const s of missedPickSamples) {
        console.log(`  ${s.date}  ${s.player}  ${s.prop_type} ${s.direction} ${s.line}  → actual ${s.actual}`);
      }
    }
  }
  console.log(`Data_used mismatches: ${auditMismatches}  (LLM echoed values diverging from groundTruth)`);

  if (dryRun) {
    console.log(`\nDRY RUN — would emit ${outcomeEvents.length} outcome events. Sample:`);
    if (outcomeEvents.length) console.log(JSON.stringify(outcomeEvents[0], null, 2));
    return;
  }

  if (outcomeEvents.length) {
    await ingestEvents(token, dataset, outcomeEvents);
    console.log(`Emitted ${outcomeEvents.length} outcome events to ${dataset}.`);
  }
}

// ─── Axiom helpers ─────────────────────────────────────────────────────────

async function queryAxiom(token, dataset, { apl, startTime, endTime }) {
  const res = await fetch(AXIOM_QUERY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl, startTime, endTime }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Axiom query HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Tabular response: { tables: [{ name, fields: [{name}], columns: [[v0,v1,...], ...] }] }
  const table = data?.tables?.[0];
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.columns)) return [];
  const fields = table.fields.map((f) => f.name);
  const rowCount = table.columns[0]?.length ?? 0;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    for (let c = 0; c < fields.length; c++) row[fields[c]] = table.columns[c][i];
    rows.push(row);
  }
  return rows;
}

async function ingestEvents(token, dataset, events) {
  // Chunk to keep request bodies small. Axiom accepts JSON arrays.
  const CHUNK = 500;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const res = await fetch(`${AXIOM_INGEST_URL_BASE}/${encodeURIComponent(dataset)}/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(slice),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Axiom ingest HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

// ─── Outcome event shape ───────────────────────────────────────────────────

function buildOutcomeEvent(verdict, gamelogEntry, outcome) {
  return {
    _time: new Date().toISOString(),
    event_type: "outcome",
    source: "grade-outcomes",
    // Join keys — must exactly match the verdict event so Axiom queries
    // can leftouter-join on these fields without ambiguity.
    player: verdict.player,
    prop_type: verdict.prop_type,
    line: verdict.line,
    direction: verdict.direction,
    game_start_time: verdict.game_start_time,
    espn_id: verdict.espn_id,
    nba_id: verdict.nba_id ?? null,
    league: verdict.league,
    is_playoff: !!verdict.is_playoff,
    // Outcome
    actual_value: outcome.actual_value,
    hit_or_miss: outcome.hit_or_miss,  // "hit" | "miss" | "push" | "void"
    reason: outcome.reason,             // null on normal grading; "dnp" on void
    // Gamelog context — useful for sanity-checking the join
    game_id: gamelogEntry.game_id,
    matchup: gamelogEntry.matchup,
    minutes: num(gamelogEntry.minutes),
    pts: num(gamelogEntry.pts),
    reb: num(gamelogEntry.reb),
    ast: num(gamelogEntry.ast),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function joinKey(e) {
  return [
    String(e.player ?? ""),
    String(e.prop_type ?? ""),
    Number(e.line),
    String(e.direction ?? ""),
    String(e.game_start_time ?? ""),
  ].join("|");
}

// ─── World Cup (soccer) helpers ─────────────────────────────────────────────

const WC_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const WC_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";

// ESPN soccer ships stats as abbreviation/name pairs; both are indexed
// into the stat map. Keys were validated 2026-06-12 against event 760415
// (Mexico–South Africa) — fifa.world rosters carry only: SHOT, SOG, SV, G,
// A, FC, FA, YC, RC, OF, OG, GA, SHF, SUB, APP (appearances — NOT passes).
// Tackles/clearances/key passes/crosses/dribbles/passes are absent → those
// fields stay null here and the FBref match-stats snapshot fills them
// (mergeWcEntry in _wc-actuals.mjs; refreshed by refresh-wc-match-stats).

// Per-player actuals for every COMPLETED fifa.world match on a UTC date.
// Returns { completed_events, players: Map<normName, { name, team, played,
// sh, st, event_id }> }. "played" = started or subbed in (or has stats);
// rostered-but-unused → void/dnp.
async function fetchWorldCupActuals(dateYmd) {
  const dates = dateYmd.replace(/-/g, "");
  const sbRes = await fetch(`${WC_SCOREBOARD}?dates=${dates}`, { signal: AbortSignal.timeout(15000) });
  if (!sbRes.ok) throw new Error(`scoreboard HTTP ${sbRes.status}`);
  const sb = await sbRes.json();
  const players = new Map();
  let completedEvents = 0;
  for (const ev of sb?.events ?? []) {
    if (ev?.status?.type?.completed !== true) continue;
    completedEvents++;
    const sumRes = await fetch(`${WC_SUMMARY}?event=${ev.id}`, { signal: AbortSignal.timeout(15000) });
    if (!sumRes.ok) continue;
    const sum = await sumRes.json();
    for (const side of sum?.rosters ?? []) {
      const teamName = side?.team?.displayName ?? null;
      for (const slot of side?.roster ?? []) {
        const name = slot?.athlete?.displayName;
        if (!name) continue;
        const statMap = {};
        for (const s of slot?.stats ?? []) {
          const val = Number(s?.value ?? s?.displayValue);
          if (!Number.isFinite(val)) continue;
          // Index abbreviation AND name — candidates reference both forms.
          if (s?.abbreviation != null) statMap[s.abbreviation] = val;
          if (s?.name != null) statMap[s.name] = val;
        }
        const played = slot?.starter === true || slot?.subbedIn === true || Object.keys(statMap).length > 0;
        players.set(normalizeName(name), {
          name,
          team: teamName,
          played,
          sh: pickWcStat(statMap, ["SHOT", "totalShots", "SH", "shotsTotal"]),
          st: pickWcStat(statMap, ["SOG", "shotsOnTarget", "ST", "SOT"]),
          // v2 stats (spec §10.6) — a missing key returns null and the
          // verdict counts as ungradeable (surfaced per stat below), never
          // guessed. Validated 2026-06-12: ESPN rosters carry NONE of
          // tk/clr/pa — kept as forward-compat candidates only. APP is
          // appearances, never a passes key (was a silent mis-grade).
          tk: pickWcStat(statMap, ["TKL", "TCK", "totalTackles", "tacklesTotal"]),
          sv: pickWcStat(statMap, ["SV", "SVS", "saves", "goalkeeperSaves"]),
          clr: pickWcStat(statMap, ["CLR", "totalClearance", "clearances"]),
          pa: pickWcStat(statMap, ["totalPasses", "passesAttempted", "totalPassesAttempted"]),
          // Fantasy components beyond the above (goals/assists usually ship;
          // key passes/crosses/dribbles/fouls/cards spotty on ESPN rosters).
          g: pickWcStat(statMap, ["G", "totalGoals", "goals", "Goals"]),
          a: pickWcStat(statMap, ["A", "goalAssists", "assists", "Assists"]),
          kp: pickWcStat(statMap, ["KP", "keyPasses", "shotAssists"]),
          cr: pickWcStat(statMap, ["CR", "crosses", "totalCrosses"]),
          drb: pickWcStat(statMap, ["DRB", "takeOns", "dribblesAttempted"]),
          fc: pickWcStat(statMap, ["FC", "foulsCommitted", "fouls"]),
          yc: pickWcStat(statMap, ["YC", "yellowCards"]),
          rc: pickWcStat(statMap, ["RC", "redCards"]),
          event_id: ev.id,
        });
      }
    }
  }
  return { completed_events: completedEvents, players };
}

// Mirrors buildOutcomeEvent with soccer context: no espn_id/nba_id identity
// (the join key never includes them), matchup = the player's country.
function buildWcOutcomeEvent(verdict, entry, outcome) {
  return {
    _time: new Date().toISOString(),
    event_type: "outcome",
    source: "grade-outcomes",
    player: verdict.player,
    prop_type: verdict.prop_type,
    line: verdict.line,
    direction: verdict.direction,
    game_start_time: verdict.game_start_time,
    espn_id: null,
    nba_id: null,
    league: "WC",
    is_playoff: false,
    actual_value: outcome.actual_value,
    hit_or_miss: outcome.hit_or_miss,
    reason: outcome.reason,
    game_id: entry?.event_id ?? null,
    matchup: entry?.team ?? null,
  };
}

function canonicalStat(propType) {
  if (!propType) return null;
  return String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
}

// wcActualFor / WC_FANTASY_COMPONENTS / pickWcStat live in _wc-actuals.mjs
// (shared with the FBref match-stats fallback and its smoke).

function gradeRaw(actual, line, direction) {
  if (!Number.isFinite(actual) || !Number.isFinite(line)) return "miss";
  if (actual === line) return "push";
  if (String(direction).toUpperCase() === "OVER") return actual > line ? "hit" : "miss";
  return actual < line ? "hit" : "miss";
}

function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(d) {
  return d.toISOString();
}

function todayUTCDate() {
  return new Date().toISOString().slice(0, 10);
}

function seasonEndYearForDate(isoString, league) {
  // NBA seasons span calendar years; the END year is what ESPN keys on.
  // A game played in May 2026 is the 2025-26 season → endYear 2026.
  // A game in October 2025 is the 2025-26 season → endYear 2026.
  // WNBA is single-year (2025), so endYear == year of play.
  if (!isoString) return null;
  const d = new Date(isoString);
  const y = d.getUTCFullYear();
  if (league === "WNBA") return y;
  // NBA: Jul-Dec → endYear = y+1; Jan-Jun → endYear = y
  const m = d.getUTCMonth() + 1;
  return m >= 7 ? y + 1 : y;
}

function seasonLabel(league, endYear) {
  if (!endYear) return null;
  if (league === "WNBA") return String(endYear);
  return `${endYear - 1}-${String(endYear % 100).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--lookback") out.lookback = parseInt(argv[++i], 10);
    else if (a === "--dry-run" || a === "--dryrun") out.dryRun = true;
  }
  return out;
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
