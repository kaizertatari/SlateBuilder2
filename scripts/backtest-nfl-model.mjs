// Walk-forward backtest of the NFL model (step 2). For each target week the
// model is refit on games strictly BEFORE it, then prices every player who
// played that week at a synthetic line — the player's own prior weighted mean
// rounded to the half-point (≈ where a book or PrizePicks posts it; no
// historical PrizePicks lines exist). Compared against two baselines that use
// the same prior games:
//   empirical  Laplace-smoothed share of the player's prior games over the line
//   normal     Normal(prior mean, prior sd), the basketball engine's approach
// Reports log loss + Brier per stat, a reliability table, and sd/mean of the
// PIT-style z so σ sizing is visible. Prices are conditional on playing.
//
// Usage: npm run backtest-nfl-model [-- --weeks 2026:3-6 --sims 4000]
//        [-- --params '{"weekDecay":0.85}']   override NFL_MODEL_PARAMS for a sweep

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitModel, simulatePlayer, gameContext, priceLine, NFL_MODEL_PARAMS } from "../api/_lib/nfl/model.js";
import { scoreProbs, reliability } from "../api/_lib/epl/grading.js";
import { normCdf } from "../api/_lib/distributions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [wSeason, wRange] = arg("--weeks", "2026:3-6").split(":");
const [w0, w1] = wRange.split("-").map(Number);
const SIMS = Number(arg("--sims", 4000));
const PARAMS = { ...NFL_MODEL_PARAMS, ...JSON.parse(arg("--params", "{}")) };

const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
const snap = { rows: j("nfl-player-games.json").rows, games: j("nfl-games.json").games, players: j("nfl-players.json").players };
const gamesById = new Map(snap.games.map((g) => [g.game_id, g]));

// Stat → which positions it is evaluated for, and the minimum prior mean
// for a line to exist (books don't post receptions for a 0.4-catch TE).
const EVAL = {
  pass_yds: { pos: ["QB"], min: 120 }, pass_att: { pos: ["QB"], min: 18 }, completions: { pos: ["QB"], min: 12 },
  pass_td: { pos: ["QB"], min: 0.8 },
  rush_yds: { pos: ["RB", "QB"], min: 15 }, rush_att: { pos: ["RB"], min: 6 },
  rec: { pos: ["WR", "TE", "RB"], min: 1.5 }, rec_yds: { pos: ["WR", "TE", "RB"], min: 15 },
  rush_rec_yds: { pos: ["RB"], min: 30 }, fantasy: { pos: ["QB", "RB", "WR", "TE"], min: 5 },
};
const FANT = (r) => 0.04 * (r.pass_yds ?? 0) + 4 * (r.pass_td ?? 0) - (r.pass_int ?? 0) + 0.1 * (r.rush_yds ?? 0) + 6 * (r.rush_td ?? 0) + (r.rec ?? 0) + 0.1 * (r.rec_yds ?? 0) + 6 * (r.rec_td ?? 0);
const actualOf = (r, stat) => stat === "rush_rec_yds" ? (r.rush_yds ?? 0) + (r.rec_yds ?? 0) : stat === "fantasy" ? FANT(r) : (r[stat] ?? 0);
// PrizePicks voids only a DNP, so any game with real snaps counts.
const played = (r) => (r.off_pct ?? 0) > 0.05;

const before = (r, s, w) => r.season < s || (r.season === s && r.week < w);
const results = {};
const add = (stat, src, p, y) => { ((results[stat] ??= {})[src] ??= { p: [], y: [] }); results[stat][src].p.push(Math.min(0.99, Math.max(0.01, p))); results[stat][src].y.push(y); };
const zs = {};

const t0 = Date.now();
for (let week = w0; week <= w1; week++) {
  const season = Number(wSeason);
  const model = fitModel(snap, { asOf: { season, week }, params: PARAMS });
  const targets = snap.rows.filter((r) => r.season === season && r.week === week && r.season_type === "REG" && played(r));
  // Prior games per player (this season first, last season to fill), most recent 8.
  const prior = new Map();
  for (const r of snap.rows) if (before(r, season, week) && played(r)) (prior.get(r.player_id) ?? prior.set(r.player_id, []).get(r.player_id)).push(r);
  let n = 0;
  for (const r of targets) {
    const pos = snap.players[r.player_id]?.position;
    const hist = (prior.get(r.player_id) ?? []).sort((a, b) => b.season - a.season || b.week - a.week).slice(0, 8);
    if (hist.filter((h) => h.season === season).length < 2) continue;
    const g = gamesById.get(r.game_id);
    if (!g || g.total_line == null) continue;
    const ctx = gameContext({ team: r.team, opp: r.opponent, spreadLineHome: g.spread_line, total: g.total_line, home: g.home === r.team });
    let sim = null;
    for (const [stat, e] of Object.entries(EVAL)) {
      if (!e.pos.includes(pos)) continue;
      const hv = hist.map((h) => actualOf(h, stat));
      const m = hv.reduce((a, b) => a + b, 0) / hv.length;
      if (m < e.min) continue;
      const line = Math.floor(m) + 0.5;
      sim ??= simulatePlayer(model, r.player_id, ctx, { sims: SIMS });
      if (!sim) break;
      const pr = priceLine(sim, stat, line);
      if (!pr) continue;
      const y = actualOf(r, stat) > line ? 1 : 0;
      const pOver = pr.over / Math.max(1e-9, pr.over + pr.under);
      add(stat, "model", pOver, y);
      add(stat, "empirical", (hv.filter((v) => v > line).length + 1) / (hv.length + 2), y);
      const sd = Math.sqrt(hv.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, hv.length - 1)) || 1;
      add(stat, "normal", 1 - normCdf((line - m) / sd), y);
      // σ sizing for the model: z of the actual vs the simulated mean/sd.
      const d = sim.draws[stat];
      const mu = sim.mean[stat];
      const sdSim = Math.sqrt(d.reduce((a, v) => a + (v - mu) ** 2, 0) / d.length) || 1;
      (zs[stat] ??= []).push((actualOf(r, stat) - mu) / sdSim);
      n++;
    }
  }
  console.log(`week ${season}-${week}: fit on ${model.fitted_on} team-games, ${n} priced line-sides`);
}

console.log(`\nWalk-forward ${wSeason} weeks ${w0}–${w1}, ${SIMS} sims/player, ${((Date.now() - t0) / 1000).toFixed(0)}s. Log loss (lower = better; coin flip 0.693):`);
console.log(`  ${"stat".padEnd(14)} ${"n".padStart(5)}   model    empirical  normal   | z sd   z mean`);
const tot = { model: { p: [], y: [] }, empirical: { p: [], y: [] }, normal: { p: [], y: [] } };
for (const [stat, srcs] of Object.entries(results)) {
  const sc = Object.fromEntries(Object.entries(srcs).map(([k, v]) => [k, scoreProbs(v.p, v.y)]));
  for (const k of Object.keys(tot)) { tot[k].p.push(...srcs[k].p); tot[k].y.push(...srcs[k].y); }
  const z = zs[stat]; const zm = z.reduce((a, b) => a + b, 0) / z.length; const zsd = Math.sqrt(z.reduce((a, b) => a + (b - zm) ** 2, 0) / z.length);
  console.log(`  ${stat.padEnd(14)} ${String(sc.model.n).padStart(5)}   ${sc.model.logloss.toFixed(4)}   ${sc.empirical.logloss.toFixed(4)}     ${sc.normal.logloss.toFixed(4)}   | ${zsd.toFixed(2)}   ${zm >= 0 ? " " : ""}${zm.toFixed(2)}`);
}
const T = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, scoreProbs(v.p, v.y)]));
console.log(`  ${"ALL".padEnd(14)} ${String(T.model.n).padStart(5)}   ${T.model.logloss.toFixed(4)}   ${T.empirical.logloss.toFixed(4)}     ${T.normal.logloss.toFixed(4)}   Brier ${T.model.brier.toFixed(4)} / ${T.empirical.brier.toFixed(4)} / ${T.normal.brier.toFixed(4)}`);
console.log("\nReliability — model P(over), all stats:");
for (const b of reliability(tot.model.p, tot.model.y, [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001])) console.log(`  ${b.range.padEnd(9)} n=${String(b.n).padStart(5)}  predicted ${(b.predicted * 100).toFixed(1)}%  realized ${(b.realized * 100).toFixed(1)}%`);
