// One-shot diagnostic for a single prop: "why didn't this fire?".
//
// Invokes POST /api/analyze directly (no HTTP round-trip needed) and
// prints the verdict alongside the ground-truth values + verifier math
// that drove it. Designed for "I expected OVER but got SKIP" debugging.
//
// Usage:
//   node scripts/smoke-prop.mjs "Jarrett Allen" "Points OVER" 7.5
//   node scripts/smoke-prop.mjs "Caitlin Clark" "Assists UNDER" 8.5
//
// Exit code: 0 always — this is a diagnostic, not a pass/fail check.

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

import { PROP_TO_FIELD } from "../api/lib/prop-types.js";
import { FRAMEWORK_SCALING, ftFloorBaseline } from "../api/lib/framework.js";

const [, , playerArg, propTypeArg, lineArg] = process.argv;
if (!playerArg || !propTypeArg || lineArg == null) {
  console.error(`Usage: node scripts/smoke-prop.mjs "<player>" "<Stat OVER|UNDER>" <line>`);
  console.error(`Example: node scripts/smoke-prop.mjs "Jarrett Allen" "Points OVER" 7.5`);
  process.exit(2);
}
const line = Number(lineArg);
if (!Number.isFinite(line)) {
  console.error(`line "${lineArg}" is not a number`);
  process.exit(2);
}

const { POST } = await import("../api/analyze.js");

const req = new Request("http://localhost/api/analyze", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.42" },
  body: JSON.stringify({ player: playerArg, propType: propTypeArg, line }),
});

const t0 = Date.now();
const res = await POST(req);
const elapsed = Date.now() - t0;
const body = await res.json();

const direction = /UNDER/i.test(propTypeArg) ? "UNDER" : "OVER";
const statType = propTypeArg.replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
const field = PROP_TO_FIELD[statType] ?? null;

// ─── Header ────────────────────────────────────────────────────────────────

console.log(`\n=== ${playerArg} — ${propTypeArg} ${line} ===`);
console.log(`HTTP ${res.status} in ${elapsed}ms`);

if (body.error) {
  console.log(`\nERROR: ${body.error}`);
  process.exit(0);
}

// ─── Verdict ──────────────────────────────────────────────────────────────

const v = body.verdict ?? "—";
const t = body.tier ?? "—";
const c = body.confidence ?? "—";
console.log(`\nVerdict: ${v} / ${t} (confidence ${c})`);
if (body.overridden) {
  console.log(`OVERRIDDEN by verifier: ${(body.override_reasons || []).join(", ") || "(no reason)"}`);
}
if (body.pre_filtered) {
  console.log(`PRE-FILTERED — LLM was never called.`);
}
if (body.justification) {
  console.log(`Justification: ${body.justification}`);
}
if (Array.isArray(body.flags) && body.flags.length) {
  console.log(`Flags:`);
  for (const f of body.flags) console.log(`  • ${f}`);
}

// ─── Ground truth — the inputs the framework saw ─────────────────────────

const gt = body.ground_truth;
if (!gt) {
  console.log(`\n(no ground_truth on response — likely a missing-data SKIP)`);
  process.exit(0);
}

console.log(`\n--- Game context ---`);
const opp = gt.opponent_team?.abbr ?? "?";
const home = gt.home_away ?? "?";
console.log(`  ${gt.player?.team_abbr ?? "?"} ${home === "home" ? "vs" : "@"} ${opp}   (home_away=${home})`);
if (gt.series) {
  console.log(`  Playoff: ${gt.series.round ?? "?"} G${gt.series.next_game_number ?? "?"}  (${gt.series.series_summary ?? "?"})`);
} else {
  console.log(`  Regular season`);
}
if (gt.win_prob?.player_team_pct != null) {
  console.log(`  Win prob (team): ${(gt.win_prob.player_team_pct * 100).toFixed(0)}%`);
}
if (gt.game?.days_out > 0) {
  console.log(`  Forward-looking: game is ${gt.game.days_out}d out`);
}
if (gt.player_recent?.is_listed_injured) {
  console.log(`  ⚠ Player is on the injury report — Section 6 post-injury gate active`);
}

console.log(`\n--- Baselines (field=${field ?? "?"}) ---`);
const seasonAvg = field ? gt.season?.averages?.[field] : null;
const l5Avg = field ? gt.l5?.averages?.[field] : null;
const l5Type = gt.l5?.type ?? "?";
const l5N = gt.l5?.n ?? 0;
console.log(`  season.averages.${field}: ${fmt(seasonAvg)}`);
console.log(`  l5.averages.${field}:     ${fmt(l5Avg)}  (type=${l5Type}, n=${l5N})`);
if (gt.season?.is_prior_season) console.log(`  ⚠ season is PRIOR-SEASON fallback (opening-day cliff)`);
if (gt.l5?.is_prior_season) console.log(`  ⚠ l5 is PRIOR-SEASON fallback`);
if (Array.isArray(gt.data_warnings) && gt.data_warnings.length) {
  console.log(`  data_warnings: ${gt.data_warnings.join(", ")}`);
}

// ─── Re-derive the verifier math so you can see exactly why a buffer failed
// or passed. Mirrors verdict-verifier.js:217-267 / 269-300; if those rules
// move, update here. Kept inline (not imported) so this script doubles as a
// printed reference for what the rules actually compute.

const league = String(gt.league ?? "NBA").toUpperCase();
const scale = FRAMEWORK_SCALING[league] ?? FRAMEWORK_SCALING.NBA;
const isPlayoffGame = !!gt.series;
const isPlayoffL5 = l5Type === "Playoffs" && l5N >= 3;
const POINTS_CONTAINING = new Set(["Points", "PR", "PA", "PRA"]);
const FT_FLOOR_PROPS = new Set(["Points", "PRA"]);
const ASSIST_CONTAINING = new Set(["Assists", "PA", "RA", "PRA"]);

console.log(`\n--- Verifier math (${direction}) ---`);

if (direction === "OVER") {
  let governing, baseline;
  if (seasonAvg != null && l5Avg != null) {
    if (isPlayoffL5) {
      governing = "L5_playoff_override";
      baseline = l5Avg;
    } else {
      governing = Math.abs(seasonAvg - l5Avg) >= 3 ? "L5" : "season";
      baseline = governing === "L5" ? l5Avg : seasonAvg;
    }
  } else if (seasonAvg != null) {
    governing = "season"; baseline = seasonAvg;
  } else if (l5Avg != null) {
    governing = "L5"; baseline = l5Avg;
  } else {
    governing = "(none)"; baseline = null;
  }

  const isPoints = POINTS_CONTAINING.has(statType);
  const roadDed = (home === "away" && isPoints) ? scale.road_deduction_pts : 0;
  // v3.5: outlier-window widens to 2.5, variance addendum picks the larger
  // of (outlier base, 1.5 + 0.25 × (σ − threshold)). Poor-FT shooters stack +2.
  const outlierActive = !!gt?.l5?.weighted?.outlier_present;
  const outlierBase = outlierActive ? 2.5 : scale.over_buffer_base;
  const sigma = gt?.variance?.ppg_stddev ?? null;
  const varianceBuffer = (sigma != null && isPoints && sigma > scale.variance_threshold_ppg)
    ? 1.5 + 0.25 * (sigma - scale.variance_threshold_ppg) : null;
  const baseBuffer = varianceBuffer != null ? Math.max(outlierBase, varianceBuffer) : outlierBase;
  const ftPct = gt.season?.averages?.ft_pct ?? null;
  const poorFt = (ftPct != null && ftPct < 0.70 && isPoints);
  const buffer = baseBuffer + (poorFt ? 2 : 0);

  if (baseline != null) {
    const adjusted = baseline - roadDed;
    const required = adjusted - buffer;
    const passes = line <= required;
    console.log(`  governing baseline: ${governing} = ${fmt(baseline)}`);
    console.log(`  road deduction:     ${roadDed > 0 ? `-${roadDed}` : "0"}   (${isPlayoffGame ? "playoff" : "reg"}, points-containing=${isPoints}, home_away=${home})`);
    console.log(`  OVER buffer:        ${buffer}   (base ${baseBuffer}${poorFt ? ` + 2 poor-FT, ft_pct=${(ftPct*100).toFixed(0)}%` : ""})`);
    console.log(`  adjusted baseline:  ${fmt(adjusted)}   (baseline − road)`);
    console.log(`  required: line ≤   ${fmt(required)}   (adjusted − buffer)`);
    console.log(`  this line:         ${line}`);
    console.log(`  BUFFER ${passes ? "PASSES ✓" : "FAILS ✗"}  — ${passes ? `${line} ≤ ${fmt(required)}` : `${line} > ${fmt(required)}`}`);
  } else {
    console.log(`  (no baseline available — missing_baseline SKIP)`);
  }
}

if (direction === "UNDER" && FT_FLOOR_PROPS.has(statType)) {
  // Rule 5i FT-floor: source depends on playoff-L5 override
  let fta, ftPct, source;
  if (isPlayoffL5 && gt.l5?.averages?.fta != null && gt.l5?.averages?.ft_pct != null) {
    fta = gt.l5.averages.fta; ftPct = gt.l5.averages.ft_pct; source = "l5_playoff";
  } else {
    fta = gt.season?.averages?.fta ?? null; ftPct = gt.season?.averages?.ft_pct ?? null; source = "season";
  }
  console.log(`  Rule 5i FT-floor (UNDER on ${statType}):`);
  if (fta == null || ftPct == null) {
    console.log(`    fta/ft_pct missing — check not run`);
  } else if (fta < scale.ft_floor_gate_fta) {
    console.log(`    fta=${fmt(fta)} < gate ${scale.ft_floor_gate_fta} — check not run`);
  } else {
    // v3.5 per-position FG floor: read from groundTruth.derived.ft_floor_baseline
    // if the composer plumbed it; otherwise default to F via ftFloorBaseline().
    const fgFloor = gt?.derived?.ft_floor_baseline ?? ftFloorBaseline(gt?.league, null);
    let ftFloorPts = fta * ftPct;
    const restriction = gt?.minutes_restriction ?? null;
    const mechThresh = Math.floor(scale.game_minutes * 30 / 48);
    const mechScaler = Math.floor(scale.game_minutes * 32 / 48);
    if (restriction != null && Number.isFinite(restriction) && restriction < mechThresh) {
      ftFloorPts = ftFloorPts * (restriction / mechScaler);
      source = `${source}+mech1(R=${restriction})`;
    }
    const totalFloor = ftFloorPts + fgFloor;
    const invalid = totalFloor >= line;
    console.log(`    source=${source}, fta=${fmt(fta)}, ft_pct=${(ftPct*100).toFixed(1)}%, fg_floor=${fgFloor}`);
    console.log(`    ft_floor_pts = ${fmt(ftFloorPts)}   total_floor = ${fmt(totalFloor)}   line = ${line}`);
    console.log(`    UNDER ${invalid ? "INVALID ✗ (floor ≥ line)" : "valid ✓"}`);
  }
}

if (ASSIST_CONTAINING.has(statType)) {
  const wp = gt.win_prob?.player_team_pct;
  if (wp != null) {
    const band = isPlayoffGame ? { lo: 0.45, hi: 0.70 } : { lo: 0.40, hi: 0.75 };
    const inBand = wp >= band.lo && wp <= band.hi;
    console.log(`  R9 assist win-prob gate (${isPlayoffGame ? "playoff" : "reg"}):`);
    console.log(`    band [${band.lo.toFixed(2)}, ${band.hi.toFixed(2)}]   wp=${wp.toFixed(3)}   ${inBand ? "INSIDE ✓" : "OUTSIDE ✗ (forces SKIP)"}`);
  }
}

// ─── Opponent / defender context (qualitative, but visible inputs) ────────

console.log(`\n--- Opponent / matchup ---`);
const od = gt.opponent_defense;
if (od) {
  console.log(`  def_rank: ${od.def_rank ?? "?"} / 30   def_rating: ${fmt(od.def_rating)}   (source=${od.source ?? "?"})`);
  const pd = od.primary_defender;
  if (pd) {
    console.log(`  primary defender: ${pd.player ?? "?"}  share=${pd.share_pct != null ? (pd.share_pct*100).toFixed(0)+"%" : "?"}  confirmed=${pd.confirmed}`);
  }
} else {
  console.log(`  opponent_defense: null`);
}

const allInj = gt.injuries;
if (allInj) {
  const own = (allInj.player_team || []).filter((i) => i.status && /out|gtd|doubtful/i.test(i.status));
  const opp2 = (allInj.opponent || []).filter((i) => i.status && /out|gtd|doubtful/i.test(i.status));
  if (own.length) console.log(`  own team injuries: ${own.map((i) => `${i.player} (${i.status})`).join(", ")}`);
  if (opp2.length) console.log(`  opp injuries:      ${opp2.map((i) => `${i.player} (${i.status})`).join(", ")}`);
}

// ─── Splits (home/away regular season) ────────────────────────────────────

if (field && gt.splits) {
  const homeSplit = gt.splits.home?.[field];
  const roadSplit = gt.splits.road?.[field];
  if (homeSplit != null || roadSplit != null) {
    console.log(`  splits.${field}: home=${fmt(homeSplit)}   road=${fmt(roadSplit)}`);
  }
}

console.log("");

function fmt(v) {
  if (v == null) return "null";
  if (typeof v === "number") return v.toFixed(2);
  return String(v);
}
