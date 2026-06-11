// Unit smoke for the World Cup (soccer) framework — WC_FRAMEWORK_SPEC.md.
// No network; injects synthetic odds + rates. Covers: Poisson math, ladder
// fit, WC lookupMarket pricing, soccer ground truth composition, the WC rule
// family through applyEngine, and the pre-filter bypass.
//   node scripts/smoke-wc.mjs
import { poissonTail, poissonFairOver, fitLadderPoisson, fairLambda, POISSON_LAMBDA_MARGIN } from "../api/_lib/poisson.js";
import { setOdds, lookupMarket, lookupVegas } from "../api/_lib/odds.js";
import { gatherSoccerGroundTruth, setSoccerRates, setSoccerAccrual } from "../api/_lib/soccer-truth.js";
import { projectProb } from "../api/_lib/projection.js";
import { preFilterMechanical } from "../api/_lib/verdict-verifier.js";
import { applyEngine } from "../api/_lib/engine.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// ── 1) Poisson math ─────────────────────────────────────────────────────────
ok(Math.abs(poissonTail(1, 1) - (1 - Math.exp(-1))) < 1e-9, "P(X≥1|λ=1) = 1−e⁻¹");
ok(poissonTail(2.5, 0) === 1, "P(X≥0) = 1");
ok(Math.abs(poissonFairOver(3.0, 2.5) - poissonTail(3.0, 3)) < 1e-12, "fair over 2.5 = P(X≥3)");
ok(Math.abs(fairLambda(3.15) - 3.15 / (1 + POISSON_LAMBDA_MARGIN)) < 1e-9, "λ margin haircut");

// Ladder fit recovers λ: synthesize implied probs from a known λ with a 4% shade.
const lamTrue = 3.2;
const rungs = [2, 3, 4, 5].map((k) => ({ k, implied: Math.min(0.98, 1.04 * poissonTail(lamTrue * 1.0, k)) }));
const fit = fitLadderPoisson(rungs);
ok(fit && Math.abs(fit.lambda - lamTrue) < 0.25, `ladder fit recovers λ≈${lamTrue} (got ${fit?.lambda})`);
// Single rung: solvable via the default overround.
const fit1 = fitLadderPoisson([{ k: 2, implied: 0.70 }]);
ok(fit1 && fit1.rungs_used === 1 && fit1.lambda > 0, `single-rung fit (λ=${fit1?.lambda})`);

// ── 2) WC odds store + lookups ──────────────────────────────────────────────
const wcEntry = (over = {}) => ({
  stat: "Shots", league: "WC", line: 2.5, fair_over: 0.55, lambda: 2.94, lambda_fair: 2.8, overround: 1,
  ladder: [{ k: 2, american: -250, implied: 0.714 }, { k: 3, american: 120, implied: 0.455 }],
  team: "Mexico", opponent: "South Africa", game: "South Africa@Mexico", start_time: "2026-06-11T19:00:00Z",
  books: 1, sources: [{ book: "draftkings", kind: "ladder", line: 2.5, fair_over: 0.55, rungs: 2 }],
  ...over,
});
const injectOdds = (entry) => setOdds({
  league: "WC", sources: ["draftkings"],
  by_player: { "Test Striker": [entry] },
  games: { "South Africa@Mexico": { home: "Mexico", away: "South Africa", game_total: 2.5, home_spread: -1.5, away_spread: 1.5, start_time: "2026-06-11T19:00:00Z" } },
});
injectOdds(wcEntry());

let m = lookupMarket({ player: "Test Striker", stat: "Shots", line: 2.5, league: "WC" });
ok(m && Math.abs(m.fair_over - poissonFairOver(2.8, 2.5)) < 1e-3, `WC lookupMarket prices from λ_fair (got ${m?.fair_over})`);
m = lookupMarket({ player: "Test Striker", stat: "Shots", line: 5.5, league: "WC" });
ok(m && m.fair_over < 0.12, `WC demon line priced from Poisson tail (got ${m?.fair_over})`);
ok(lookupMarket({ player: "Test Striker", stat: "Shots", line: 2.5, league: "NBA" }) === null, "cross-league guard");
const v = lookupVegas({ player: "Test Striker", league: "WC" });
ok(v && v.team_total === 2 && v.opp_total === 0.5, `WC team totals from total+spread (got ${v?.team_total}/${v?.opp_total})`);

// ── 3) Soccer ground truth ──────────────────────────────────────────────────
const ppProp = (over = {}) => ({
  player: "Test Striker", league: "WC", stat_type: "Shots", line: 2.5, odds_type: "standard",
  player_team: "Mexico", opponent: "South Africa", start_time: "2026-06-11T19:00:00.000-04:00",
  player_position: "Attacker", ...over,
});
// Starter-grade club sample: 2000' over 24 matches (share 0.93), 3.0 shots/90.
setSoccerRates({ players: { "test striker": { name: "Test Striker", minutes: 2000, matches: 24, shots_p90: 3.0, sot_p90: 1.1 } } });
setSoccerAccrual({ players: {} });

let gt = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp() }).groundTruth;
ok(gt.league === "WC" && gt.info.position === "Attacker", "ground truth identity");
ok(gt.soccer.expected_minutes === 78 && gt.soccer.minutes_source === "club_share_starter", `starter minutes (got ${gt.soccer.expected_minutes})`);
// Blend: n=min(2000/90,25)=22.2 → (22.2·3.0 + 5·2.4)/27.2 ≈ 2.89 shots/90.
ok(Math.abs(gt.soccer.rates.shots_p90 - 2.89) < 0.02, `shrunk rate (got ${gt.soccer.rates.shots_p90})`);
// λ = r_p90 × 78/90 × A_opp, with A_opp ≥ 1 here (team total 2.0 ≥ slate mean).
ok(gt.soccer.lambda.shots > 2.2 && gt.soccer.lambda.shots < 3.5, `λ_shots composed (got ${gt.soccer.lambda.shots})`);
ok(gt.game.knockout === false, "group-stage match not flagged knockout");

// No rates row → position prior + warning.
setSoccerRates({ players: {} });
gt = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp() }).groundTruth;
ok(gt.soccer.rates.source === "position_prior" && gt.data_warnings.length >= 1, "prior-only rates flagged");
setSoccerRates({ players: { "test striker": { name: "Test Striker", minutes: 2000, matches: 24, shots_p90: 3.0, sot_p90: 1.1 } } });

// Knockout flag from kickoff date.
gt = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp({ start_time: "2026-07-01T19:00:00Z" }) }).groundTruth;
ok(gt.game.knockout === true, "knockout flagged from kickoff date");

// ── 4) Projection (Poisson path) ────────────────────────────────────────────
gt = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp() }).groundTruth;
const proj = projectProb({ groundTruth: gt, statType: "Shots", direction: "OVER", line: 2.5 });
ok(proj && Math.abs(proj.model_prob - poissonFairOver(gt.soccer.lambda.shots, 2.5)) < 1e-3, `projectProb WC = Poisson tail (got ${proj?.model_prob})`);
const projU = projectProb({ groundTruth: gt, statType: "Shots", direction: "UNDER", line: 2.5 });
ok(projU && Math.abs(projU.dir_prob - (1 - projU.model_prob)) < 1e-9, "UNDER dir_prob mirrors");

// ── 5) Pre-filter bypass ────────────────────────────────────────────────────
ok(preFilterMechanical({ groundTruth: gt, statType: "Shots", direction: "OVER", line: 2.5 }) === null, "preFilter no-ops on WC");

// ── 6) Engine: WC rule family end-to-end ────────────────────────────────────
const run = (gtRun, { stat = "Shots", direction = "OVER", line = 2.5 } = {}) =>
  applyEngine({ groundTruth: { ...gtRun, prop_type: `${stat} ${direction}`, line }, statType: stat, direction, line });

// A) Strong market edge (λ_fair 2.8 → P(over 1.5)=0.769) + model agree + starter → S-grade OVER.
injectOdds(wcEntry());
let r = run(gt, { line: 1.5 });
ok(r.verdict === "OVER" && r.tier === "S", `A strong edge+agree+starter → S (got ${r.tier}, conf ${r.confidence})`);
ok(r.rules_fired.includes("market-edge") && r.rules_fired.includes("wc-projection") && r.rules_fired.includes("wc-minutes"), "A WC rules fired");
ok(r.market && typeof r.market.fair_at_line === "number" && r.projection && r.projection.lambda_model > 0, "A telemetry blocks present");

// B) No ladder for the player → market-led abstain.
setOdds({ league: "WC", by_player: {}, games: {} });
r = run(gt, { line: 2.5 });
ok(r.verdict === "SKIP" && r.flags.some((f) => /market-led/i.test(f)), `B no ladder → SKIP (got ${r.verdict})`);

// C) Thin market edge (fair ≈ 0.512 at 2.5) → SKIP per spec §5.
injectOdds(wcEntry({ lambda_fair: 2.55 }));
r = run(gt, { line: 2.5 });
ok(r.verdict === "SKIP", `C thin edge → SKIP (got ${r.verdict}, tier ${r.tier})`);

// D) Goalkeeper on a shots prop → SKIP regardless of market.
injectOdds(wcEntry());
const gtGk = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp({ player_position: "Goalkeeper" }) }).groundTruth;
r = run(gtGk, { line: 1.5 });
ok(r.verdict === "SKIP" && r.flags.some((f) => /Goalkeeper/i.test(f)), "D goalkeeper → SKIP");

// E) Bench-profile minutes (share < 0.5) on the OVER → minutes gate SKIP.
setSoccerRates({ players: { "test striker": { name: "Test Striker", minutes: 600, matches: 20, shots_p90: 3.0, sot_p90: 1.1 } } });
const gtBench = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp() }).groundTruth;
r = run(gtBench, { line: 1.5 });
ok(r.verdict === "SKIP" && r.flags.some((f) => /minutes|E\[min\]/i.test(f)), `E low minutes OVER → SKIP (got ${r.verdict})`);

// F) Prior-only rates → tier capped at A even with a big market edge.
setSoccerRates({ players: {} });
const gtPrior = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp() }).groundTruth;
// Force starter-grade minutes despite missing rates: prior-only keeps E[min]=55
// (rotation) which suppresses but doesn't gate ≥60... use UNDER to dodge the
// minutes gate and isolate the provenance cap.
injectOdds(wcEntry({ lambda_fair: 1.6 })); // P(over 2.5)=0.217 → UNDER fair 0.783
r = run(gtPrior, { direction: "UNDER", line: 2.5 });
ok(r.verdict === "UNDER" && r.tier === "A", `F prior-only rates → A cap (got ${r.tier})`);

// G) Knockout match carries the settlement flag.
setSoccerRates({ players: { "test striker": { name: "Test Striker", minutes: 2000, matches: 24, shots_p90: 3.0, sot_p90: 1.1 } } });
injectOdds(wcEntry());
const gtKo = gatherSoccerGroundTruth({ player: "Test Striker", prop: ppProp({ start_time: "2026-07-01T19:00:00Z" }) }).groundTruth;
r = run(gtKo, { line: 1.5 });
ok(r.flags.some((f) => /90'/.test(f)), "G knockout settlement flag present");

// H) Basketball regression guard: a WNBA ctx through the engine must not fire WC rules.
setOdds({ source: "draftkings", by_player: {}, games: {} });
const bball = applyEngine({
  groundTruth: { league: "WNBA", player: "Hoops Player", info: { full_name: "Hoops Player" }, season: { averages: { ppg: 20 } }, l5: { averages: { ppg: 21 }, n: 5 }, mechanisms: {}, injury_regions: [] },
  statType: "Points", direction: "OVER", line: 16.5,
});
ok(!bball.rules_fired.some((id) => id.startsWith("wc-")), "H basketball path fires no WC rules");

// Cleanup injected stores.
setSoccerRates(null);
setSoccerAccrual(null);

console.log(`\nsmoke-wc: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
