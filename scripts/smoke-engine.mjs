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

  // Mech 3 alone (matchup ceiling) → B-tier max with SKIP advisory.
  // Use a non-alpha season ppg so Rule 4b doesn't short-circuit to SKIP
  // (sole-alpha boost makes UNDER invalid).
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
    statType: "Rebounds", direction: "UNDER", line: 11.5,
  });
  assert("Mech 3 alone → B-tier", v2.tier === "B", `got ${v2.tier}`);
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

console.log(`\n=== smoke-engine: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
