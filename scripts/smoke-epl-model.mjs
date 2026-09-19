// Hermetic smoke for the EPL model math: count distributions, seeded
// sampling, role mapping, and the fitted model on a synthetic 4-team league
// whose styles are known (T1 shoots twice as much; T4 concedes twice as many
// shots). No network, no data files.

import {
  countPmf, lineProbs, mixtureLineProbs, mixtureCrps, mulberry32, seedFrom, sampleCount,
} from "../api/_lib/epl/distributions.js";
import {
  roleFromPositionId, fitModel, projectPlayer, priceLine, simulateFantasy, minutesScenarios,
  teamTotal, FANTASY_WEIGHTS,
} from "../api/_lib/epl/model.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

console.log("[a] count distributions");
{
  const p = countPmf(3.2, Infinity, 60);
  assert("Poisson pmf sums to 1", close(sum(p), 1, 1e-9));
  assert("Poisson mean = μ", close(sum(p.map((v, k) => v * k)), 3.2, 1e-9));
  const nb = countPmf(3.2, 4, 200);
  const m = sum(nb.map((v, k) => v * k));
  const v = sum(nb.map((x, k) => x * (k - m) ** 2));
  assert("NB mean = μ, Var = μ + μ²/r", close(m, 3.2, 1e-6) && close(v, 3.2 + 3.2 ** 2 / 4, 1e-4), `mean ${m} var ${v}`);
  const big = countPmf(3.2, 1e7, 30);
  assert("NB with huge r → Poisson", close(big[2], p[2], 1e-5));
  const hl = lineProbs(2.5, 3.2, Infinity);
  assert("half line: over + under = 1, no push", close(hl.over + hl.under, 1, 1e-9) && hl.push === 0);
  assert("P(X > 2.5) = 1 − P(X ≤ 2)", close(hl.over, 1 - (p[0] + p[1] + p[2]), 1e-9));
  const il = lineProbs(3, 3.2, Infinity);
  assert("integer line: push = P(X = 3)", close(il.push, p[3], 1e-9) && close(il.over + il.under + il.push, 1, 1e-9));
  const mx = mixtureLineProbs(1.5, [{ p: 3, mu: 2, r: Infinity }, { p: 1, mu: 0.5, r: Infinity }]);
  const direct = 0.75 * lineProbs(1.5, 2, Infinity).over + 0.25 * lineProbs(1.5, 0.5, Infinity).over;
  assert("mixture renormalizes weights", close(mx.over, direct, 1e-12));
  const good = mixtureCrps(3, [{ p: 1, mu: 3, r: Infinity }]);
  const bad = mixtureCrps(3, [{ p: 1, mu: 9, r: Infinity }]);
  assert("CRPS rewards the closer forecast", good < bad, `${good} vs ${bad}`);
}

console.log("\n[b] seeded sampling");
{
  const a = mulberry32(42), b = mulberry32(42);
  assert("same seed → same stream", [1, 2, 3].every(() => a() === b()));
  assert("seedFrom is stable", seedFrom("haaland|SUN|home") === seedFrom("haaland|SUN|home") && seedFrom("a") !== seedFrom("b"));
  const rng = mulberry32(7);
  const pois = Array.from({ length: 20000 }, () => sampleCount(2.5, Infinity, rng));
  const nb = Array.from({ length: 20000 }, () => sampleCount(40, 12, rng));
  const nbMean = sum(nb) / nb.length;
  const nbVar = sum(nb.map((x) => (x - nbMean) ** 2)) / nb.length;
  assert("Poisson sampler mean ≈ λ", close(sum(pois) / pois.length, 2.5, 0.05));
  assert("NB sampler mean/var ≈ μ, μ + μ²/r", close(nbMean, 40, 0.5) && close(nbVar, 40 + 1600 / 12, 12), `mean ${nbMean} var ${nbVar}`);
}

console.log("\n[c] roles from FotMob positionId");
{
  const cases = { 11: "GK", 32: "FB", 34: "CB", 37: "CB", 38: "FB", 59: "FB", 62: "FB", 64: "CM", 76: "CM", 78: "FB", 83: "W", 85: "AM", 87: "W", 103: "W", 105: "ST", 115: "ST" };
  const bad = Object.entries(cases).filter(([id, role]) => roleFromPositionId(id) !== role);
  assert("position ids map to roles", bad.length === 0, JSON.stringify(bad));
  assert("unknown id → null", roleFromPositionId(null) === null && roleFromPositionId(0) === null);
}

// ─── Synthetic league ──────────────────────────────────────────────────────
const LINEUP = [
  ["GK", 11, { passes: 25 }], ["CB1", 34, { passes: 60, tackles: 2, clearances: 5 }], ["CB2", 36, { passes: 60, tackles: 2, clearances: 5 }],
  ["FB1", 32, { passes: 40, tackles: 2, clearances: 2, crosses: 2 }], ["FB2", 38, { passes: 40, tackles: 2, clearances: 2, crosses: 2 }],
  ["CM1", 64, { passes: 50, tackles: 2, shots: 1, kp: 1 }], ["CM2", 66, { passes: 50, tackles: 2, shots: 1, kp: 1 }],
  ["AM", 85, { passes: 30, tackles: 1, shots: 2, kp: 2 }], ["W1", 83, { passes: 25, tackles: 1, shots: 2, kp: 1, crosses: 3 }],
  ["W2", 87, { passes: 25, tackles: 1, shots: 2, kp: 1, crosses: 3 }], ["ST", 115, { passes: 15, tackles: 1, shots: 3, kp: 1 }],
];
const ATT = { T1: 2, T2: 1, T3: 1, T4: 1 }; // shot volume produced
const CONC = { T1: 1, T2: 1, T3: 1, T4: 2 }; // shot volume conceded
const FIXTURES = [[1, "T1", "T2"], [1, "T3", "T4"], [2, "T1", "T3"], [2, "T2", "T4"], [3, "T1", "T4"], [3, "T2", "T3"], [4, "T2", "T1"], [4, "T4", "T3"]];

function buildSnapshot() {
  const matches = [];
  const rows = [];
  FIXTURES.forEach(([round, home, away], i) => {
    const id = `m${i}`;
    matches.push({ match_id: id, round, kickoff_utc: `2026-08-${String(10 + i).padStart(2, "0")}T15:00:00Z`, home: { team_id: home, score: 0 }, away: { team_id: away, score: 0 } });
    const teamRows = {};
    for (const [team, opp] of [[home, away], [away, home]]) {
      teamRows[team] = LINEUP.map(([pos, pid, base]) => {
        const shots = (base.shots ?? 0) * ATT[team] * CONC[opp];
        return {
          match_id: id, player_id: `${team}-${pos}`, name: `${team} ${pos}`, team_id: team, gk: pos === "GK",
          started: true, minutes: 90, position_id: pid, usual_position_id: pos === "GK" ? 0 : 2,
          shots, sot: Math.floor(shots / 2), key_passes: base.kp ?? 0, passes_att: base.passes, crosses_att: base.crosses ?? 0,
          dribbles_att: 1, tackles: base.tackles ?? 0, clearances: base.clearances ?? 0, fouls: 1, fouled: 1,
          xg: shots * 0.1, xa: (base.kp ?? 0) * 0.1, goals: 0, assists: 0, yellow_cards: 0, red_cards: 0,
        };
      });
      // One bench player: unused, except 20' off the bench in round 3.
      teamRows[team].push({ match_id: id, player_id: `${team}-SUB`, name: `${team} SUB`, team_id: team, gk: false, started: false,
        minutes: round === 3 ? 20 : 0, usual_position_id: 2, shots: round === 3 ? 1 : null, passes_att: round === 3 ? 10 : null });
    }
    for (const [team, opp] of [[home, away], [away, home]]) {
      const oppSot = sum(teamRows[opp].map((r) => r.sot ?? 0));
      teamRows[team].find((r) => r.gk).saves = oppSot;
      rows.push(...teamRows[team]);
    }
  });
  return { season: "test", matches, player_matches: rows };
}

console.log("\n[d] fitted model on a synthetic league");
const snap = buildSnapshot();
const model = fitModel(snap, { registry: { players: { "T2-ST": { status: "i", chance_next: 0 } } } });
{
  const tf = model.team_factors.shots;
  assert("heavy-shooting team: attack factor > 1", tf.att.T1 > 1.1, JSON.stringify(tf.att));
  assert("…but shrunk below its raw 2× (4 matches)", tf.att.T1 < 1.9, String(tf.att.T1));
  assert("leaky team: concession factor > 1", tf.def.T4 > 1.1, JSON.stringify(tf.def));
  assert("average teams stay near 1", close(tf.att.T3, 1, 0.35) && close(tf.def.T2, 1, 0.35), `${tf.att.T3} ${tf.def.T2}`);
  assert("team total higher vs the leaky side", teamTotal(tf, "T2", "T4", true) > teamTotal(tf, "T2", "T3", true));
  const st = model.players["T3-ST"];
  assert("roles from starts", st.role === "ST" && model.players["T3-CB1"].role === "CB" && model.players["T3-W1"].role === "W");
  assert("sub-only player gets usual-position role", model.players["T3-SUB"].role === "CM");
  assert("striker's shot share > centre-back's", st.shares.shots > model.players["T3-CB1"].shares.shots);
  const subShare = model.players["T3-SUB"].shares.shots;
  assert("20-minute sub's share pulled toward the role prior", subShare < 0.5 && subShare > 0, String(subShare));
  assert("regular starter p_start high, bench player low", st.minutes.p_start > 0.8 && model.players["T3-SUB"].minutes.p_start < 0.3);
}

console.log("\n[e] projection + pricing");
{
  const vsLeaky = projectPlayer(model, { playerId: "T3-ST", opponentTeamId: "T4", venue: "home" });
  const vsNormal = projectPlayer(model, { playerId: "T3-ST", opponentTeamId: "T2", venue: "home" });
  assert("same striker projects more shots vs the leaky defence", vsLeaky.props.shots.per90 > vsNormal.props.shots.per90);
  const pl = priceLine(vsNormal, "shots", 1.5);
  assert("line probabilities sum to 1", close(pl.p_over + pl.p_under + pl.p_push, 1, 1e-3));
  assert("price is conditional on playing (DNP excluded)", pl.p_play < 1 && pl.mean > 0);
  const inj = projectPlayer(model, { playerId: "T2-ST", opponentTeamId: "T3", venue: "away" });
  assert("FPL-injured player: 0% to play", priceLine(inj, "shots", 0.5).p_play === 0);
  const xi = projectPlayer(model, { playerId: "T3-ST", opponentTeamId: "T2", venue: "home", minutes: { started: true } });
  assert("confirmed starter: always plays", close(priceLine(xi, "shots", 1.5).p_play, 1, 1e-9));
  const benched = minutesScenarios(model.players["T3-ST"], { started: false, bench: true });
  assert("confirmed bench: sub or DNP only", benched.every((s) => s.kind === "sub" || s.kind === "dnp"));
  assert("not in squad: DNP", minutesScenarios(model.players["T3-ST"], { started: false, bench: false })[0].kind === "dnp");
  const exact = projectPlayer(model, { playerId: "T3-ST", opponentTeamId: "T2", venue: "home", minutes: { minutes: 45 } });
  assert("exact minutes scale the mean", close(priceLine(exact, "shots", 0.5).mean, exact.props.shots.per90 / 2, 1e-3));
  const up = projectPlayer(model, { playerId: "T3-ST", opponentTeamId: "T2", venue: "home", teamContext: { xg_for: vsNormal.model_xg.for * 1.5, xg_against: vsNormal.model_xg.against } });
  assert("market expecting more goals raises shots", up.props.shots.per90 > vsNormal.props.shots.per90);
  const gk = projectPlayer(model, { playerId: "T3-GK", opponentTeamId: "T1", venue: "home" });
  assert("keeper gets saves/goals conceded only", gk.props.saves && gk.props.goals_conceded && !gk.props.shots);
  assert("outfielder gets no keeper props", !vsNormal.props.saves);
  const gkVsT1 = gk.props.saves.per90, gkVsT2 = projectPlayer(model, { playerId: "T3-GK", opponentTeamId: "T2", venue: "home" }).props.saves.per90;
  assert("keeper projects more saves vs the heavy-shooting side", gkVsT1 > gkVsT2);
}

console.log("\n[f] fantasy simulation");
{
  const proj = projectPlayer(model, { playerId: "T3-AM", opponentTeamId: "T2", venue: "home", minutes: { started: true } });
  const a = simulateFantasy(proj, { sims: 20000 });
  const b = simulateFantasy(proj, { sims: 20000 });
  assert("deterministic (seeded)", a.mean === b.mean && a.probOver(10.5).over === b.probOver(10.5).over);
  const scen = proj.scenarios.filter((s) => s.m > 0);
  const tot = sum(scen.map((s) => s.p));
  const mMin = sum(scen.map((s) => (s.p / tot) * s.m)) / 90;
  const w = FANTASY_WEIGHTS;
  const P = proj.props;
  const analytic = mMin * (w.goals * P.goals.per90 + w.assists * P.assists.per90 + w.shots * P.shots.per90 + w.sot * P.sot.per90 +
    w.passes_att * P.passes_att.per90 + w.key_passes * P.key_passes.per90 + w.clearances * P.clearances.per90 + w.tackles * P.tackles.per90 +
    w.dribbles_att * P.dribbles_att.per90 + w.crosses_att * P.crosses_att.per90 + w.fouls * P.fouls.per90) +
    w.yellow * (1 - Math.exp(-proj.cards.yellow_p90 * mMin)) + w.red * (1 - Math.exp(-proj.cards.red_p90 * mMin));
  assert("simulated mean ≈ analytic mean", close(a.mean, analytic, 0.15), `sim ${a.mean} vs ${analytic.toFixed(3)}`);
  assert("keeper fantasy not modelled → null", simulateFantasy(projectPlayer(model, { playerId: "T3-GK", opponentTeamId: "T1", venue: "home" })) === null);
}

console.log(`\nsmoke-epl-model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
