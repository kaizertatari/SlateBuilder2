// Walk-forward backtest of the basketball predictive distribution
// (api/_lib/basketball/dist.js) against the engine's current approach.
// Every prediction uses PREDICTED minutes (recency-weighted recent games) —
// live picks don't know minutes — and only data from before the game.
//
// Methods (P(over) at each line):
//   engine   Normal(engine-style mean, the engine's fixed σ per stat —
//            projection.js sigmaFor); engine-style mean = ½ last-5 average
//            + ½ season-to-date average (an approximation of the engine's
//            blended baseline)
//   eng-nb   NB(engine-style mean, r fitted on last season)
//   opp-nb   NB(opponent-model mean at predicted minutes, r fitted)
//   eng×opp  NB(engine-style mean × opponent/pace factor, r fitted) — recency
//            mean from the engine, matchup from the opponent model
//   calibrated  eng×opp with the mean × per-stat c = Σy/Σμ fitted on last
//            season and r refit around it
//   opp-mix  NB mixture over the player's recent minutes, r fitted on
//            last season at ACTUAL minutes (per-minute noise only; the
//            mixture adds the minutes uncertainty)
//
// Lines per player-game and stat: "main" = the half-point nearest the
// engine-style mean (≈ where PrizePicks posts), "low" ≈ 0.7× and "high" ≈
// 1.3× of it (goblin/demon-like) — tails matter as much as the middle.
// Dispersions are fitted on the PRIOR season and frozen while scoring.
//
// Usage: node scripts/backtest-basketball-dist.mjs [--league NBA] [--season 2025-26] [--step 7]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitOpponentModel } from "../api/_lib/basketball/opponent.js";
import { PROP_KEY, DIST_KEYS, valueOf, meanAt, probOver, fitDispersion, walkSeason, engineMean, matchupRatio, fitDistParams } from "../api/_lib/basketball/dist.js";
import { lineProbs } from "../api/_lib/distributions.js";
import { sigmaFor, normCdf } from "../api/_lib/projection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LEAGUE = arg("--league", "NBA").toUpperCase();
const SEASON = arg("--season", LEAGUE === "WNBA" ? "2026" : "2025-26");
const STEP = Number(arg("--step", 7));
const METHODS = ["engine", "eng-nb", "eng×opp", "calibrated", "opp-mix"];
const KEY_PROP = Object.fromEntries(Object.entries(PROP_KEY).map(([p, k]) => [k, p]));

const prevLabel = (s) => { const y = parseInt(s, 10); return LEAGUE === "WNBA" ? String(y - 1) : `${y - 1}-${String(y % 100).padStart(2, "0")}`; };
const load = (s) => { const f = path.join(ROOT, "data", "basketball", `${LEAGUE.toLowerCase()}-${s}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };
const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const half = (x) => Math.max(0.5, Math.round(x - 0.5) + 0.5);

// ── Fit on the prior season (production code path: dist.js fitDistParams) ──
const cur = load(SEASON);
if (!cur) throw new Error(`no snapshot for ${LEAGUE} ${SEASON}`);
const prevSnap = load(prevLabel(SEASON));
if (!prevSnap) throw new Error(`need ${prevLabel(SEASON)} to fit dispersions`);
const t0 = Date.now();
const LIB = fitDistParams(prevSnap, { step: STEP });
const C = LIB.c;
const R = { eng: LIB.r_eng, cal: LIB.r, engopp: {}, cond: {} };
// Diagnostic-only dispersions: eng×opp before calibration, and per-minute
// noise at ACTUAL minutes for the opp-mix mixture.
const factorOf = (x, key) => matchupRatio(x.model, x.ctx, key, x.minutes.mean);
const pairs = { engopp: {}, cond: {} };
for (const x of walkSeason(prevSnap, { step: STEP })) {
  for (const key of DIST_KEYS) {
    const y = valueOf(x.r, key);
    (pairs.engopp[key] ??= []).push({ mu: Math.max(1e-3, engineMean(x.h, key) * factorOf(x, key)), y });
    const mc = meanAt(x.model, x.ctx, key, x.r.min); if (mc != null) (pairs.cond[key] ??= []).push({ mu: Math.max(1e-3, mc), y });
  }
}
for (const k of DIST_KEYS) { R.engopp[k] = fitDispersion(pairs.engopp[k] ?? []); R.cond[k] = fitDispersion(pairs.cond[k] ?? []); }
console.log(`Fitted on ${LEAGUE} ${prevLabel(SEASON)} — mean calibration c and NB dispersion r (larger r = tighter; var = μ + μ²/r):`);
for (const k of DIST_KEYS) console.log(`  ${KEY_PROP[k].padEnd(21)} c ${C[k].toFixed(3)}   r: engine-mean ${R.eng[k].toFixed(1).padStart(6)}  calibrated ${R.cal[k].toFixed(1).padStart(6)}  at actual minutes ${R.cond[k].toFixed(1).padStart(9)}`);

// ── Score the current season ───────────────────────────────────────────────
const sc = {}; // key → lineType → method → { n, ll }
const rel = { engine: {}, "eng×opp": {}, calibrated: {} };
const bias = {};
const add = (k, lt, m, p, over) => { const a = (((sc[k] ??= {})[lt] ??= {})[m] ??= { n: 0, ll: 0 }); a.n++; a.ll += -(over ? Math.log(clampP(p)) : Math.log(1 - clampP(p))); };
let nRows = 0;
const priorFit = LEAGUE === "NBA" ? fitOpponentModel(prevSnap) : null;
for (const x of walkSeason(cur, { priorModel: priorFit, step: STEP })) {
  nRows++;
  for (const key of DIST_KEYS) {
    const em = engineMean(x.h, key);
    if (!(em > 0.3)) continue;
    const y = valueOf(x.r, key);
    const sigma = sigmaFor(KEY_PROP[key], LEAGUE, null);
    const eo = em * factorOf(x, key), om = meanAt(x.model, x.ctx, key, x.minutes.mean);
    const b = (bias[key] ??= { n: 0, e: 0, eo: 0, o: 0, y: 0 });
    b.n++; b.e += em; b.eo += eo; b.o += om ?? em; b.y += y;
    for (const [lt, mult] of [["main", 1], ["low", 0.7], ["high", 1.3]]) {
      const line = half(em * mult);
      if (lt !== "main" && line === half(em)) continue;
      const over = y > line ? 1 : 0;
      const p = {
        engine: sigma ? Math.min(0.99, Math.max(0.01, normCdf((em - line) / sigma))) : null,
        "eng-nb": lineProbs(line, Math.max(1e-3, em), R.eng[key]).over,
        "eng×opp": lineProbs(line, Math.max(1e-3, eo), R.engopp[key]).over,
        "calibrated": lineProbs(line, Math.max(1e-3, eo * C[key]), R.cal[key]).over,
        "opp-mix": probOver({ model: x.model, ctx: x.ctx, key, line, minutes: x.minutes, r: R.cond[key], shape: "nbmix" }),
      };
      if (METHODS.some((m) => p[m] == null)) continue;
      for (const m of METHODS) { add(key, lt, m, p[m], over); add("ALL", lt, m, p[m], over); }
      for (const m of ["engine", "eng×opp", "calibrated"]) { const b = Math.min(9, Math.floor(p[m] * 10)); const a = (rel[m][b] ??= { n: 0, p: 0, y: 0 }); a.n++; a.p += p[m]; a.y += over; }
    }
  }
}

console.log(`\nWalk-forward ${LEAGUE} ${SEASON}: ${nRows} player-games (≥5 prior games, played), predicted minutes. Log loss (lower = better; coin flip 0.693)`);
console.log("stat                   line     n      engine   eng-nb  eng×opp  calibr.   opp-mix");
for (const k of ["ALL", ...DIST_KEYS]) {
  for (const lt of ["main", "low", "high"]) {
    const a = sc[k]?.[lt]; if (!a) continue;
    const cell = (m) => (a[m].ll / a[m].n).toFixed(4).padStart(8);
    console.log(`${(k === "ALL" ? "ALL" : KEY_PROP[k]).padEnd(22)} ${lt.padEnd(5)} ${String(a.engine.n).padStart(6)}  ${METHODS.map(cell).join(" ")}`);
  }
}
console.log("\nMean bias (predicted − actual, per player-game)");
const sgn = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);
for (const k of DIST_KEYS) {
  const b = bias[k]; if (!b) continue;
  console.log(`  ${KEY_PROP[k].padEnd(21)} actual ${(b.y / b.n).toFixed(2).padStart(6)}   engine-mean ${sgn((b.e - b.y) / b.n)}   eng×opp ${sgn((b.eo - b.y) / b.n)}   opp-mean ${sgn((b.o - b.y) / b.n)}`);
}
for (const m of ["engine", "eng×opp", "calibrated"]) {
  console.log(`\nReliability — ${m} P(over), all stats and lines`);
  for (let b = 0; b < 10; b++) { const a = rel[m][b]; if (a) console.log(`  ${(b * 10 + "–" + (b * 10 + 10) + "%").padEnd(8)} n=${String(a.n).padStart(6)}  predicted ${(100 * a.p / a.n).toFixed(1).padStart(5)}%  realized ${(100 * a.y / a.n).toFixed(1).padStart(5)}%`); }
}
// ── Real graded PrizePicks lines (--graded) ────────────────────────────────
// Same line, same engine mean (model_mean as logged), only the shape and the
// matchup/calibration differ:
//   engine-as-run  logged P (Normal, fixed σ)
//   nb-shape       NB(model_mean, r fitted on engine-style means)
//   calibrated     NB(model_mean × opponent/pace factor × c, r_cal)
// The factor comes from the opponent model fitted on game logs before the
// game date. 95% interval on the paired change: bootstrap over game days.
if (args.includes("--graded")) {
  const { readGraded } = await import("./_graded.mjs");
  const { opponentFactor, PROP_WEIGHTS } = await import("../api/_lib/basketball/opponent.js");
  const { toEspnAbbr, toNbaAbbr } = await import("../api/_lib/espn.js");
  const { mulberry32 } = await import("../api/_lib/distributions.js");
  const statsAbbr = (a) => toNbaAbbr(toEspnAbbr(a, LEAGUE), LEAGUE);
  const models = new Map();
  const modelFor = (date) => { if (!models.has(date)) models.set(date, fitOpponentModel(cur, { before: date, prior: priorFit })); return models.get(date); };
  const items = [];
  for (const r of readGraded({ league: LEAGUE })) {
    const o = r.outcome ?? {};
    if (r.logged_after_kickoff || !(o.hit_or_miss === "hit" || o.hit_or_miss === "miss") || o.actual_value == null) continue;
    const prop = String(r.prop_type).replace(/\s+(OVER|UNDER)$/i, "").trim(), key = PROP_KEY[prop];
    if (!key || typeof r.model_mean !== "number" || typeof r.model_dir_prob !== "number" || !PROP_WEIGHTS[prop]) continue;
    const mu = String(o.matchup ?? "").match(/^(\S+)\s+(?:@|vs\.?)\s+(\S+)$/);
    const pid = r.nba_id ?? o.nba_id;
    const date = String(r.game_start_time).slice(0, 10);
    const f = mu && pid ? opponentFactor(modelFor(date), { playerId: pid, team: statsAbbr(mu[1]), opponent: statsAbbr(mu[2]), prop }) : null;
    const line = Number(r.line), over = o.actual_value > line ? 1 : 0;
    const pEngine = r.direction === "UNDER" ? 1 - r.model_dir_prob : r.model_dir_prob;
    const m = Math.max(1e-3, r.model_mean);
    items.push({
      day: date, type: r.odds_type || "standard", over,
      p: {
        "engine-as-run": pEngine,
        "nb-shape": lineProbs(line, m, R.eng[key]).over,
        calibrated: lineProbs(line, Math.max(1e-3, m * (f ? f.opp_factor * f.pace_factor : 1) * C[key]), R.cal[key]).over,
      },
    });
  }
  const ll = (p, y) => -(y ? Math.log(clampP(p)) : Math.log(1 - clampP(p)));
  const boot = (set, a, b, B = 2000) => {
    const days = new Map(); for (const it of set) { if (!days.has(it.day)) days.set(it.day, []); days.get(it.day).push(it); }
    const g = [...days.values()], rng = mulberry32(11), d = [];
    for (let i = 0; i < B; i++) { let s = 0, n = 0; for (let j = 0; j < g.length; j++) for (const it of g[Math.floor(rng() * g.length)]) { s += ll(it.p[b], it.over) - ll(it.p[a], it.over); n++; } d.push(s / n); }
    d.sort((x, y) => x - y); return [d[Math.floor(0.025 * B)], d[Math.floor(0.975 * B)], g.length];
  };
  console.log(`\nReal graded ${LEAGUE} PrizePicks lines (engine's logged mean; log loss, lower = better)`);
  for (const [name, set] of [["standard", items.filter((i) => i.type === "standard")], ["goblin", items.filter((i) => i.type === "goblin")], ["demon", items.filter((i) => i.type === "demon")], ["all", items]]) {
    if (set.length < 20) continue;
    const s = (k) => set.reduce((a, it) => a + ll(it.p[k], it.over), 0) / set.length;
    const line = ["engine-as-run", "nb-shape", "calibrated"].map((k) => `${k} ${s(k).toFixed(4)}`).join("   ");
    const [lo, hi, nd] = boot(set, "engine-as-run", "calibrated");
    console.log(`  ${name.padEnd(9)} n=${String(set.length).padStart(4)}  ${line}   calibrated − engine 95% [${lo.toFixed(4)}, ${hi.toFixed(4)}] over ${nd} days`);
  }
}

console.log(`\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
