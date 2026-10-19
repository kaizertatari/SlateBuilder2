// Smoke for the basketball opponent-factor model (api/_lib/basketball/opponent.js)
// on a synthetic league. No network.
//   node scripts/smoke-basketball-opponent.mjs
import { fitOpponentModel, projectOpp, opponentFactor, compactModel, OPP_PARAMS } from "../api/_lib/basketball/opponent.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// 4 teams, double round-robin × 5 (30 games each). Every player scores
// 0.5 pts/min and grabs 0.2 reb/min — except against DDD, which allows 30%
// more points (rebounds unchanged). AAA plays fast (110 possessions vs 95).
const teams = ["AAA", "BBB", "CCC", "DDD"];
const players = {};
teams.forEach((t, i) => { players[10 * i + 1] = { name: `${t} G`, position: "G", group: "G" }; players[10 * i + 2] = { name: `${t} C`, position: "C", group: "B" }; });
const team_games = [], rows = [];
let gid = 0, day = 0;
for (let rep = 0; rep < 5; rep++) for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
  if (a === b) continue;
  gid++; day++;
  const date = new Date(Date.UTC(2026, 0, 1) + day * 864e5).toISOString().slice(0, 10);
  const id = String(gid).padStart(4, "0");
  const poss = teams[a] === "AAA" || teams[b] === "AAA" ? 110 : 95;
  for (const [t, o, home] of [[teams[a], teams[b], true], [teams[b], teams[a], false]]) {
    const mult = (o === "DDD" ? 1.3 : 1) * poss / 95;
    team_games.push({ game_id: id, date, team: t, opponent: o, home, poss, pts: 0 });
    for (const pid of [10 * teams.indexOf(t) + 1, 10 * teams.indexOf(t) + 2]) {
      rows.push({ player_id: pid, game_id: id, team: t, min: 30, pts: Math.round(15 * mult), reb: Math.round(6 * poss / 95) });
    }
  }
}
const snap = { players, team_games, rows };
const m = fitOpponentModel(snap);

// A) Team factors recover the generous defense, and only it
ok(m.team.DDD.pts > 1.12, `A: DDD allows more points (factor ${m.team.DDD.pts.toFixed(3)})`);
ok(["AAA", "BBB", "CCC"].every((d) => m.team[d].pts < 1), "A: the other defenses sit below 1 on points");
ok(Math.abs(m.team.DDD.reb - 1) < 0.05, `A: DDD rebound factor ≈ 1 (${m.team.DDD.reb.toFixed(3)})`);
// B) Pace: AAA's games run faster
ok(m.pace.AAA > m.pace.BBB, "B: AAA pace above BBB");
const vsAAA = projectOpp(m, { playerId: 21, team: "CCC", opponent: "AAA", minutes: 30 }, "pace");
const vsBBB = projectOpp(m, { playerId: 21, team: "CCC", opponent: "BBB", minutes: 30 }, "pace");
ok(vsAAA.reb > vsBBB.reb, "B: facing the fast team projects more rebounds");
// C) Layers nest; position layer off by default; combos sum
const base = projectOpp(m, { playerId: 21, team: "CCC", opponent: "DDD", minutes: 30 }, "base");
const tm = projectOpp(m, { playerId: 21, team: "CCC", opponent: "DDD", minutes: 30 }, "team");
const ps = projectOpp(m, { playerId: 21, team: "CCC", opponent: "DDD", minutes: 30 }, "pos");
ok(tm.pts > base.pts * 1.1, "C: team layer lifts points vs DDD");
ok(OPP_PARAMS.kPos === Infinity && Math.abs(ps.pts - tm.pts) < 1e-9, "C: position layer off by default (pos == team)");
ok(Math.abs(tm.pra - (tm.pts + tm.reb + tm.ast)) < 1e-9 && Math.abs(tm.pr - (tm.pts + tm.reb)) < 1e-9, "C: combos are sums");
// D) Walk-forward: nothing after `before` leaks in
const early = fitOpponentModel(snap, { before: team_games[0].date });
ok(Object.keys(early.team).length === 0 && Object.keys(early.rates).length === 0, "D: before the first game → empty fit");
const mid = fitOpponentModel(snap, { before: "2026-02-15" });
ok(Object.values(mid.games).every((g) => g < 30), "D: mid-season fit counts only earlier games");
// E) Shrinkage: few games → factor near the prior
const two = fitOpponentModel({ ...snap, team_games: team_games.slice(0, 24), rows: rows.slice(0, 48) });
ok(Math.abs((two.team.DDD?.pts ?? 1) - 1) < Math.abs(m.team.DDD.pts - 1), "E: early factor shrunk harder than full-season");
// F) Unknown player falls back to the group rate; unknown everything → null
ok(projectOpp(m, { playerId: 999, team: "CCC", opponent: "DDD", minutes: 30, group: "G" })?.pts > 0, "F: unknown player uses group rate");
ok(projectOpp(m, { playerId: 999, team: "CCC", opponent: "DDD", minutes: 30, group: "Z" }) === null, "F: unknown group → null");

// G) Shadow factor per PrizePicks prop + the runtime artifact
{
  const f = opponentFactor(m, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Points OVER" });
  ok(f && f.opp_factor > 1.1 && Math.abs(f.opp_factor - m.team.DDD.pts) < 1e-3, `G: Points factor = DDD points factor (${f?.opp_factor})`);
  const reb = opponentFactor(m, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Rebounds" });
  const pr = opponentFactor(m, { playerId: 21, team: "CCC", opponent: "DDD", prop: "PR UNDER" });
  ok(pr.opp_factor > reb.opp_factor && pr.opp_factor < f.opp_factor, "G: PR factor sits between its parts, weighted by the player's mix");
  ok(opponentFactor(m, { playerId: 21, team: "CCC", opponent: "AAA", prop: "Rebounds" }).pace_factor > 1, "G: pace factor > 1 vs the fast team");
  ok(opponentFactor(m, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Fantasy Score" })?.opp_factor > 1, "G: Fantasy Score priced from weighted stats");
  ok(opponentFactor(m, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Shots" }) === null, "G: unknown prop → null");
  const c = compactModel(m, { league: "TEST" });
  const fc = opponentFactor(c, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Points" });
  ok(c.league === "TEST" && !("pos" in c) && Math.abs(fc.opp_factor - f.opp_factor) < 1e-3, "G: compact artifact reproduces the factor");
  // Preseason: empty current season → the prior's defenses carry over at weight 0
  const pre = fitOpponentModel({ players: {}, team_games: [], rows: [] }, { prior: m });
  ok(Object.keys(pre.team).length === 4 && pre.games.DDD === 0 && pre.team.DDD.pts > 1 && pre.team.DDD.pts < m.team.DDD.pts, "G: preseason fit = shrunk prior for every defense");
  ok(opponentFactor(pre, { playerId: 21, team: "CCC", opponent: "DDD", prop: "Points" }).weight === 0, "G: preseason weight 0");
}
// H) Runtime wrapper never throws and stays out of non-basketball leagues
{
  const { getOppFactor } = await import("../api/_lib/basketball/opp-store.js");
  ok(await getOppFactor({ league: "EPL", playerId: 1, team: "ARS", opponent: "CHE", propType: "Shots" }) === null, "H: EPL → null");
  ok(await getOppFactor({ league: "NBA", playerId: 1, team: null, opponent: null, propType: "Points" }) === null, "H: no opponent → null, no throw");
  ok(await getOppFactor({ league: "NBA", playerId: 1, team: "BOS", opponent: "DET", propType: "Curling" }) === null, "H: unknown prop → null");
}

console.log(`\nsmoke-basketball-opponent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
