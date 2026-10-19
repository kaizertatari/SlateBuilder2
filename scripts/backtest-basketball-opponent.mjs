// Walk-forward backtest of the basketball opponent-factor model
// (api/_lib/basketball/opponent.js). Refit every --step days on games
// strictly before the window, predict every player-game in it (conditioned
// on ACTUAL minutes — grades the opponent/pace adjustment, not minutes), and
// score four nested layers on identical rows:
//   base   player rate × minutes          (no opponent, no pace)
//   pace   + predicted game pace
//   team   + defense's team-level factor
//   pos    + defense × position-group factor
// Metrics per stat: MSE of the mean, and log loss of P(over) at a synthetic
// line = the half-point nearest the BASE mean (≈ where a book posts it), with
// a negative binomial whose dispersion is fit per stat on last season.
// Reported overall and by how far into the season the game is (team games).
//
// NBA uses last season as the prior (team factors + player rates); WNBA has
// no carry-over.
//
// Usage: node scripts/backtest-basketball-opponent.mjs [--league NBA] [--season 2025-26]
//        [--step 7] [--min 10] [--params '{"kTeam":15,"kPos":40}'] [--grid]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitOpponentModel, projectOpp, OPP_PARAMS, COMBOS } from "../api/_lib/basketball/opponent.js";
import { statOf } from "../api/_lib/basketball/gamelogs.js";
import { lineProbs } from "../api/_lib/distributions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LEAGUE = arg("--league", "NBA").toUpperCase();
const SEASON = arg("--season", LEAGUE === "WNBA" ? "2026" : "2025-26");
const STEP = Number(arg("--step", 7));
const MIN_MIN = Number(arg("--min", 10));
const PARAMS = { ...OPP_PARAMS, ...JSON.parse(arg("--params", "{}")) };
const GRID = args.includes("--grid");
const LAYERS = ["base", "pace", "team", "pos"];
const EVAL_STATS = ["pts", "reb", "ast", "fg3m", "stl", "blk", "tov", "pra", "pr", "pa", "ra"];

const load = (season) => {
  const f = path.join(ROOT, "data", "basketball", `${LEAGUE.toLowerCase()}-${season}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const priorLabel = (s) => { const y = parseInt(s, 10); return LEAGUE === "WNBA" ? String(y - 1) : `${y - 1}-${String(y % 100).padStart(2, "0")}`; };
const valueOf = (r, s) => (COMBOS[s] ? COMBOS[s].reduce((a, p) => a + statOf(r, p), 0) : statOf(r, s));
const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

const cur = load(SEASON);
if (!cur) throw new Error(`no snapshot for ${LEAGUE} ${SEASON}`);
const priorSnap = LEAGUE === "NBA" ? load(priorLabel(SEASON)) : null;

// NB dispersion per stat from last season's in-sample base residuals
// (var = μ + μ²/r); falls back to the current season's first month.
function fitDispersion(snap, model) {
  const tg = new Map(snap.team_games.map((t) => [`${t.game_id}|${t.team}`, t]));
  const r = {};
  for (const s of EVAL_STATS) {
    let num = 0, den = 0;
    for (const row of snap.rows) {
      if (statOf(row, "min") < MIN_MIN) continue;
      const t = tg.get(`${row.game_id}|${row.team}`);
      const p = projectOpp(model, { playerId: row.player_id, team: t.team, opponent: t.opponent, minutes: row.min }, "base");
      if (!p) continue;
      const mu = p[s], y = valueOf(row, s);
      num += mu * mu; den += (y - mu) ** 2 - mu;
    }
    r[s] = den > 0 ? Math.max(1, num / den) : 1e6;
  }
  return r;
}

function run(params) {
  const priorModel = priorSnap ? fitOpponentModel(priorSnap, { params }) : null;
  const dispSnap = priorSnap ?? cur;
  const disp = fitDispersion(dispSnap, priorModel ?? fitOpponentModel(cur, { params }));
  const tg = new Map(cur.team_games.map((t) => [`${t.game_id}|${t.team}`, t]));
  const dates = [...new Set(cur.team_games.map((t) => t.date))].sort();
  const teamGameNo = new Map(); // game|team → nth game for the defense
  const cnt = {};
  for (const t of [...cur.team_games].sort((a, b) => a.date.localeCompare(b.date))) { cnt[t.opponent] = (cnt[t.opponent] ?? 0) + 1; teamGameNo.set(`${t.game_id}|${t.team}`, cnt[t.opponent]); }
  const score = {}; // phase → stat → layer → { n, se, ll }
  const add = (phase, s, layer, se, ll) => { const a = (((score[phase] ??= {})[s] ??= {})[layer] ??= { n: 0, se: 0, ll: 0 }); a.n++; a.se += se; a.ll += ll; };
  for (let d0 = dates[0]; d0 <= dates.at(-1); d0 = addDays(d0, STEP)) {
    const d1 = addDays(d0, STEP);
    const model = fitOpponentModel(cur, { before: d0, prior: priorModel, params });
    for (const row of cur.rows) {
      const t = tg.get(`${row.game_id}|${row.team}`);
      if (!t || t.date < d0 || t.date >= d1 || statOf(row, "min") < MIN_MIN) continue;
      const n = teamGameNo.get(`${row.game_id}|${row.team}`);
      const phase = n <= 10 ? "games 1–10" : n <= 25 ? "games 11–25" : "games 26+";
      const proj = Object.fromEntries(LAYERS.map((L) => [L, projectOpp(model, { playerId: row.player_id, team: t.team, opponent: t.opponent, minutes: row.min }, L)]));
      if (!proj.base) continue;
      for (const s of EVAL_STATS) {
        const y = valueOf(row, s);
        const line = Math.max(0.5, Math.round(proj.base[s] - 0.5) + 0.5);
        for (const L of LAYERS) {
          const mu = Math.max(1e-3, proj[L][s]);
          const pOver = clampP(lineProbs(line, mu, disp[s]).over);
          const ll = -(y > line ? Math.log(pOver) : Math.log(1 - pOver));
          for (const ph of [phase, "ALL"]) add(ph, s, L, (mu - y) ** 2, ll);
        }
      }
    }
  }
  return score;
}

function report(score, title) {
  console.log(`\n${title}`);
  for (const phase of ["ALL", "games 1–10", "games 11–25", "games 26+"]) {
    const S = score[phase]; if (!S) continue;
    console.log(`\n  ${phase} — MSE / log loss per layer (lower = better); Δ = pos vs base`);
    console.log("  stat        n      base          pace          team          pos         ΔMSE%   ΔLL");
    for (const s of EVAL_STATS) {
      const a = S[s]; if (!a) continue;
      const cell = (L) => `${(a[L].se / a[L].n).toFixed(2).padStart(6)}/${(a[L].ll / a[L].n).toFixed(4)}`;
      const dm = 100 * (a.pos.se / a.base.se - 1), dl = (a.pos.ll - a.base.ll) / a.base.n;
      console.log(`  ${s.padEnd(6)} ${String(a.base.n).padStart(6)}  ${LAYERS.map(cell).join("  ")}  ${(dm >= 0 ? "+" : "") + dm.toFixed(1).padStart(5)}  ${(dl >= 0 ? "+" : "") + dl.toFixed(4)}`);
    }
  }
}

const t0 = Date.now();
if (GRID) {
  console.log(`grid over kTeam × kPos (${LEAGUE} ${SEASON}): mean log loss over all stats, layer "pos" (and "team" for kPos-independent reference)`);
  for (const kTeam of [5, 10, 15, 25, 40]) {
    const cells = [];
    for (const kPos of [10, 25, 50, 100, 1e9]) {
      const sc = run({ ...PARAMS, kTeam, kPos }).ALL;
      const ll = (L) => EVAL_STATS.reduce((a, s) => a + sc[s][L].ll / sc[s][L].n, 0) / EVAL_STATS.length;
      cells.push(`kPos=${kPos === 1e9 ? "∞" : kPos}: ${ll("pos").toFixed(5)}`);
      if (kPos === 10) cells.unshift(`base ${ll("base").toFixed(5)} pace ${ll("pace").toFixed(5)} team ${ll("team").toFixed(5)} |`);
    }
    console.log(`kTeam=${String(kTeam).padStart(2)}  ${cells.join("  ")}`);
  }
} else {
  report(run(PARAMS), `Walk-forward ${LEAGUE} ${SEASON} (refit every ${STEP} days, players ≥ ${MIN_MIN} min, prior ${priorSnap ? priorLabel(SEASON) : "none"}); kTeam ${PARAMS.kTeam}, kPos ${Number.isFinite(PARAMS.kPos) ? PARAMS.kPos : "off"}, priorTeamWeight ${PARAMS.priorTeamWeight}`);
}
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
