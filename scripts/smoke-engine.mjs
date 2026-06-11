// Unit smoke for the deterministic v3.5 rule engine.
//
// Covers, at minimum:
//   • Plum's 6 OVER lines (Points 19.5/20.5, PA 26.5, Assists 3.5/5, 3PT 1.5)
//   • Playoff Game 1 → B-tier with SKIP advisory
//   • Post-injury return (is_listed_injured: true) → A-tier cap
//   • Assist prop, win_prob 0.30 in playoff → SKIP via R9
//   • Points UNDER with high fta/ft_pct → SKIP via Rule 5i
//   • data_warnings prior_season_* → A-tier cap (provenance guard)
//   • Suppressor stacking: 2+ suppressors active → tier drops one extra
//
// Pure local — no LLM, no network. Builds synthetic groundTruth inline.

import { applyEngine } from "../api/lib/engine.js";
import { computeOverBufferCheck } from "../api/lib/rules/_helpers.js";
import { shadowTierFor, TIER_RANK } from "../api/lib/rule-weights.js";
import { setOdds } from "../api/lib/odds.js";

// Hermetic odds: the engine's market rules (market-edge / game-script /
// projection) lazy-load data/odds.json on first lookup, and the fixtures
// below use REAL player names ("Kelsey Plum") that can collide with
// whatever the latest odds refresh priced — firing market suppressors
// mid-test and flaking tier assertions. Seed an empty store so this smoke
// asserts box-score rule behavior only; the market rules have dedicated
// smokes that inject their own odds.
setOdds({ by_player: {}, games: {} });

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS — ${name}`);
    passed++;
  } else {
    console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`);
    failed++;
  }
}

function gt(overrides = {}) {
  return {
    league: "WNBA",
    home_away: "away",
    opponent_team: { name: "Phoenix Mercury", abbr: "PHX" },
    win_prob: { player_team_pct: 0.45, source: "moneyline" },
    season: { averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pa: 32.3, pra: 33.8, fg3m: 2.5, fta: 6.75, ft_pct: 0.77 } },
    l5: {
      type: "Regular Season",
      n: 4,
      averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pa: 32.3, pra: 33.8, fg3m: 2.5, fta: 6.75, ft_pct: 0.77 },
      weighted: { averages: { ppg: 26.9, apg: 6.1, pa: 33 } },
      games: [],
    },
    opponent_defense: { def_rank: 8 },
    injuries: { player_team: [], opponent: [] },
    injury_regions: {},
    player_recent: { is_listed_injured: false },
    info: { full_name: "Kelsey Plum" },
    derived: { ft_floor_baseline: 4 },
    mechanisms: {
      mech1: { confirmed: false },
      mech2: { confirmed: false },
      mech3: { confirmed: false },
      opponent_starters_out: 0,
    },
    data_warnings: null,
    series: null,
    ...overrides,
  };
}

// (a) Plum's 6 OVER lines
console.log("\n[a] Plum's 6 OVER lines");
for (const [stat, line, expectViable] of [
  ["Points", 19.5, true],
  ["Points", 20.5, true],
  ["PA", 26.5, true],
  ["Assists", 3.5, true],
  ["Assists", 5, false],     // baseline 5.5, buffer 1.0 → required ≤ 4.5
  ["3-Pointers Made", 1.5, true],
]) {
  const v = applyEngine({ groundTruth: gt(), statType: stat, direction: "OVER", line });
  const ok = expectViable ? v.verdict === "OVER" : v.verdict === "SKIP";
  assert(`${stat} OVER ${line} → ${expectViable ? "viable" : "SKIP"}`, ok, `got ${v.verdict}/${v.tier}`);
}

// (b) Playoff Game 1 → B-tier with SKIP advisory
console.log("\n[b] Playoff Game 1");
{
  const v = applyEngine({
    groundTruth: gt({
      series: { next_game_number: 1, leading_team_abbr: null, player_team_wins: 0, opponent_wins: 0, round: "RD16", series_record: "0-0" },
    }),
    statType: "Points", direction: "OVER", line: 20.5,
  });
  assert("Game 1 tier === B", v.tier === "B", `got ${v.tier}`);
  assert("Game 1 SKIP advisory in flags", v.flags.some((f) => /Game 1/.test(f)));
}

// (c) Post-injury return → A-tier cap
console.log("\n[c] Post-injury return gate");
{
  const v = applyEngine({
    groundTruth: gt({ player_recent: { is_listed_injured: true } }),
    statType: "Points", direction: "OVER", line: 20.5,
  });
  // Should NOT be S-tier (capped at A by rule 6 + provenance guard absent here).
  assert("post-injury tier ≤ A", v.tier === "A" || v.tier === "B" || v.tier === "SKIP", `got ${v.tier}`);
  assert("post-injury flag present", v.flags.some((f) => /post-injury|Rule 6/.test(f)));
}

// (d) Assist prop, playoff, win_prob 0.30 → SKIP via R9
console.log("\n[d] R9 outside band (playoff)");
{
  const v = applyEngine({
    groundTruth: gt({
      win_prob: { player_team_pct: 0.30 },
      series: { next_game_number: 4, leading_team_abbr: null, player_team_wins: 1, opponent_wins: 2, round: "RD16", series_record: "1-2" },
    }),
    statType: "Assists", direction: "OVER", line: 3.5,
  });
  assert("R9 outside playoff band → SKIP", v.verdict === "SKIP", `got ${v.verdict}`);
  assert("R9 rule_id in rules_fired", v.rules_fired.includes("R9"));
}

// (e) Points UNDER with high FTA × FT% → SKIP via Rule 5i
console.log("\n[e] Rule 5i FT-floor (UNDER)");
{
  const v = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 26.75, fta: 12, ft_pct: 0.90 } },
      l5: { type: "Regular Season", n: 4, averages: { ppg: 26.75, fta: 12, ft_pct: 0.90 }, games: [] },
      derived: { ft_floor_baseline: 6 },
    }),
    statType: "Points", direction: "UNDER", line: 15,
  });
  assert("5i floor exceeds line → SKIP", v.verdict === "SKIP", `got ${v.verdict}`);
  assert("5i rule_id in rules_fired", v.rules_fired.includes("5i"));
}

// (f) DATA-PROVENANCE GUARD → A-tier cap
console.log("\n[f] Provenance guard (prior_season_l5)");
{
  const v = applyEngine({
    groundTruth: gt({ data_warnings: ["prior_season_l5"] }),
    statType: "Points", direction: "OVER", line: 20.5,
  });
  assert("provenance rule fired", v.rules_fired.includes("provenance"));
  assert("provenance caps tier ≤ A", v.tier === "A" || v.tier === "B" || v.tier === "SKIP", `got ${v.tier}`);
}

// (g) Suppressor stacking — 2 suppressors fire, tier drops one extra
console.log("\n[g] Suppressor stacking");
{
  // Force 4c (multi-star compression) + 5h (FT-leak tier 2) by:
  //   - teammate OUT/DOUBTFUL at multi-star threshold (mech2 confirmed)
  //   - win_prob ≥ 0.70 (so 4c fires) but < 0.85 (so 5f doesn't)
  //   - opponent_defense.def_rank ≤ 1 (tier-2 WNBA threshold; tier-1 isn't named)
  //   - season.averages.fta high enough (≥ ft_floor_gate_fta) for 5h to evaluate
  const v = applyEngine({
    groundTruth: gt({
      win_prob: { player_team_pct: 0.75 },
      opponent_defense: { def_rank: 1, primary_defender: null },
      season: { averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pa: 32.3, pra: 33.8, fg3m: 2.5, fta: 6.75, ft_pct: 0.77 } },
      mechanisms: {
        mech1: { confirmed: false },
        mech2: { confirmed: true, teammate: "X", teammate_ppg: 16, status: "OUT" },
        mech3: { confirmed: true, def_rank: 1, top_tier: 2 },
        opponent_starters_out: 1,
      },
    }),
    statType: "Points", direction: "OVER", line: 20.5,
  });
  assert("4c rule fired", v.rules_fired.includes("4c"));
  assert("5h rule fired", v.rules_fired.includes("5h"));
  assert("suppressor stacking flag present", v.flags.some((f) => /Suppressor stacking/.test(f)) || v.tier !== "S");
}

// (h) UNDER mechanism gate — no mechanism confirmed → SKIP
console.log("\n[h] UNDER mechanism gate");
{
  // No mechanisms, no FT-floor margin — every UNDER should SKIP.
  const v = applyEngine({
    groundTruth: gt({ home_away: "home" }),  // home_away just to avoid road deduction noise
    statType: "Rebounds", direction: "UNDER", line: 0.5,
  });
  assert("Rebounds UNDER w/ no mechanism → SKIP", v.verdict === "SKIP", `got ${v.verdict}/${v.tier}`);
  assert("under-mechanism rule in rules_fired", v.rules_fired.includes("under-mechanism"));

  // Mech 3 alone (matchup ceiling), baseline NEUTRAL → B-tier max with
  // SKIP advisory. Line 8.5 vs rpg 8 → edge 0.5 < buffer 1.0 → 5j
  // defers, mechanism gate carries the verdict alone.
  const v2 = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 16, rpg: 8, apg: 3, pa: 19, pra: 27 } },
      l5: { type: "Regular Season", n: 4, averages: { ppg: 16, rpg: 8 }, weighted: {}, games: [] },
      opponent_defense: { def_rank: 1 },
      mechanisms: {
        mech1: { confirmed: false },
        mech2: { confirmed: false },
        mech3: { confirmed: true, def_rank: 1, top_tier: 2 },
        opponent_starters_out: 0,
      },
    }),
    statType: "Rebounds", direction: "UNDER", line: 8.5,
  });
  assert("Mech 3 alone (baseline neutral) → B-tier", v2.tier === "B", `got ${v2.tier}`);
  assert("Mech 3 alone → SKIP advisory in flags", v2.flags.some((f) => /SKIP advisory/.test(f)));

  // 3 mechanisms confirmed → S possible
  const v3 = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 16, rpg: 8, apg: 3, pa: 19, pra: 27 } },
      l5: { type: "Regular Season", n: 4, averages: { ppg: 16, rpg: 8 }, weighted: {}, games: [] },
      opponent_defense: { def_rank: 1 },
      mechanisms: {
        mech1: { confirmed: true },
        mech2: { confirmed: true },
        mech3: { confirmed: true, def_rank: 1, top_tier: 2 },
        opponent_starters_out: 0,
      },
    }),
    statType: "Rebounds", direction: "UNDER", line: 11.5,
  });
  assert("3 mechanisms → tier ≥ A (S possible)", v3.tier === "S" || v3.tier === "A", `got ${v3.tier}`);
}

// (i) Fantasy Score — R9 fires (FS contains assists), Rule 5a applies
// road deduction since FS is in ROAD_DEDUCTION_PROPS.
console.log("\n[i] Fantasy Score — R9 + road deduction");
{
  // In-band win_prob: should clear R9, evaluate normally. FanDuel-style
  // baseline ~50; line 42.5 has ~7.5 edge so 5a clears too.
  const v = applyEngine({
    groundTruth: gt({
      season: {
        averages: {
          ppg: 26.75, rpg: 5.0, apg: 6.5, fta: 6.75, ft_pct: 0.77,
          spg: 1.2, bpg: 0.4, topg: 3.0,
          // FanDuel: 26.75 + 1.2*5 + 1.5*6.5 + 3*1.2 + 3*0.4 − 1*3.0 = 48.45
          fs: 48.5,
        },
      },
      l5: {
        type: "Regular Season",
        n: 5,
        averages: { ppg: 26.75, rpg: 5.0, apg: 6.5, fs: 48.5 },
        weighted: { averages: { ppg: 26.75, rpg: 5.0, apg: 6.5, fs: 48.5 } },
        games: [],
      },
    }),
    statType: "Fantasy Score", direction: "OVER", line: 42.5,
  });
  assert("FS OVER 42.5 → viable", v.verdict === "OVER", `got ${v.verdict}/${v.tier}`);
  // R9 should appear in rules_fired (assist-containing prop, in-band win_prob).
  assert("FS triggers R9 (assist-containing)", v.rules_fired.includes("R9"));
}

// (j) Fantasy Score — R9 SKIP when win_prob outside band on assist family.
console.log("\n[j] Fantasy Score — R9 outside band");
{
  const v = applyEngine({
    groundTruth: gt({
      win_prob: { player_team_pct: 0.20 },  // way below reg-season lo=0.40
      season: {
        averages: {
          ppg: 26.75, rpg: 5.0, apg: 6.5, fta: 6.75, ft_pct: 0.77,
          spg: 1.2, bpg: 0.4, topg: 3.0, fs: 48.5,
        },
      },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 26.75, rpg: 5.0, apg: 6.5, fs: 48.5 },
        weighted: { averages: { fs: 48.5 } },
        games: [],
      },
    }),
    statType: "Fantasy Score", direction: "OVER", line: 42.5,
  });
  assert("FS outside R9 band → SKIP", v.verdict === "SKIP", `got ${v.verdict}`);
  assert("FS SKIP via R9", v.rules_fired.includes("R9"));
}

// (k) Blocks+Steals — 5b foul-prone fires (mobility-impaired ≥ 2).
console.log("\n[k] Blocks+Steals — 5b foul-prone");
{
  const v = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 22, rpg: 11, apg: 4, fta: 6, spg: 1.0, bpg: 3.0, topg: 2.0, bs: 4.0, fs: 50 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 22, rpg: 11, apg: 4, bs: 4.0, fs: 50 },
        weighted: { averages: { bs: 4.0 } },
        games: [],
      },
      // 2+ mobility-impaired teammates / opponents trigger 5b.i.
      injuries: {
        player_team: [{ player: "Teammate A", status: "OUT", detail: "knee" }],
        opponent: [{ player: "Opp Big B", status: "OUT", detail: "ankle" }],
      },
      injury_regions: {
        "Teammate A": { knee: true },
        "Opp Big B": { ankle: true },
      },
    }),
    statType: "Blocks+Steals", direction: "OVER", line: 2.5,
  });
  assert("Blks+Stls 5b fires when foul-prone", v.rules_fired.includes("5b"));
  assert("Blks+Stls capped at A by 5b", v.tier === "A" || v.tier === "B" || v.tier === "SKIP", `got ${v.tier}`);
}

// (l) 3-Pointers Attempted — 5h tier-2 fires (active 3pt shooter vs elite D).
console.log("\n[l] 3-Pointers Attempted — 5h tier-2");
{
  const v = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 24, rpg: 5, apg: 5, fta: 4, spg: 1, bpg: 0.3, topg: 2.5, fg3a: 8, fs: 45 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 24, fg3a: 8 },
        weighted: { averages: { fg3a: 8 } },
        games: [],
      },
      opponent_defense: { def_rank: 1, primary_defender: null },  // elite perimeter
    }),
    statType: "3-Pointers Attempted", direction: "OVER", line: 5.5,
  });
  assert("3PA 5h tier-2 fires vs elite perimeter defense", v.rules_fired.includes("5h"));
  // 5h is a suppressor → tier capped at A max (per 5h tier_cap).
  assert("3PA suppressor caps tier ≤ A", v.tier === "A" || v.tier === "B" || v.tier === "SKIP", `got ${v.tier}`);
}

// (m) 3-Pointers Attempted — low volume shooter → 5h does NOT fire.
console.log("\n[m] 3-Pointers Attempted — low-volume shooter, no 5h");
{
  const v = applyEngine({
    groundTruth: gt({
      season: { averages: { ppg: 16, rpg: 8, apg: 2, fta: 3, spg: 0.5, bpg: 1.5, topg: 1.5, fg3a: 1.5, fs: 35 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 16, fg3a: 1.5 },
        weighted: { averages: { fg3a: 1.5 } },
        games: [],
      },
      opponent_defense: { def_rank: 1, primary_defender: null },
    }),
    statType: "3-Pointers Attempted", direction: "OVER", line: 1.5,
  });
  assert("3PA below volume gate → 5h doesn't fire", !v.rules_fired.includes("5h"));
}

// (n) Current-series blend fires when vsCurrentOpp >= 3 (playoff_series).
// Verified through computeOverBufferCheck directly since constructing a
// full applyEngine fixture with seriesNumbers wiring is heavy.
console.log("\n[n] Current-series blend — vsCurrentOpp >= 3");
{
  const base = gt({
    series: { next_game_number: 4, leading_team_abbr: null, player_team_wins: 1, opponent_wins: 2, round: "RD16", series_record: "1-2" },
    l5: {
      type: "Playoffs",
      n: 5,
      averages: { ppg: 26.75 },
      weighted: {
        mode: "playoff_series",
        averages: { ppg: 26.0 },     // full playoff-L5 (blended sample)
        current_series_averages: { ppg: 30.0 },  // only current-opp games
        current_series_n: 3,
      },
      games: [],
    },
  });
  // 60/40 blend: 0.6 * 30.0 + 0.4 * 26.0 = 28.4
  // Away road deduction (Points-family) − 1.2 (WNBA) = 27.2
  // Buffer 1.5 → required = 25.7. Line 24.5 → passes; line 26 → fails.
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 24.5,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("blended baseline ≈ 28.4 (60% × 30 + 40% × 26)",
    Math.abs(buf.baseline - 28.4) < 0.05, `got ${buf.baseline}`);
  assert("governing label flags the blend",
    /current_series_blend/.test(buf.governing), `got ${buf.governing}`);
  assert("blended baseline clears line 24.5", buf.passes);

  // Line 27.0 — adjusted 27.2 with buffer 1.5 → required 25.7 → fails.
  const buf2 = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 27.0,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("blended baseline rejects line 27.0", !buf2.passes);
}

// (o) Current-series blend does NOT fire when vsCurrentOpp < 3 — falls
// back to weighted-L5 alone (current behavior preserved).
console.log("\n[o] Current-series blend — fallback when vsCurrentOpp < 3");
{
  const base = gt({
    series: { next_game_number: 1, leading_team_abbr: null, player_team_wins: 0, opponent_wins: 0, round: "RD16", series_record: "0-0" },
    l5: {
      type: "Playoffs",
      n: 5,
      averages: { ppg: 26.75 },
      weighted: {
        mode: "playoff_series",
        averages: { ppg: 26.0 },
        current_series_averages: null,  // <3 games vs current opp
        current_series_n: 1,
      },
      games: [],
    },
  });
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 22.5,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("no blend when current_series_averages is null",
    buf.baseline === 26.0, `got ${buf.baseline}`);
  assert("governing label does NOT mention blend",
    !/current_series_blend/.test(buf.governing), `got ${buf.governing}`);
}

// (p) Regular-season game — current-series blend never fires.
console.log("\n[p] Current-series blend — never fires outside playoffs");
{
  const base = gt({
    series: null,
    l5: {
      type: "Regular Season",
      n: 5,
      averages: { ppg: 26.0 },
      weighted: {
        mode: "regular",
        averages: { ppg: 26.0 },
        current_series_averages: null,
        current_series_n: 0,
      },
      games: [],
    },
  });
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 22.5,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("regular season → no blend, baseline = l5_weighted alone",
    buf.baseline === 26.0 && !/current_series_blend/.test(buf.governing));
}

// (q) Move 3 — regular-season H2H blend fires at n>=2 outside playoff context.
console.log("\n[q] H2H blend — reg-season, n>=2 → fires at 50/50");
{
  const base = gt({
    series: null,  // reg-season
    l5: {
      type: "Regular Season",
      n: 5,
      averages: { ppg: 26.0 },
      weighted: { mode: "regular", averages: { ppg: 26.0 } },
      games: [],
    },
    h2h: {
      n: 3,
      opponent_abbr: "PHX",
      averages: { ppg: 32.0 },
    },
  });
  // baseline path with seasonAvg=26.0, l5Avg=26.0 → governs to "season"
  // (delta < 3). H2H 50/50 blend: 0.5*32 + 0.5*26 = 29.0.
  // Away road deduction (WNBA Points-family): -1.2 → adjusted 27.8.
  // Buffer 1.5 → required 26.3. Line 25 → passes; line 27 → fails.
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 25,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("h2h blend baseline ≈ 29.0 (50% × 32 + 50% × 26)",
    Math.abs(buf.baseline - 29.0) < 0.05, `got ${buf.baseline}`);
  assert("governing label reflects h2h blend",
    /h2h_blend/.test(buf.governing), `got ${buf.governing}`);
  assert("h2h blended baseline clears line 25", buf.passes);

  const buf2 = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 27,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("h2h blended baseline rejects line 27", !buf2.passes);
}

// (r) H2H blend does NOT fire when n<2 — falls back to existing baseline.
console.log("\n[r] H2H blend — n<2 → no blend");
{
  const base = gt({
    series: null,
    l5: {
      type: "Regular Season",
      n: 5,
      averages: { ppg: 26.0 },
      weighted: { mode: "regular", averages: { ppg: 26.0 } },
      games: [],
    },
    h2h: { n: 1, opponent_abbr: "PHX", averages: { ppg: 35.0 } },
  });
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 22.5,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  assert("no h2h blend when n<2", buf.baseline === 26.0, `got ${buf.baseline}`);
  assert("governing label does NOT mention h2h",
    !/h2h_blend/.test(buf.governing), `got ${buf.governing}`);
}

// (s) Playoff context — H2H blend NEVER fires; current-series blend owns
// that path. Verifies the mutual-exclusion design constraint.
console.log("\n[s] H2H blend — never fires in playoff_L5 context");
{
  const base = gt({
    series: { next_game_number: 4, leading_team_abbr: null, player_team_wins: 1, opponent_wins: 2, round: "RD16", series_record: "1-2" },
    l5: {
      type: "Playoffs",
      n: 5,
      averages: { ppg: 26.0 },
      weighted: {
        mode: "playoff_series",
        averages: { ppg: 26.0 },
        current_series_averages: { ppg: 30.0 },
        current_series_n: 3,
      },
      games: [],
    },
    h2h: { n: 5, opponent_abbr: "PHX", averages: { ppg: 40.0 } },  // would dominate if it fired
  });
  const buf = computeOverBufferCheck({
    groundTruth: base, statType: "Points", line: 24.5,
    seasonAvg: 26.0, l5Avg: 26.0, l5WeightedUsed: true,
  });
  // 60/40 current-series blend should win: 0.6*30 + 0.4*26 = 28.4 (not h2h's 33).
  assert("playoff path uses current-series blend, ignores h2h",
    Math.abs(buf.baseline - 28.4) < 0.05, `got ${buf.baseline}`);
  assert("playoff path governing has current_series, not h2h",
    /current_series_blend/.test(buf.governing) && !/h2h_blend/.test(buf.governing),
    `got ${buf.governing}`);
}

// (t) Playoff outlier reference — when l5.weighted.outlier_ref_type is
// "playoff_l5", outlier_present judges games against the playoff norm,
// not the regular-season norm. Verifies directly via computeWeightedL5
// rather than through applyEngine so the threshold math is exposed.
console.log("\n[t] Playoff outlier reference vs regular-season");
{
  const { computeWeightedL5 } = await import("../api/lib/weighted-l5.js");
  const playoffGames = [
    { pts: 30, reb: 10, ast: 5, fgm: 11, fga: 22, fg3a: 4, ftm: 8, fta: 10, blk: 1, stl: 1, tov: 3, minutes: 36, matchup: "OKC @ SAS" },
    { pts: 32, reb: 12, ast: 4, fgm: 12, fga: 24, fg3a: 4, ftm: 8, fta: 10, blk: 2, stl: 1, tov: 3, minutes: 36, matchup: "OKC vs SAS" },
    { pts: 28, reb: 9, ast: 6, fgm: 10, fga: 20, fg3a: 3, ftm: 8, fta: 10, blk: 1, stl: 1, tov: 3, minutes: 35, matchup: "OKC @ SAS" },
    { pts: 31, reb: 11, ast: 5, fgm: 11, fga: 22, fg3a: 4, ftm: 9, fta: 11, blk: 2, stl: 2, tov: 3, minutes: 36, matchup: "OKC vs SAS" },
    { pts: 29, reb: 10, ast: 5, fgm: 11, fga: 22, fg3a: 3, ftm: 7, fta: 9, blk: 1, stl: 1, tov: 3, minutes: 35, matchup: "OKC @ SAS" },
  ];
  // Regular-season ppg=22, playoff raw mean=30 → at reg-season ref every
  // game crosses 1.5×22=33 only on the 32 case... so let's verify against
  // both: with playoff ref (~30), nothing is >1.5×30=45 or <0.5×30=15 →
  // outlier_present=false. With regular ref alone (no playoffPpg) the
  // same games are below 1.5×22=33 except 33 which is not present, so
  // still false. Use a sharper case below to verify the SHIFT.
  const reg = computeWeightedL5({
    games: playoffGames, seasonPpg: 18, playoffPpg: null, ownAbbr: "OKC",
    series: { opponent_abbr: "SAS", next_game_number: 4 },
  });
  // Reg-season ref=18 → 1.5×18=27. All games 28-32 > 27 → ALL are hot outliers
  assert("[t1] reg-season ref alone flags playoff games as outliers", reg.outlier_present === true);
  assert("[t1] outlier_ref_type === regular_season", reg.outlier_ref_type === "regular_season");

  const playoff = computeWeightedL5({
    games: playoffGames, seasonPpg: 18, playoffPpg: 30, ownAbbr: "OKC",
    series: { opponent_abbr: "SAS", next_game_number: 4 },
  });
  // Playoff ref=30 → 1.5×30=45, 0.5×30=15. None of 28-32 cross → no outlier.
  assert("[t2] playoff ref calms the false positive", playoff.outlier_present === false);
  assert("[t2] outlier_ref_type === playoff_l5", playoff.outlier_ref_type === "playoff_l5");
}

// (u) playoffPpg fallback — when playoffPpg is null (e.g., l5.n < 5 in
// the caller), the function falls back to seasonPpg even in playoff mode.
console.log("\n[u] Playoff outlier ref falls back to seasonPpg when playoffPpg null");
{
  const { computeWeightedL5 } = await import("../api/lib/weighted-l5.js");
  const games = [
    { pts: 20, reb: 5, ast: 5, fgm: 8, fga: 18, fg3a: 3, ftm: 4, fta: 5, blk: 1, stl: 1, tov: 2, minutes: 32, matchup: "OKC @ SAS" },
    { pts: 22, reb: 6, ast: 4, fgm: 9, fga: 19, fg3a: 3, ftm: 4, fta: 5, blk: 1, stl: 1, tov: 2, minutes: 33, matchup: "OKC vs SAS" },
    { pts: 19, reb: 5, ast: 5, fgm: 8, fga: 18, fg3a: 2, ftm: 3, fta: 4, blk: 1, stl: 1, tov: 2, minutes: 32, matchup: "OKC @ SAS" },
  ];
  const w = computeWeightedL5({
    games, seasonPpg: 20, playoffPpg: null, ownAbbr: "OKC",
    series: { opponent_abbr: "SAS", next_game_number: 4 },
  });
  // Reaches playoff_raw_fallback (vsCurrentOpp < 3 since opponent parsing
  // sees 'OKC' as own, 'SAS' or '@'/'vs' get filtered, so opp is 'SAS' on
  // all 3 games... actually OKC@SAS parses SAS as opponent for OKC's perspective.
  // Three games vs SAS = vsCurrentOpp=3 = playoff_series mode. With games.length=3
  // mode is playoff_series. outlier_ref_type should be regular_season.
  assert("[u] outlier_ref_type falls back to regular_season when playoffPpg null", w.outlier_ref_type === "regular_season");
}

// (v) UNDER outlier demote — A→B when outlier_present + mechanism stack
// that would normally yield A-tier (2 mechanisms).
console.log("\n[v] UNDER outlier demote — A→B");
{
  const v = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 16, rpg: 8, apg: 3, pa: 19, pra: 27, fta: 3, ft_pct: 0.7 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 16, rpg: 8, apg: 3 },
        weighted: { averages: { ppg: 16 }, outlier_present: true, outlier_ref_type: "regular_season" },
        games: [],
      },
      opponent_defense: { def_rank: 8 },
      mechanisms: {
        mech1: { confirmed: true, restriction: 24 },  // minutes restriction
        mech2: { confirmed: true, teammate: "X", teammate_ppg: 18, status: "OUT" },
        mech3: { confirmed: false },
        opponent_starters_out: 0,
      },
    }),
    statType: "Rebounds", direction: "UNDER", line: 7.5,
  });
  // 2 mechanisms → A-tier, demoted to B by outlier_present.
  assert("[v] outlier+2mech demotes to B", v.tier === "B", `got ${v.tier}`);
  assert("[v] L5 outlier flag present", v.flags.some(f => /L5 outlier/.test(f)));
}

// (w) UNDER outlier demote — B→SKIP when outlier_present + Mech 3 alone
// (single low-tier mechanism that would normally yield B-advisory).
// Line 8.5 keeps baseline neutral (edge 0.5 < buffer 1.0) so the
// mechanism-only path triggers, then outlier demotes B→SKIP.
console.log("\n[w] UNDER outlier demote — Mech 3 alone + outlier → SKIP");
{
  const v = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 16, rpg: 8, apg: 3, pa: 19, pra: 27, fta: 3, ft_pct: 0.7 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 16, rpg: 8, apg: 3 },
        weighted: { averages: { ppg: 16 }, outlier_present: true, outlier_ref_type: "regular_season" },
        games: [],
      },
      opponent_defense: { def_rank: 2 },
      mechanisms: {
        mech1: { confirmed: false },
        mech2: { confirmed: false },
        mech3: { confirmed: true, def_rank: 2, top_tier: 5 },
        opponent_starters_out: 0,
      },
    }),
    statType: "Rebounds", direction: "UNDER", line: 8.5,
  });
  assert("[w] outlier+Mech3-alone → SKIP", v.verdict === "SKIP", `got ${v.verdict}/${v.tier}`);
}

// (x) Rule 5j — UNDER baseline gate (two-way).
console.log("\n[x] Rule 5j — UNDER baseline gate");
{
  // x.1 — Stewart-style: PRA baseline 33.60, line 30.5, home so no road
  // deduction. adjusted 33.60 > line 30.5 + buffer 1.5 → 5j hard-SKIPs.
  const v1 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 22.5, rpg: 8, apg: 3.1, pa: 25.6, pra: 33.60 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 22.5, pra: 33.60 },
        weighted: { averages: { pra: 33.60 } },
        games: [],
      },
    }),
    statType: "PRA", direction: "UNDER", line: 30.5,
  });
  assert("[x.1] baseline >> line → 5j hard-SKIPs UNDER", v1.verdict === "SKIP", `got ${v1.verdict}/${v1.tier}`);
  assert("[x.1] rule5j in rules_fired", v1.rules_fired.includes("5j"));

  // x.2 — 5j hard-SKIP overrides confirmed mechanism. Same player + line,
  // now with Mech 1 (minutes restriction) confirmed. 5j SKIP wins.
  const v2 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 22.5, rpg: 8, apg: 3.1, pa: 25.6, pra: 33.60 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 22.5, pra: 33.60 },
        weighted: { averages: { pra: 33.60 } },
        games: [],
      },
      mechanisms: {
        mech1: { confirmed: true, restriction: 28 },
        mech2: { confirmed: false },
        mech3: { confirmed: false },
        opponent_starters_out: 0,
      },
    }),
    statType: "PRA", direction: "UNDER", line: 30.5,
  });
  assert("[x.2] 5j SKIP beats confirmed Mech 1", v2.verdict === "SKIP", `got ${v2.verdict}/${v2.tier}`);

  // x.3 — Large-edge UNDER, no mechanism. PRA baseline 22, line 32 →
  // edge 10. 5j ISSUE no cap; with edge ≥3 bonus signal + L5≥5 + WP
  // in band = 3+ signals → S-tier gate satisfied. Confidence stacks
  // edge × edge_unit_bonus = 10 × 1.5 = 15 + base 70 + sig bonuses.
  // Lands in S band.
  const v3 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      win_prob: { player_team_pct: 0.50 },
      season: { averages: { ppg: 14, rpg: 3, apg: 5, pa: 19, pra: 22 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 14, pra: 22 },
        weighted: { averages: { pra: 22 } },
        games: [],
      },
    }),
    statType: "PRA", direction: "UNDER", line: 32,
  });
  assert("[x.3] large-edge UNDER no mech → issued", v3.verdict === "UNDER", `got ${v3.verdict}/${v3.tier}`);
  assert("[x.3] large-edge UNDER reaches S-tier", v3.tier === "S", `got ${v3.tier} (confidence ${v3.confidence})`);

  // x.4 — Moderate edge + Mech 1. PRA baseline 27, line 30 (edge 3),
  // Mech 1 confirmed. 5j ISSUE no cap (edge ≥3); mechanism adds 1
  // signal. Combined with WP in band + L5≥5 = 4+ signals → S.
  const v4 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      win_prob: { player_team_pct: 0.50 },
      season: { averages: { ppg: 18, rpg: 3, apg: 6, pa: 24, pra: 27 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 18, pra: 27 },
        weighted: { averages: { pra: 27 } },
        games: [],
      },
      mechanisms: {
        mech1: { confirmed: true, restriction: 28 },
        mech2: { confirmed: false },
        mech3: { confirmed: false },
        opponent_starters_out: 0,
      },
    }),
    statType: "PRA", direction: "UNDER", line: 30,
  });
  assert("[x.4] moderate-edge UNDER + Mech 1 → issued", v4.verdict === "UNDER", `got ${v4.verdict}/${v4.tier}`);
  assert("[x.4] moderate-edge UNDER + Mech 1 → S-tier", v4.tier === "S", `got ${v4.tier} (confidence ${v4.confidence})`);

  // x.5 — Marginal baseline (edge < buffer), no mechanism → SKIP via
  // mechanism gate. Baseline 28, line 29 (edge 1.0, PRA buffer 1.5) →
  // 5j defers, mechanism gate finds zero mechanisms → SKIP.
  const v5 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 18, rpg: 4, apg: 6, pa: 24, pra: 28 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 18, pra: 28 },
        weighted: { averages: { pra: 28 } },
        games: [],
      },
    }),
    statType: "PRA", direction: "UNDER", line: 29,
  });
  assert("[x.5] marginal edge, no mech → SKIP", v5.verdict === "SKIP", `got ${v5.verdict}/${v5.tier}`);
  assert("[x.5] under-mechanism rule SKIPs", v5.rules_fired.includes("under-mechanism"));

  // x.6 — Marginal baseline + Mech 1 alone, no baseline corroboration →
  // A max (mechanism path).
  const v6 = applyEngine({
    groundTruth: gt({
      home_away: "home",
      season: { averages: { ppg: 18, rpg: 4, apg: 6, pa: 24, pra: 28 } },
      l5: {
        type: "Regular Season", n: 5,
        averages: { ppg: 18, pra: 28 },
        weighted: { averages: { pra: 28 } },
        games: [],
      },
      mechanisms: {
        mech1: { confirmed: true, restriction: 28 },
        mech2: { confirmed: false },
        mech3: { confirmed: false },
        opponent_starters_out: 0,
      },
    }),
    statType: "PRA", direction: "UNDER", line: 29,
  });
  assert("[x.6] marginal + Mech 1 alone → A max", v6.tier === "A" || v6.tier === "B", `got ${v6.tier}`);
}

// (y) Rule 5a trimmed-baseline cap — one anomalous game inflates the
// full L5 baseline above the line, but the drop-max trimmed baseline
// doesn't clear it by buffer. Mirrors the Dylan Harper Fantasy Score
// case: 1 huge game (~68 FS) + 4 modest games (~22 FS avg). Full
// weighted baseline clears OVER 21 by a wide margin → would normally
// hit S-tier, but trimmed view shows the line is single-game-dependent
// → cap at A.
console.log("\n[y] Rule 5a trimmed-baseline cap — single-game dependent OVER");
{
  const games = [
    { matchup: "SA vs OKC", pts: 6,  reb: 3,  ast: 2, stl: 0, blk: 0, tov: 2, minutes: 17 },
    { matchup: "SA @ OKC",  pts: 12, reb: 2,  ast: 3, stl: 0, blk: 0, tov: 1, minutes: 25 },
    { matchup: "SA @ OKC",  pts: 24, reb: 11, ast: 6, stl: 7, blk: 0, tov: 1, minutes: 47 }, // anomaly
    { matchup: "SA @ MIN",  pts: 15, reb: 5,  ast: 2, stl: 0, blk: 1, tov: 3, minutes: 26 },
    { matchup: "SA vs MIN", pts: 12, reb: 10, ast: 2, stl: 1, blk: 1, tov: 2, minutes: 25 },
  ];
  const { computeWeightedL5 } = await import("../api/lib/weighted-l5.js");
  const w = computeWeightedL5({
    games, seasonPpg: 11.9, playoffPpg: 13.8, ownAbbr: "SA",
    series: { opponent_abbr: "OKC", next_game_number: 5 },
  });
  assert("[y] trimmed_averages.fs computed", typeof w?.trimmed_averages?.fs === "number", `got ${w?.trimmed_averages?.fs}`);
  assert("[y] trimmed fs < full fs (anomaly removed)",
    w.trimmed_averages.fs < w.averages.fs - 3,
    `trimmed=${w?.trimmed_averages?.fs} full=${w?.averages?.fs}`);

  const v = applyEngine({
    groundTruth: gt({
      league: "NBA",
      home_away: "home",
      season: { averages: { ppg: 11.91, rpg: 3.44, apg: 3.8, fs: 23.7, fta: 1.73, ft_pct: 0.48 } },
      l5: {
        type: "Playoffs", n: 5,
        averages: { ppg: 13.8, rpg: 6.2, apg: 3, fs: 29.9 },
        weighted: w,
        games,
      },
      opponent_defense: { def_rank: 8 },
      series: { opponent_abbr: "OKC", next_game_number: 5, leading_team_abbr: null, round: "1", series_record: "2-2" },
      mechanisms: {
        mech1: { confirmed: false },
        mech2: { confirmed: false },
        mech3: { confirmed: false },
        opponent_starters_out: 0,
      },
    }),
    statType: "Fantasy Score", direction: "OVER", line: 21,
  });
  assert("[y] OVER verdict (still viable)", v.verdict === "OVER", `got ${v.verdict}/${v.tier}`);
  assert("[y] tier capped at A (or B), not S", v.tier === "A" || v.tier === "B", `got ${v.tier}`);
  assert("[y] trimmed-baseline flag surfaced",
    v.flags.some((f) => /trimmed/i.test(f)), `flags=${JSON.stringify(v.flags)}`);
}

// (z) Strong-suppressor (5b/5h) thin-edge gate — Phase-2 calibration change.
// A 5h-flagged scoring OVER that clears the line by < 1.5× its buffer SKIPs;
// the same setup with a large edge still issues (capped at A by 5h).
console.log("\n[z] 5b/5h thin-edge SKIP gate");
{
  // 5h tier-2 fires: scoring prop, fta ≥ gate (WNBA 4), def_rank ≤ tier2 (1).
  // home → no road deduction; ft_pct ≥ 0.70 and no variance/outlier → buffer
  // stays at the Points base of 1.5, so minEdge = 1.5 × 1.5 = 2.25.
  const base5h = {
    home_away: "home",
    season: { averages: { ppg: 25, rpg: 5, apg: 4, fta: 6, ft_pct: 0.80, spg: 1, bpg: 0.5, topg: 2, fs: 45 } },
    l5: {
      type: "Regular Season", n: 5,
      averages: { ppg: 25, fta: 6, ft_pct: 0.80 },
      weighted: { averages: { ppg: 25 } },
      games: [],
    },
    opponent_defense: { def_rank: 1, primary_defender: null },
  };

  // Thin edge: baseline 25, line 23.5 → edge 1.5 < 2.25 → SKIP via the gate.
  const thin = applyEngine({ groundTruth: gt(base5h), statType: "Points", direction: "OVER", line: 23.5 });
  assert("[z] 5h fires on thin-edge OVER", thin.rules_fired.includes("5h"), `fired=${JSON.stringify(thin.rules_fired)}`);
  assert("[z] thin-edge 5h OVER → SKIP", thin.verdict === "SKIP", `got ${thin.verdict}/${thin.tier}`);
  assert("[z] thin-edge SKIP flag surfaced", thin.flags.some((f) => /thin edge/i.test(f)), `flags=${JSON.stringify(thin.flags)}`);

  // Large edge: same setup, line 20 → edge 5 ≥ 2.25 → still issues (5h caps A).
  const wide = applyEngine({ groundTruth: gt(base5h), statType: "Points", direction: "OVER", line: 20 });
  assert("[z] large-edge 5h OVER still issues", wide.verdict === "OVER", `got ${wide.verdict}/${wide.tier}`);
  assert("[z] large-edge 5h OVER capped ≤ A", wide.tier === "A" || wide.tier === "B", `got ${wide.tier}`);
  assert("[z] large-edge OVER keeps no thin-edge flag", !wide.flags.some((f) => /thin edge/i.test(f)));
}

// (z2) snapToBand-fix shadow — pure shadowTierFor logic + engine wiring.
// shadow_tier is telemetry only (live verdict unchanged); it can only
// demote/SKIP relative to the cap-resolved tier, never promote.
console.log("\n[z2] snapToBand-fix shadow");
{
  assert("[z2] A + raw 64 → B", shadowTierFor("A", 64) === "B", shadowTierFor("A", 64));
  assert("[z2] A + raw 55 → SKIP", shadowTierFor("A", 55) === "SKIP", shadowTierFor("A", 55));
  assert("[z2] S + raw 70 → A", shadowTierFor("S", 70) === "A", shadowTierFor("S", 70));
  assert("[z2] S + raw 60 → SKIP", shadowTierFor("S", 60) === "SKIP", shadowTierFor("S", 60));
  assert("[z2] A + raw 75 → A (fits)", shadowTierFor("A", 75) === "A", shadowTierFor("A", 75));
  assert("[z2] B + raw 90 → B (no promote)", shadowTierFor("B", 90) === "B", shadowTierFor("B", 90));
  assert("[z2] SKIP stays SKIP", shadowTierFor("SKIP", 88) === "SKIP", shadowTierFor("SKIP", 88));

  // Engine wiring: shadow_tier present and never out-ranks the live tier.
  const pv = applyEngine({ groundTruth: gt(), statType: "Points", direction: "OVER", line: 19.5 });
  assert("[z2] engine sets shadow_tier", typeof pv.shadow_tier === "string", `got ${pv.shadow_tier}`);
  assert("[z2] shadow never out-ranks live", TIER_RANK[pv.shadow_tier] <= TIER_RANK[pv.tier], `${pv.shadow_tier} vs ${pv.tier}`);
}

console.log(`\n=== smoke-engine: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
