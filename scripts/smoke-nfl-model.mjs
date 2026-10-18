// Smoke for the NFL player model (api/_lib/nfl/model.js) on a synthetic
// league, plus a sanity pass on the committed artifact.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitModel, simulatePlayer, gameContext, priceLine, teamExpect, buildTeamGames, FANTASY_WEIGHTS } from "../api/_lib/nfl/model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`); };
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// Synthetic league: 4 teams, 6 weeks, round-robin. AAA throws a lot; BBB
// runs a lot. Each team: QB (all attempts), WR1 (high share), WR2, RB.
const teams = ["AAA", "BBB", "CCC", "DDD"];
const games = [], rows = [];
const players = {};
const pid = (t, r) => `${t}-${r}`;
for (const t of teams) for (const [r, pos] of [["QB", "QB"], ["WR1", "WR"], ["WR2", "WR"], ["RB", "RB"]]) players[pid(t, r)] = { name: `${t} ${r}`, position: pos, team: t };
const pairs = [["AAA", "BBB"], ["CCC", "DDD"], ["AAA", "CCC"], ["BBB", "DDD"], ["AAA", "DDD"], ["BBB", "CCC"]];
for (let week = 1; week <= 6; week++) {
  for (const [h, a] of [pairs[(week - 1) % 6], pairs[week % 6]]) {
    const gid = `2026_${String(week).padStart(2, "0")}_${a}_${h}`;
    games.push({ game_id: gid, season: 2026, week, home: h, away: a, home_score: 24, away_score: 20, spread_line: 2, total_line: 44 });
    for (const t of [h, a]) {
      const passAtt = t === "AAA" ? 40 : 30, rushAtt = t === "BBB" ? 34 : 24;
      const opp = t === h ? a : h;
      const base = { season: 2026, week, season_type: "REG", game_id: gid, team: t, opponent: opp };
      const tgt1 = Math.round(passAtt * 0.3), tgt2 = Math.round(passAtt * 0.15), tgtRb = Math.round(passAtt * 0.1);
      rows.push({ ...base, player_id: pid(t, "QB"), pass_att: passAtt, completions: Math.round(passAtt * 0.65), pass_yds: passAtt * 7, pass_td: 2, rush_att: 3, rush_yds: 10, off_pct: 1 });
      rows.push({ ...base, player_id: pid(t, "WR1"), targets: tgt1, rec: Math.round(tgt1 * 0.65), rec_yds: Math.round(tgt1 * 0.65) * 13, off_pct: 0.95 });
      rows.push({ ...base, player_id: pid(t, "WR2"), targets: tgt2, rec: Math.round(tgt2 * 0.6), rec_yds: Math.round(tgt2 * 0.6) * 11, off_pct: 0.7 });
      rows.push({ ...base, player_id: pid(t, "RB"), targets: tgtRb, rec: Math.round(tgtRb * 0.8), rec_yds: Math.round(tgtRb * 0.8) * 7, rush_att: rushAtt - 3, rush_yds: (rushAtt - 3) * 4.4, rush_td: 1, off_pct: 0.65 });
    }
  }
}
const snap = { rows, games, players };

const tg = buildTeamGames(rows, new Map(games.map((g) => [g.game_id, g])));
check("team-games built with market context", tg.length === 24 && tg.every((t) => t.total === 44));
const m = fitModel(snap);
check("fit covers every player", Object.keys(m.players).length === 16);
const ctx = (t, o) => gameContext({ team: t, opp: o, spreadLineHome: 0, total: 44, home: true });
const aaa = teamExpect(m, "pass_att", ctx("AAA", "DDD"));
const ccc = teamExpect(m, "pass_att", ctx("CCC", "DDD"));
check("team effect: pass-heavy AAA projects more attempts", aaa.mean > ccc.mean + 3, `${aaa.mean.toFixed(1)} vs ${ccc.mean.toFixed(1)}`);
check("team σ is post-effect (≈0 on a noiseless league)", aaa.sigma < 2, `${aaa.sigma}`);
const w1 = m.players[pid("AAA", "WR1")], w2 = m.players[pid("AAA", "WR2")];
check("share: WR1 above WR2", w1.tgtShare > w2.tgtShare);
// Share is of TEAM TARGETS: WR1 12 of 22 → 0.545 observed, lightly shrunk.
check("share: shrunk toward the role prior, near the observed 0.545", w1.tgtShare > 0.45 && w1.tgtShare < 0.545, `${w1.tgtShare}`);
check("QB starter share near 1", near(m.players[pid("AAA", "QB")].attShareStart, 1, 0.05));
check("efficiency: WR1 yards per catch near 13", near(w1.ypr, 13, 1.5), `${w1.ypr}`);

const sim = simulatePlayer(m, pid("AAA", "WR1"), ctx("AAA", "DDD"), { sims: 6000 });
check("sim: receptions ≤ targets on every draw", sim.draws.rec.every((r, i) => r <= sim.draws.targets[i]));
check("sim: Rush+Rec yards = rush + rec per draw", sim.draws.rush_rec_yds.every((v, i) => v === sim.draws.rush_yds[i] + sim.draws.rec_yds[i]));
check("sim: mean receptions ≈ 40×share×0.95×catch", near(sim.mean.rec, aaa.mean * 0.95 * w1.tgtShare * w1.catch, 0.4), `${sim.mean.rec.toFixed(2)}`);
check("sim: yards right-skewed (median < mean)", sim.median.rec_yds < sim.mean.rec_yds);
const again = simulatePlayer(m, pid("AAA", "WR1"), ctx("AAA", "DDD"), { sims: 6000 });
check("sim: seeded + reproducible", again.mean.rec_yds === sim.mean.rec_yds);
const W = FANTASY_WEIGHTS;
const qb = simulatePlayer(m, pid("AAA", "QB"), ctx("AAA", "DDD"), { sims: 3000 });
const i0 = qb.draws.fantasy.findIndex((_, i) => qb.draws.pass_yds[i] > 0);
const fant = W.pass_yds * qb.draws.pass_yds[i0] + W.pass_td * qb.draws.pass_td[i0] + W.pass_int * qb.draws.pass_int[i0] + W.rush_yds * qb.draws.rush_yds[i0];
check("sim: fantasy follows the PrizePicks weights", Math.abs(qb.draws.fantasy[i0] - fant) <= 1.01 + 6 * (qb.draws.rush_rec_td[i0]));
const pl = priceLine(sim, "rec_yds", 50.5);
check("priceLine: probabilities sum to 1, no push on .5", near(pl.over + pl.under + pl.push, 1, 1e-9) && pl.push === 0);
check("priceLine: unknown stat → null", priceLine(sim, "kicking_pts", 5.5) === null);
check("simulatePlayer: unknown player → null", simulatePlayer(m, "nope", ctx("AAA", "DDD")) === null);
const higher = gameContext({ team: "AAA", opp: "DDD", spreadLineHome: 0, total: 54, home: true });
check("market: higher total lifts implied points", higher.implied > ctx("AAA", "DDD").implied);

const asOf = fitModel(snap, { asOf: { season: 2026, week: 4 } });
check("asOf: fits only on earlier weeks", asOf.fitted_on === 12 && asOf.lastWeek === 3);

// Committed artifact sanity.
const art = path.join(ROOT, "data/nfl-model.json");
if (fs.existsSync(art)) {
  const a = JSON.parse(fs.readFileSync(art, "utf8"));
  check("artifact: fitted with players + team effects", Object.keys(a.players).length > 1000 && a.team.pass_att && a.team.rush_att);
  const starters = Object.values(a.players).filter((p) => p.pos === "QB" && p.starts >= 2);
  // Refit on the real snapshot: team effects must survive the EB shrink.
  // A noise term of σ²/Σw (decayed weights < 1) floored τ² and zeroed every
  // team effect (k ~ 7e7) until 2026-10-18; the real between-team spread
  // in pass attempts after spread/total is ~±2.5.
  const read = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", n), "utf8"));
  const real = fitModel({ rows: read("nfl-player-games.json").rows, games: read("nfl-games.json").games, players: read("nfl-players.json").players });
  const offs = Object.values(real.team.pass_att.off);
  check("real data: pass_att team effects survive shrinkage", real.team.pass_att.k < 100 && Math.max(...offs) - Math.min(...offs) > 2, `k=${real.team.pass_att.k.toPrecision(3)}`);
  check("artifact: starting QBs throw ~all team attempts", starters.length > 20 && starters.every((p) => p.attShareStart > 0.85), `${starters.length} starters`);
} else {
  console.log("SKIP  artifact checks (run npm run build-nfl-model)");
}

console.log(`\nsmoke-nfl-model: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
