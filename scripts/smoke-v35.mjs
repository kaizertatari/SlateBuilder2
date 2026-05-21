// v3.5 framework smoke — synthetic groundTruth blocks exercise:
//   1. Weighted L5 computation (regular + playoff_series + playoff_raw_fallback)
//   2. Rule 5a variance-adjusted OVER buffer
//   3. Post-outlier window buffer widening
//   4. Rule 5i positional FT floor (G/F/C lookup)
//   5. Rule 5i Mechanism-1 minutes-restriction override
//   6. composeGroundTruth attaches l5.weighted + variance + derived
//
// No network. No LLM. Pure-function checks against the v3.5 module set.
//
// Run: node scripts/smoke-v35.mjs

import { computeWeightedL5 } from "../api/lib/weighted-l5.js";
import { preFilterMechanical, verifyVerdict } from "../api/lib/verdict-verifier.js";
import { composeGroundTruth } from "../api/lib/ground-truth.js";
import { FRAMEWORK_SCALING, ftFloorBaseline, getFramework } from "../api/lib/framework.js";

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}
function header(s) { console.log(`\n[${s}]`); }
function approx(a, b, eps = 0.05) { return Math.abs(a - b) <= eps; }

console.log("=== smoke-v35 ===");
console.log(`node ${process.version}`);

// ─── 1. Weighted L5 — regular season, opponent quality ───────────────────
header("1. Weighted L5: regular-season opponent-quality multipliers");
{
  // Newest first. Game 1 (most recent) is vs OKC (def_rank 1 → 1.15 mul),
  // Game 5 (oldest) is vs WAS (assume rank 28 → 0.80 mul). Outliers
  // dampened by hot/cold checks vs season_ppg=20.
  const games = [
    { matchup: "BOS @ OKC", pts: 35, reb: 5, ast: 5, minutes: 36 },  // hot outlier (>1.5x)
    { matchup: "BOS vs DAL", pts: 22, reb: 6, ast: 4, minutes: 35 },
    { matchup: "BOS @ MIA", pts: 18, reb: 4, ast: 5, minutes: 33 },
    { matchup: "BOS vs PHI", pts: 25, reb: 5, ast: 6, minutes: 34 },
    { matchup: "BOS @ WAS", pts: 8, reb: 3, ast: 2, minutes: 22 },   // cold outlier (<0.5x)
  ];
  const defMap = { OKC: 1, DAL: 18, MIA: 10, PHI: 14, WAS: 28 };
  const out = computeWeightedL5({
    games, seasonPpg: 20, ownAbbr: "BOS", series: null, defRankByAbbr: defMap,
  });
  check("returns weighted block", out && out.averages, `mode=${out?.mode}`);
  check("mode is 'regular'", out?.mode === "regular");
  check("outlier_present true (35>30 and 8<10)", out?.outlier_present === true);
  check("weighted ppg defined", typeof out?.averages?.ppg === "number", `ppg=${out?.averages?.ppg}`);
  check("raw_vs_weighted_delta has ppg key", "ppg" in (out?.raw_vs_weighted_delta || {}));
  // Recency weighting (0.30 on newest game) dominates the raw mean, but the
  // 0.60 hot dampener still pulls the result below the pure-recency value
  // — that's the dampener doing its job within an otherwise newest-heavy
  // average.
  const rawPpg = (35 + 22 + 18 + 25 + 8) / 5; // 21.6
  const pureRecencyPpg = 0.30*35 + 0.25*22 + 0.20*18 + 0.15*25 + 0.10*8; // 24.15
  check("dampener pulls weighted below pure-recency value",
    out.averages.ppg < pureRecencyPpg,
    `weighted=${out.averages.ppg} pure-recency=${pureRecencyPpg.toFixed(2)} raw=${rawPpg.toFixed(2)}`);
}

// ─── 2. Weighted L5 — playoff_series mode ────────────────────────────────
header("2. Weighted L5: playoff series-game multipliers");
{
  // All 5 games vs current opponent MIA — oldest-first ordinals 1..5
  // (newest = G5, oldest = G1). Series multipliers: G1=0.75, G2=0.75,
  // G3=1.00, G4=1.00, G5=1.20.
  const games = [
    { matchup: "BOS vs MIA", pts: 30, reb: 6, ast: 5, minutes: 38 }, // G5
    { matchup: "BOS @ MIA", pts: 26, reb: 5, ast: 4, minutes: 37 },  // G4
    { matchup: "BOS vs MIA", pts: 22, reb: 5, ast: 6, minutes: 36 }, // G3
    { matchup: "BOS @ MIA", pts: 20, reb: 6, ast: 5, minutes: 35 },  // G2
    { matchup: "BOS vs MIA", pts: 18, reb: 4, ast: 4, minutes: 34 }, // G1
  ];
  const series = { opponent_abbr: "MIA", games_played: 4, player_team_wins: 2, opponent_wins: 2 };
  const out = computeWeightedL5({
    games, seasonPpg: 24, ownAbbr: "BOS", series, defRankByAbbr: {},
  });
  check("playoff series mode detected", out?.mode === "playoff_series");
  check("weighted ppg defined", typeof out?.averages?.ppg === "number", `ppg=${out?.averages?.ppg}`);
}

// ─── 3. Weighted L5 — playoff_raw_fallback ───────────────────────────────
header("3. Weighted L5: playoff raw fallback when <3 vs current opp");
{
  const games = [
    { matchup: "BOS vs DEN", pts: 22, reb: 4, ast: 5, minutes: 34 },
    { matchup: "BOS @ DEN", pts: 28, reb: 5, ast: 6, minutes: 36 },
    { matchup: "BOS vs DAL", pts: 24, reb: 6, ast: 4, minutes: 35 },
    { matchup: "BOS @ DAL", pts: 20, reb: 5, ast: 5, minutes: 34 },
    { matchup: "BOS vs DAL", pts: 30, reb: 7, ast: 5, minutes: 38 },
  ];
  const series = { opponent_abbr: "MIA", games_played: 0 }; // 0 of 5 vs MIA
  const out = computeWeightedL5({
    games, seasonPpg: 22, ownAbbr: "BOS", series, defRankByAbbr: {},
  });
  check("fallback mode detected", out?.mode === "playoff_raw_fallback");
  // Raw mean ppg = (22+28+24+20+30)/5 = 24.8
  check("returns raw mean ppg≈24.8", approx(out?.averages?.ppg, 24.8, 0.1), `got ${out?.averages?.ppg}`);
}

// ─── 4. Verifier — variance-adjusted OVER buffer ─────────────────────────
header("4. Verifier: variance-adjusted OVER buffer (σ > league threshold)");
{
  // High-variance scorer: σ=8.0, NBA threshold=6 → buffer = 1.5 + 0.25×(8-6) = 2.0
  // baseline ppg=25, no road deduction (home), line=23.0 should clear normal
  // buffer (23 ≤ 25−1.5=23.5 PASS) but fail with widened buffer (23 ≤ 25−2.0=23.0 PASS exactly).
  // Use line=23.1 to fail with widened, pass without.
  const gt = {
    league: "NBA",
    home_away: "home",
    season: { averages: { ppg: 25, ft_pct: 0.85, fta: 4 } },
    l5: { type: "Regular Season", n: 5, averages: { ppg: 25 } },
    variance: { ppg_stddev: 8.0 },
    win_prob: { player_team_pct: 0.55 },
  };
  const pre = preFilterMechanical({ groundTruth: gt, statType: "Points", direction: "OVER", line: 23.1 });
  check("variance widens buffer → 23.1 fails (buffer 2.0)", pre !== null && pre.verdict === "SKIP",
    pre ? pre.flags[0] : "no SKIP");

  const pre2 = preFilterMechanical({ groundTruth: gt, statType: "Points", direction: "OVER", line: 22.9 });
  check("line 22.9 still passes widened buffer", pre2 === null);
}

// ─── 5. Verifier — post-outlier window widens to 2.5pt ───────────────────
header("5. Verifier: post-outlier window widens OVER buffer to 2.5 pts");
{
  // baseline 25, no road dev, line=22.6 → required=25−2.5=22.5; 22.6>22.5 → fail.
  const gt = {
    league: "NBA",
    home_away: "home",
    season: { averages: { ppg: 25, ft_pct: 0.85, fta: 4 } },
    l5: {
      type: "Regular Season", n: 5,
      averages: { ppg: 25 },
      weighted: { averages: { ppg: 25 }, outlier_present: true, mode: "regular" },
    },
    win_prob: { player_team_pct: 0.55 },
  };
  const pre = preFilterMechanical({ groundTruth: gt, statType: "Points", direction: "OVER", line: 22.6 });
  check("outlier widening → 22.6 fails (buffer 2.5)", pre !== null);
  const pre2 = preFilterMechanical({ groundTruth: gt, statType: "Points", direction: "OVER", line: 22.4 });
  check("line 22.4 still passes widened buffer", pre2 === null);
}

// ─── 6. Verifier — positional FT floor (Rule 5i) ─────────────────────────
header("6. Verifier: positional FT floor (Rule 5i Points UNDER)");
{
  // Guard: ft_floor_baseline = 6 (NBA G). fta=8, ft_pct=0.85 → 6.8 FT pts.
  // total_floor = 6.8 + 6 = 12.8. line=12.5 → invalid; line=15 → valid.
  const gtGuard = {
    league: "NBA",
    home_away: "home",
    season: { averages: { ppg: 18, ft_pct: 0.85, fta: 8 } },
    l5: { type: "Regular Season", n: 5, averages: { ppg: 18, fta: 8, ft_pct: 0.85 } },
    derived: { ft_floor_baseline: 6 },
    variance: { ppg_stddev: null },
    win_prob: { player_team_pct: 0.55 },
  };
  const pre = preFilterMechanical({ groundTruth: gtGuard, statType: "Points", direction: "UNDER", line: 12.5 });
  check("guard FT-floor 12.8 ≥ line 12.5 → invalid UNDER", pre !== null);
  const pre2 = preFilterMechanical({ groundTruth: gtGuard, statType: "Points", direction: "UNDER", line: 16 });
  check("guard line 16 → FT floor passes (no rule_5i violation)", pre2 === null ||
    !(pre2.override_reasons || []).includes("rule_5i_ft_floor_violation"));

  // Center: ft_floor_baseline = 10. Same fta/ft_pct → 6.8 + 10 = 16.8.
  const gtCenter = { ...gtGuard, derived: { ft_floor_baseline: 10 } };
  const preC = preFilterMechanical({ groundTruth: gtCenter, statType: "Points", direction: "UNDER", line: 16 });
  check("center FT-floor 16.8 ≥ line 16 → invalid UNDER", preC !== null,
    preC?.flags?.[0]);
}

// ─── 7. Verifier — Mechanism 1 minutes-restriction override ──────────────
header("7. Verifier: Mechanism 1 minutes-restriction override (5i scaling)");
{
  // Same big-fta scoring guard. Without restriction: total_floor 12.8.
  // With R=20 (<30 NBA threshold), ft_floor scales × 20/32 = 0.625, so
  // ft_floor_pts=6.8×0.625≈4.25 → total_floor ≈ 10.25 < line 12 → valid.
  const gt = {
    league: "NBA",
    home_away: "home",
    season: { averages: { ppg: 18, ft_pct: 0.85, fta: 8 } },
    l5: { type: "Regular Season", n: 5, averages: { ppg: 18 } },
    derived: { ft_floor_baseline: 6 },
    minutes_restriction: 20,
    variance: { ppg_stddev: null },
    win_prob: { player_team_pct: 0.55 },
  };
  const pre = preFilterMechanical({ groundTruth: gt, statType: "Points", direction: "UNDER", line: 12 });
  check("Mech-1 override scales floor below line 12", pre === null);
}

// ─── 8. ftFloorBaseline league lookup ────────────────────────────────────
header("8. ftFloorBaseline lookup");
{
  check("NBA G = 6", ftFloorBaseline("NBA", "G") === 6);
  check("NBA F = 8", ftFloorBaseline("NBA", "F") === 8);
  check("NBA C = 10", ftFloorBaseline("NBA", "C") === 10);
  check("WNBA G = 4", ftFloorBaseline("WNBA", "G") === 4);
  check("WNBA F = 6", ftFloorBaseline("WNBA", "F") === 6);
  check("WNBA C = 8", ftFloorBaseline("WNBA", "C") === 8);
  check("unknown position → F fallback (NBA → 8)", ftFloorBaseline("NBA", null) === 8);
  check("unknown league → NBA default", ftFloorBaseline("XYZ", "F") === 8);
}

// ─── 9. Framework body sanity ────────────────────────────────────────────
header("9. Framework body contents");
{
  const nba = getFramework("NBA");
  const wnba = getFramework("WNBA");
  check("NBA body labels v3.5", nba.includes("PRIZEPICKS MODEL v3.5"));
  check("WNBA body labels v3.5", wnba.includes("PRIZEPICKS MODEL v3.5"));
  check("body mentions weighted L5", nba.includes("WEIGHTED L5"));
  check("body mentions variance-adjusted addendum", nba.includes("VARIANCE-ADJUSTED ADDENDUM"));
  check("body mentions pre-tip blowout override", nba.includes("PRE-TIP BLOWOUT-PROJECTION OVERRIDE"));
  check("body mentions per-position FT floor", nba.includes("G=6, F=8, C=10"));
  check("WNBA body has correct positional FT floor", wnba.includes("G=4, F=6, C=8"));
  check("body mentions Game 1 UNDER Mechanism 1 exception",
    nba.includes("Mechanism 1") && nba.includes("EXCEPTION"));
}

// ─── 10. composeGroundTruth integration ──────────────────────────────────
header("10. composeGroundTruth wires l5.weighted + variance + derived");
{
  const fakeL5 = {
    season_type: "Regular Season",
    n: 5,
    games: [
      { matchup: "BOS @ MIA", pts: 28, reb: 6, ast: 5, fgm: 10, fga: 18, ftm: 6, fta: 7, minutes: 36 },
      { matchup: "BOS vs PHI", pts: 25, reb: 5, ast: 4, fgm: 9, fga: 17, ftm: 5, fta: 6, minutes: 35 },
      { matchup: "BOS @ DET", pts: 22, reb: 7, ast: 5, fgm: 8, fga: 16, ftm: 5, fta: 6, minutes: 34 },
      { matchup: "BOS vs NYK", pts: 30, reb: 8, ast: 6, fgm: 11, fga: 20, ftm: 6, fta: 8, minutes: 37 },
      { matchup: "BOS @ TOR", pts: 18, reb: 5, ast: 4, fgm: 7, fga: 18, ftm: 4, fta: 5, minutes: 33 },
    ],
    averages: { ppg: 24.6, rpg: 6.2, apg: 4.8, fgm: 9, fga: 17.8, ftm: 5.2, fta: 6.4, ft_pct: 0.8125, minutes: 35 },
  };
  const fakeGame = {
    date: "2026-05-20",
    state: "STATUS_SCHEDULED",
    home: { team_id: "1", abbr: "BOS", name: "Celtics" },
    away: { team_id: "2", abbr: "MIA", name: "Heat" },
  };
  const result = composeGroundTruth({
    player: "Test Player",
    propType: "Points OVER",
    line: 24.5,
    league: "NBA",
    info: { team_abbr: "BOS", position: "Guard", full_name: "Test Player" },
    game: fakeGame,
    daysOut: 0,
    seasonType: "Regular Season",
    seasonAvg: { season: "2025-26", season_type: "Regular Season", ppg: 24.0, rpg: 6.0, apg: 4.5, fga: 17, ft_pct: 0.81, fta: 6 },
    l5: fakeL5,
    splits: null,
    winProb: { home_win_pct: 0.6, away_win_pct: 0.4, source: "test" },
    allInjuries: [],
    opponentDefense: { def_rating: 110, def_rank: 8, source: "test" },
    primaryDefender: null,
    defRankByAbbr: { OKC: 1, MIA: 8, PHI: 12, DET: 22, NYK: 16, TOR: 24 },
  });
  const gt = result.groundTruth;
  check("composeGroundTruth returns groundTruth", gt && typeof gt === "object");
  check("l5.weighted populated", gt.l5?.weighted && gt.l5.weighted.averages);
  check("l5.weighted has raw_vs_weighted_delta", "raw_vs_weighted_delta" in (gt.l5?.weighted || {}));
  check("variance block present", gt.variance && "ppg_stddev" in gt.variance,
    `ppg_stddev=${gt.variance?.ppg_stddev}`);
  check("derived.ft_floor_baseline set from position", gt.derived?.ft_floor_baseline === 6,
    `got ${gt.derived?.ft_floor_baseline}`);
  check("series merged with opponent_abbr (regular season → null)", gt.series === null);
}

// ─── 11. WNBA variant ────────────────────────────────────────────────────
header("11. WNBA variant scaling honored");
{
  const wnba = FRAMEWORK_SCALING.WNBA;
  check("WNBA road_deduction_pts = 1.2", wnba.road_deduction_pts === 1.2);
  check("WNBA variance_threshold = 5", wnba.variance_threshold_ppg === 5);
  check("WNBA ft_floor G=4, F=6, C=8",
    wnba.ft_floor_by_position.G === 4 && wnba.ft_floor_by_position.F === 6 && wnba.ft_floor_by_position.C === 8);
  check("WNBA game_minutes = 40", wnba.game_minutes === 40);

  const gtWnba = {
    league: "WNBA",
    home_away: "away",
    season: { averages: { ppg: 22, ft_pct: 0.85, fta: 6 } },
    l5: { type: "Regular Season", n: 5, averages: { ppg: 22 } },
    variance: { ppg_stddev: null },
    derived: { ft_floor_baseline: 6 },
    win_prob: { player_team_pct: 0.55 },
  };
  // baseline 22 − road 1.2 = 20.8; buffer 1.5 → required ≤ 19.3.
  const pre = preFilterMechanical({ groundTruth: gtWnba, statType: "Points", direction: "OVER", line: 19.5 });
  check("WNBA road deduction 1.2 applied (line 19.5 > 19.3 fails)", pre !== null);
  const pre2 = preFilterMechanical({ groundTruth: gtWnba, statType: "Points", direction: "OVER", line: 19.0 });
  check("WNBA line 19.0 passes", pre2 === null);
}

console.log(`\n=== Verdict ===`);
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
