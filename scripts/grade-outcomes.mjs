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
//   node scripts/grade-outcomes.mjs                        # grade yesterday
//   node scripts/grade-outcomes.mjs --date 2026-05-19      # grade specific UTC date
//   node scripts/grade-outcomes.mjs --lookback 14          # also retry ungraded from last 14 days
//   node scripts/grade-outcomes.mjs --dry-run              # show what would emit, don't write
//
// Postponed games stay ungraded automatically: when no gamelog entry
// matches the verdict's game_start_time, we skip and the next run
// (within the lookback window) will pick it up after the game plays.
//
// DNP rule (minutes == 0): emit outcome with hit_or_miss="void",
// reason="dnp". Excluded from hit-rate aggregations.

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

import { getLastNGames } from "../api/lib/espn-stats.js";
import { currentSeason } from "../api/lib/nba-stats.js";

const AXIOM_INGEST_URL_BASE = "https://api.axiom.co/v1/datasets";
const AXIOM_QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// Per-stat extractor against an ESPN gamelog entry. Composites are summed
// in JS so we don't depend on the gamelog shipping a PRA/PR/PA/RA field
// (it doesn't — getLastNGames computes PRA but not the partials).
const STAT_TO_ACTUAL = {
  Points: (g) => num(g.pts),
  Rebounds: (g) => num(g.reb),
  Assists: (g) => num(g.ast),
  PRA: (g) => num(g.pts) + num(g.reb) + num(g.ast),
  PR: (g) => num(g.pts) + num(g.reb),
  PA: (g) => num(g.pts) + num(g.ast),
  RA: (g) => num(g.reb) + num(g.ast),
  "3-Pointers Made": (g) => num(g.fg3m),
  "FG Attempted": (g) => num(g.fga),
};

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props-verdicts";
  if (!token) {
    console.error("AXIOM_TOKEN not set in .env.local — nothing to query.");
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const targetDate = opts.date ?? yesterdayUTCDate();
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
  const verdicts = await queryAxiom(token, dataset, {
    apl: `['${dataset}'] | where event_type == "verdict" and isnotnull(game_start_time) and isnotnull(espn_id)`,
    startTime: iso(windowStart),
    endTime: iso(windowEnd),
  });
  const outcomes = await queryAxiom(token, dataset, {
    apl: `['${dataset}'] | where event_type == "outcome"`,
    startTime: iso(windowStart),
    endTime: iso(windowEnd),
  });
  console.log(`Found ${verdicts.length} verdict events, ${outcomes.length} existing outcome events in window`);

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
      // Match on calendar date. game_start_time is an ISO string with TZ;
      // gamelog `date` is "YYYY-MM-DD" (per fmtDate in api/lib/string-utils).
      const targetDay = v.game_start_time ? v.game_start_time.slice(0, 10) : null;
      const entry = games.find((x) => x.date === targetDay);
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

  console.log(`\nResult: hits=${hits}  misses=${misses}  pushes=${pushes}  voids=${voids}`);
  console.log(`Ungraded (postponed / no gamelog yet): ${postponed}`);
  if (unmatched) console.log(`Unknown stat type: ${unmatched}`);
  if (errors) console.log(`Gamelog fetch errors: ${errors}`);
  const graded_count = hits + misses + pushes + voids;
  const non_void = hits + misses + pushes;
  if (non_void > 0) {
    console.log(`Hit rate: ${((hits / non_void) * 100).toFixed(1)}%  (excludes pushes? no — pushes counted in denominator)`);
  }

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

function canonicalStat(propType) {
  if (!propType) return null;
  return String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
}

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

function yesterdayUTCDate() {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
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
