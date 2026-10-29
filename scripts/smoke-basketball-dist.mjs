// Smoke for the basketball predictive distribution (api/_lib/basketball/dist.js).
// No network.
//   node scripts/smoke-basketball-dist.mjs
import { valueOf, minutesProfile, fitDispersion, engineMean, calibratedProbOver, PROP_KEY, DIST_KEYS } from "../api/_lib/basketball/dist.js";
import { mulberry32, sampleCount } from "../api/_lib/distributions.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// A) Prop values from a box score (combos, Blocks+Steals, Fantasy weights)
const row = { min: 30, pts: 20, reb: 10, ast: 5, stl: 2, blk: 1, tov: 3, fg3m: 2, fg3a: 6, fga: 15 };
ok(valueOf(row, "pra") === 35 && valueOf(row, "pr") === 30 && valueOf(row, "ra") === 15, "A: combos sum");
ok(valueOf(row, "bs") === 3, "A: Blocks+Steals");
ok(Math.abs(valueOf(row, "fs") - (20 + 12 + 7.5 + 6 + 3 - 3)) < 1e-9, "A: Fantasy Score 1/1.2/1.5/3/3/−1");
ok(Object.keys(PROP_KEY).length === DIST_KEYS.length && PROP_KEY["Fantasy Score"] === "fs", "A: every PrizePicks prop has a key");

// B) Minutes profile: recency-weighted, ignores DNPs, window of 10
const mp = minutesProfile([10, 10, 10, 0, 30, 30]);
ok(mp.n === 5 && mp.mean > 18 && mp.mean < 30, `B: recent minutes weigh more than the plain average 18 (${mp.mean.toFixed(2)})`);
ok(minutesProfile(Array(15).fill(20)).n === 10, "B: window capped at 10");
ok(minutesProfile([0, 0]) === null, "B: no minutes → null");

// C) Dispersion fit recovers a known negative binomial
{
  const rng = mulberry32(3), pairs = [];
  for (let i = 0; i < 20000; i++) { const mu = 2 + (i % 20); pairs.push({ mu, y: sampleCount(mu, 6, rng) }); }
  const r = fitDispersion(pairs);
  ok(r > 4.8 && r < 7.4, `C: NB(r=6) recovered (${r.toFixed(2)})`);
  ok(fitDispersion([{ mu: 3, y: 3 }, { mu: 5, y: 5 }]) === 1e6, "C: no overdispersion → Poisson-like (r huge)");
}

// D) Engine-style mean = ½ last-5 + ½ season
{
  const h = [10, 10, 10, 10, 10, 20, 20, 20, 20, 20].map((pts) => ({ row: { pts } }));
  ok(Math.abs(engineMean(h, "pts") - (0.5 * 20 + 0.5 * 15)) < 1e-9, "D: engine mean blends last 5 and season");
}

// E) Calibrated P(over)
{
  const params = { r: { pts: 6 }, c: { pts: 1.04 } };
  const p = (mean, line, factor = 1) => calibratedProbOver({ params, key: "pts", mean, factor, line }).p_over;
  ok(p(20, 15.5) > 0.5 && p(20, 24.5) < p(20, 19.5), "E: line well below the mean → P(over) > 0.5; higher line → lower P(over)");
  ok(p(20, 20.5, 1.1) > p(20, 20.5), "E: favorable matchup raises P(over)");
  ok(Math.abs(calibratedProbOver({ params, key: "pts", mean: 20, line: 20.5 }).mean - 20.8) < 1e-9, "E: mean × c");
  // right skew: at a line at the mean, P(over) < 0.5 (median below mean)
  ok(p(20 / 1.04, 19.5) < 0.5 + 1e-9 || p(20 / 1.04, 20.5) < 0.5, "E: right-skewed — P(over the mean) < 0.5");
  ok(calibratedProbOver({ params, key: "reb", mean: 5, line: 4.5 }) === null, "E: missing params → null");
  ok(calibratedProbOver({ params, key: "pts", mean: null, line: 4.5 }) === null, "E: missing mean → null");
}

// F) Bundled artifacts carry fitted parameters for every key
{
  const fs = await import("node:fs");
  for (const lg of ["nba", "wnba"]) {
    const f = new URL(`../data/${lg}-opp-model.json`, import.meta.url);
    if (!fs.existsSync(f)) { console.log(`SKIP  ${lg} artifact`); continue; }
    const a = JSON.parse(fs.readFileSync(f, "utf8"));
    ok(a.dist && DIST_KEYS.every((k) => a.dist.r[k] > 0 && a.dist.c[k] > 0.8 && a.dist.c[k] < 1.2), `F: ${lg} artifact has r and c for every prop`);
  }
}

// G) Pipeline policy: blend, direction, caps (basketball/policy.js)
{
  const { pipelineVerdict, BASKETBALL_POLICY } = await import("../api/_lib/basketball/policy.js");
  const v = pipelineVerdict({ pModelOver: 0.70, pMarketOver: 0.60, direction: "OVER" });
  ok(v.prob > 0.60 && v.prob < 0.70 && !v.model_only, `G: 50/50 log-odds blend sits between model and market (${v.prob.toFixed(3)})`);
  const u = pipelineVerdict({ pModelOver: 0.30, pMarketOver: 0.40, direction: "UNDER" });
  ok(Math.abs(u.prob - v.prob) < 1e-12, "G: UNDER prices the other side symmetrically");
  ok(v.tier === "A" && Math.abs(v.break_even - 0.577) < 0.002, `G: standard edge ${v.edge.toFixed(3)} over 57.7% → A`);
  ok(pipelineVerdict({ pModelOver: 0.90, pMarketOver: null, direction: "OVER" }).tier === "SKIP", "G: no market → model-only, never tiered");
  ok(pipelineVerdict({ pModelOver: 0.95, pMarketOver: 0.92, direction: "OVER", oddsType: "goblin" }).tier !== "A", "G: goblin capped below A (approximate payout)");
  ok(pipelineVerdict({ pModelOver: 0.55, pMarketOver: 0.50, direction: "OVER" }).tier === "SKIP", "G: below break-even → SKIP");
  ok(pipelineVerdict({ pModelOver: null, pMarketOver: 0.5, direction: "OVER" }) === null, "G: no model P → null");
  ok(BASKETBALL_POLICY.maxTier === "A" && BASKETBALL_POLICY.modelOnlyMaxTier === "SKIP", "G: no S-tier, model-only never tiered");
}

// H) NB market shift (book price at its line → PrizePicks line)
{
  const { nbShiftOver } = await import("../api/_lib/basketball/dist.js");
  const s = (o) => nbShiftOver({ r: 6, ...o });
  ok(s({ pOver: 0.5, bookLine: 20.5, targetLine: 20.5 }) === 0.5, "H: same line → unchanged");
  const down = s({ pOver: 0.5, bookLine: 20.5, targetLine: 16.5 }), up = s({ pOver: 0.5, bookLine: 20.5, targetLine: 24.5 });
  ok(down > 0.5 && up < 0.5, "H: lower line → higher P(over), higher line → lower");
  ok(Math.abs((down - 0.5) - (0.5 - up)) > 0.005, `H: asymmetric (skewed) shift (${down.toFixed(3)} / ${up.toFixed(3)})`);
  const back = s({ pOver: down, bookLine: 16.5, targetLine: 20.5 });
  ok(Math.abs(back - 0.5) < 0.005, `H: shifting back recovers the book price (${back.toFixed(4)})`);
  ok(s({ pOver: 0.45, bookLine: 1.5, targetLine: 0.5 }) > 0.45, "H: low-count goblin shift moves the right way");
  ok(nbShiftOver({ pOver: 0.5, bookLine: 2.5, targetLine: 1.5, r: null }) === null, "H: missing r → null");
}

// I) Early-season shrink (SHADOW): weight n/(n+k) on the calibrated mean
{
  const { shrinkMean, EARLY_SEASON_K } = await import("../api/_lib/basketball/dist.js");
  const { shrinkFields } = await import("../api/_lib/verdict-logger.js");
  ok(EARLY_SEASON_K === 8, "I: k = 8");
  const s0 = shrinkMean({ mean: 2, oppMean: 10, n: 0 });
  ok(s0.w === 0 && s0.mean === 10, "I: no games this season → opponent-model mean");
  const s8 = shrinkMean({ mean: 2, oppMean: 10, n: 8 });
  ok(s8.w === 0.5 && s8.mean === 6, "I: n = k → halfway");
  ok(shrinkMean({ mean: 2, oppMean: 10, n: 72 }).w === 0.9, "I: late season → mostly this season");
  ok(shrinkMean({ mean: null, oppMean: 10, n: 3 }) === null, "I: missing mean → null");

  // Capela-style case: 1.3 pts in 3 games, normal role says ~8 at 24 min.
  const gt = {
    league: "NBA",
    season: { is_prior_season: false, averages: { games: 3 } },
    l5: { is_prior_season: false, games: [{ minutes: 24 }, { minutes: 22 }, { minutes: 26 }] },
    opp_factor: { dist: { r: 6 }, opp_per_min: 8 / 24 },
  };
  const f = shrinkFields(gt, 1.3, 6.5, "UNDER", "standard", 0.5);
  ok(f.shrink_n === 3 && Math.abs(f.shrink_w - 3 / 11) < 1e-3, "I: n from season games, w = 3/11");
  ok(f.shrink_mean > 1.3 && f.shrink_mean < f.shrink_opp_mean, `I: mean pulled toward the prior (${f.shrink_mean})`);
  ok(f.shrink_dir_prob < 0.9, `I: UNDER no longer near-certain (${f.shrink_dir_prob})`);
  ok(typeof f.shrink_pipe_prob === "number" && typeof f.shrink_pipe_tier === "string", "I: pipeline prob + tier logged");
  ok(shrinkFields({ ...gt, league: "WNBA" }, 1.3, 6.5, "UNDER", "standard", 0.5).shrink_mean === null, "I: NBA only");
  ok(shrinkFields({ ...gt, season: { is_prior_season: true, averages: { games: 70 } } }, 1.3, 6.5, "UNDER", "standard", 0.5).shrink_n === 0, "I: prior-season fallback → n = 0");
  ok(shrinkFields({ ...gt, opp_factor: { dist: { r: 6 } } }, 1.3, 6.5, "UNDER", "standard", 0.5).shrink_mean === null, "I: no opponent-model rate → null");
}

// J) Known-lineup minutes (SHADOW): rotation, Out/Doubtful removal, rescale
{
  const { buildRotation, lineupMinutes, normName } = await import("../api/_lib/basketball/dist.js");
  const { lineupFields } = await import("../api/_lib/verdict-logger.js");
  ok(normName("Luka Dončić") === "luka doncic" && normName("Jaren Jackson Jr.") === "jaren jackson" && normName("Kel'el Ware") === "kelel ware", "J: name keys strip accents, suffixes, punctuation");
  // Team AAA: 6 games; players 1–8 play 30 min every game, 9 played only game 1
  // (out of the rotation), 10 joins in game 6 with 8 min → rotation sums to 248.
  const team_games = [], rows = [];
  for (let g = 1; g <= 6; g++) {
    team_games.push({ game_id: `g${g}`, team: "AAA", opponent: "BBB", date: `2026-10-${String(20 + g).padStart(2, "0")}` });
    for (let p = 1; p <= 8; p++) rows.push({ game_id: `g${g}`, team: "AAA", player_id: p, min: 30 });
    if (g === 1) rows.push({ game_id: "g1", team: "AAA", player_id: 9, min: 10 });
    if (g === 6) rows.push({ game_id: "g6", team: "AAA", player_id: 10, min: 8 });
  }
  const players = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => [p, { name: p === 2 ? "Nikola Jokić" : `Player ${p}` }]));
  const rot = buildRotation({ players, team_games, rows }).AAA;
  ok(rot.length === 9 && !rot.some((p) => p.id === "9") && rot.some((p) => p.id === "10"), "J: rotation = played in the team's last 5 games");
  ok(rot.find((p) => p.id === "1").n === 6 && rot.find((p) => p.id === "1").m0 === 30, "J: games played + recency minutes");
  const base = lineupMinutes({ rotation: rot, playerId: 1 });
  ok(rot.find((p) => p.id === "10").p === 0.2 && rot.find((p) => p.id === "1").p === 1, "J: p = share of the team's last 5 games played");
  // Expected minutes: me 30 + 7 teammates × 30 × p=1 + player 10 × 8 × p=0.2 = 241.6
  ok(base && base.out.length === 0 && Math.abs(base.minutes - 30 * (240 / 241.6)) < 0.01, `J: no injuries → ≈ usual minutes (expected team total ≈ 240) (${base?.minutes.toFixed(2)})`);
  const inj = lineupMinutes({ rotation: rot, playerId: 1, injuries: [{ player: "Nikola Jokic", status: "Out" }, { player: "Player 3", status: "Day-To-Day" }] });
  ok(inj.out.length === 1 && inj.out[0] === "Nikola Jokić", "J: Out matched by name key; Day-To-Day still plays");
  ok(inj.minutes > base.minutes && inj.minutes <= 44, `J: a teammate out → more minutes, capped (${inj.minutes.toFixed(2)})`);
  ok(lineupMinutes({ rotation: rot, playerId: 99 }) === null && lineupMinutes({ rotation: null, playerId: 1 }) === null, "J: player outside the rotation / no rotation → null");
  const gt = {
    league: "NBA", opp_ctx: { playerId: 1 },
    season: { is_prior_season: false, averages: { games: 6 } },
    injuries: { player_team: [{ player: "Nikola Jokić", status: "Doubtful" }] },
    opp_factor: { dist: { r: 6 }, opp_per_min: 0.5, team_rotation: rot },
  };
  const lf = lineupFields(gt, 20, 19.5, "OVER", "standard", 0.5);
  ok(lf.lineup_out_n === 1 && lf.lineup_minutes > lf.lineup_m0, "J: Doubtful counts as out; minutes rise");
  const { shrinkMean: sm } = await import("../api/_lib/basketball/dist.js");
  const atM0 = sm({ mean: 20, oppMean: 0.5 * 30, n: 6 }).mean;
  ok(lf.lineup_mean > atM0 && typeof lf.lineup_pipe_tier === "string", `J: mean rises vs the same shrink at usual minutes (${lf.lineup_mean} > ${atM0.toFixed(3)}); pipeline tier logged`);
  ok(lineupFields({ ...gt, league: "WNBA" }, 20, 19.5, "OVER", "standard", 0.5).lineup_mean === null, "J: NBA only");
  ok(lineupFields({ ...gt, opp_factor: { ...gt.opp_factor, team_rotation: null } }, 20, 19.5, "OVER", "standard", 0.5).lineup_mean === null, "J: no rotation in the artifact → null");

  // K) Damped / position-aware variant (lineup_damped_*): groups 1–3 G,
  // 4–6 W, 7–8 + 10 B; Jokić (player 2) is a G here.
  const { LINEUP_DAMPED } = await import("../api/_lib/basketball/dist.js");
  const { lineupDampedFields } = await import("../api/_lib/verdict-logger.js");
  const grp = (id) => (["1", "2", "3"].includes(id) ? "G" : ["4", "5", "6"].includes(id) ? "W" : "B");
  const rotG = rot.map((p) => ({ ...p, group: grp(p.id) }));
  const out2 = [{ player: "Nikola Jokic", status: "Out" }];
  const same = (a, b) => Math.abs(a.minutes - b.minutes) < 1e-9 && a.scale === b.scale;
  ok(same(lineupMinutes({ rotation: rotG, playerId: 1, injuries: out2, alpha: 0, beta: 1 }), lineupMinutes({ rotation: rotG, playerId: 1, injuries: out2 }))
    && same(lineupMinutes({ rotation: rotG, playerId: 1, alpha: 0.5, beta: 0.5 }), lineupMinutes({ rotation: rotG, playerId: 1 })), "K: α0/β1 = proportional rule; nobody out → damping changes nothing");
  // Explicit (non-default-path) α0/β1 must equal the proportional rule too.
  const prop = lineupMinutes({ rotation: rotG, playerId: 4, injuries: out2 }), viaPos = lineupMinutes({ rotation: rotG, playerId: 4, injuries: out2, alpha: 0, beta: 0.9999999 });
  ok(Math.abs(prop.minutes - viaPos.minutes) < 1e-4, `K: position formula at β→1, α=0 matches proportional (${prop.minutes.toFixed(4)} vs ${viaPos.minutes.toFixed(4)})`);
  const und = lineupMinutes({ rotation: rotG, playerId: 1, injuries: out2 }), damp = lineupMinutes({ rotation: rotG, playerId: 1, injuries: out2, alpha: 0, beta: 0.5 });
  ok(damp.minutes > base.minutes && damp.minutes < und.minutes, `K: β=0.5 gain sits between none and proportional (${base.minutes.toFixed(2)} < ${damp.minutes.toFixed(2)} < ${und.minutes.toFixed(2)})`);
  const gMate = lineupMinutes({ rotation: rotG, playerId: 3, injuries: out2, alpha: 1, beta: 1 }), wMate = lineupMinutes({ rotation: rotG, playerId: 4, injuries: out2, alpha: 1, beta: 1 });
  ok(gMate.minutes > wMate.minutes + 5, `K: α=1 sends a guard's minutes to guards (${gMate.minutes.toFixed(2)} vs wing ${wMate.minutes.toFixed(2)})`);
  const noGrp = lineupMinutes({ rotation: rot, playerId: 1, injuries: out2, ...LINEUP_DAMPED }), dampA0 = lineupMinutes({ rotation: rotG, playerId: 1, injuries: out2, alpha: 0, beta: LINEUP_DAMPED.beta });
  ok(Math.abs(noGrp.minutes - dampA0.minutes) < 1e-9, "K: rotation without groups (older artifact) → damping only");
  const gtG = { ...gt, opp_factor: { ...gt.opp_factor, team_rotation: rotG } };
  const ld = lineupDampedFields(gtG, 20, 19.5, "OVER", "standard", 0.5), lu2 = lineupFields(gtG, 20, 19.5, "OVER", "standard", 0.5);
  const want = lineupMinutes({ rotation: rotG, playerId: 1, injuries: gt.injuries.player_team, ...LINEUP_DAMPED });
  ok(ld.lineup_damped_minutes === +want.minutes.toFixed(1) && ld.lineup_damped_minutes !== lu2.lineup_minutes && typeof ld.lineup_damped_pipe_tier === "string", `K: lineup_damped_* priced at LINEUP_DAMPED minutes (${ld.lineup_damped_minutes} vs proportional ${lu2.lineup_minutes})`);
  ok(lineupDampedFields({ ...gtG, league: "WNBA" }, 20, 19.5, "OVER", "standard", 0.5).lineup_damped_mean === null, "K: NBA only");
}

console.log(`\nsmoke-basketball-dist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
