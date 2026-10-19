// Shadow-mode gate for the basketball opponent-factor model: does the
// logged opp_factor × opp_pace_factor predict where results land against
// the REAL PrizePicks line — beyond what the engine's projection already
// knew? Read-only; reads the durable graded store (data/graded/<league>/).
//
// For every settled graded line (hit/miss, logged before tip):
//   factor   = opp_factor × opp_pace_factor as logged on the verdict, or —
//              with --backfill, for history logged before shadow mode —
//              recomputed walk-forward from data/basketball/ (fit on games
//              strictly before the game date)
//   1. over rate by factor third (standard lines, then all line types)
//   2. the decisive test: re-price each line with the projection's own
//      normal (P(over) = Φ((mean − line)/σ), clamped 1–99%) at
//      mean × factor^s for s = 0 (as run), 0.5, 1 — paired log-loss change
//      vs s = 0 with a 95% interval from a bootstrap over game DAYS (lines
//      on the same night share outcomes, so lines aren't independent)
//
// Adopt when, on ≥ 150 standard lines: the s = 1 change is < 0 with its
// interval below 0, and over rates rise across the thirds. Otherwise keep
// shadowing.
//
// Usage: node scripts/eval-opp-factor.mjs [--league NBA] [--backfill] [--since 2026-10]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGraded } from "./_graded.mjs";
import { fitOpponentModel, opponentFactor } from "../api/_lib/basketball/opponent.js";
import { toEspnAbbr, toNbaAbbr } from "../api/_lib/espn.js";
import { mulberry32 } from "../api/_lib/distributions.js";
import { normCdf } from "../api/_lib/projection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LEAGUE = arg("--league", "NBA").toUpperCase();
const BACKFILL = args.includes("--backfill");
const SINCE = arg("--since", null);
const MIN_STANDARD = 150;

const clamp = (p) => Math.min(0.99, Math.max(0.01, p));
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const statsAbbr = (a) => (a ? toNbaAbbr(toEspnAbbr(a, LEAGUE), LEAGUE) : null);

// Walk-forward backfill: fit on the game logs strictly before each date.
const snapCache = new Map(), modelCache = new Map();
function loadSnap(season) {
  if (!snapCache.has(season)) {
    const f = path.join(ROOT, "data", "basketball", `${LEAGUE.toLowerCase()}-${season}.json`);
    snapCache.set(season, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
  }
  return snapCache.get(season);
}
function seasonOf(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  if (LEAGUE === "WNBA") return String(y);
  const start = m >= 9 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
function backfillModel(date) {
  if (modelCache.has(date)) return modelCache.get(date);
  const season = seasonOf(date);
  const cur = loadSnap(season) ?? { players: {}, team_games: [], rows: [] };
  let prior = null;
  if (LEAGUE === "NBA") {
    const y = parseInt(season, 10);
    const p = loadSnap(`${y - 1}-${String(y % 100).padStart(2, "0")}`);
    prior = p ? fitOpponentModel(p) : null;
  }
  const m = cur.rows.length || prior ? fitOpponentModel(cur, { before: date, prior }) : null;
  modelCache.set(date, m);
  return m;
}

function factorOf(r) {
  if (typeof r.opp_factor === "number" && typeof r.opp_pace_factor === "number") return { f: r.opp_factor * r.opp_pace_factor, src: "logged" };
  if (!BACKFILL) return null;
  const o = r.outcome ?? {};
  const mu = String(o.matchup ?? "").match(/^(\S+)\s+(?:@|vs\.?)\s+(\S+)$/);
  const pid = r.nba_id ?? o.nba_id;
  if (!mu || !pid) return null;
  const date = String(r.game_start_time).slice(0, 10);
  const m = backfillModel(date);
  if (!m) return null;
  const f = opponentFactor(m, { playerId: pid, team: statsAbbr(mu[1]), opponent: statsAbbr(mu[2]), prop: r.prop_type });
  return f ? { f: f.opp_factor * f.pace_factor, src: "backfill" } : null;
}

function bootstrapDays(items, stat, B = 2000, seed = 7) {
  const days = new Map();
  for (const it of items) { const d = it.day; if (!days.has(d)) days.set(d, []); days.get(d).push(it); }
  const groups = [...days.values()];
  const rng = mulberry32(seed);
  const draws = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < groups.length; i++) { const g = groups[Math.floor(rng() * groups.length)]; for (const it of g) { s += stat(it); n++; } }
    draws.push(s / n);
  }
  draws.sort((a, b) => a - b);
  return { lo: draws[Math.floor(0.025 * B)], hi: draws[Math.floor(0.975 * B)], days: groups.length };
}

const rows = readGraded({ league: LEAGUE, sinceMonth: SINCE ?? undefined })
  .filter((r) => !r.logged_after_kickoff && (r.outcome?.hit_or_miss === "hit" || r.outcome?.hit_or_miss === "miss") && r.outcome.actual_value != null && r.line != null);
const items = [];
let srcCount = { logged: 0, backfill: 0 }, noFactor = 0;
for (const r of rows) {
  const fx = factorOf(r);
  if (!fx) { noFactor++; continue; }
  srcCount[fx.src]++;
  const line = Number(r.line), y = r.outcome.actual_value;
  items.push({
    f: fx.f, over: y > line ? 1 : 0, type: r.odds_type || "standard", day: String(r.game_start_time).slice(0, 10),
    mean: typeof r.model_mean === "number" ? r.model_mean : null, sigma: typeof r.model_sigma === "number" ? r.model_sigma : null, line,
  });
}

console.log(`${LEAGUE} graded lines settled before tip: ${rows.length}; with a factor: ${items.length} (logged ${srcCount.logged}, backfilled ${srcCount.backfill}); without: ${noFactor}${BACKFILL ? "" : " (try --backfill for pre-shadow history)"}`);

// 1) Over rate by factor third
for (const [name, set] of [["standard lines", items.filter((i) => i.type === "standard")], ["all line types", items]]) {
  if (set.length < 9) continue;
  const s = [...set].sort((a, b) => a.f - b.f), t = Math.ceil(s.length / 3);
  console.log(`\nOver rate by factor third — ${name} (n=${set.length})`);
  for (const [lab, g] of [["factor LOW  (matchup suppresses)", s.slice(0, t)], ["middle", s.slice(t, 2 * t)], ["factor HIGH (matchup boosts)", s.slice(2 * t)]])
    console.log(`  ${lab.padEnd(34)} n=${String(g.length).padStart(4)}  avg ×${avg(g.map((x) => x.f)).toFixed(3)}  over ${(100 * avg(g.map((x) => x.over))).toFixed(1)}%`);
}

// 2) Re-price with the projection's own normal at mean × factor^s
const priced = items.filter((i) => i.mean != null && i.sigma > 0);
const verdict = [];
for (const [name, set] of [["standard lines", priced.filter((i) => i.type === "standard")], ["all line types", priced]]) {
  if (set.length < 20) { console.log(`\n${name}: ${set.length} lines with a projection mean/σ — too few to re-price`); continue; }
  const ll = (it, s) => { const p = clamp(normCdf((it.mean * it.f ** s - it.line) / it.sigma)); return -(it.over ? Math.log(p) : Math.log(1 - p)); };
  console.log(`\nRe-priced log loss — ${name} (n=${set.length}; lower = better)`);
  const base = avg(set.map((it) => ll(it, 0)));
  console.log(`  as run (s=0)          ${base.toFixed(4)}`);
  for (const s of [0.5, 1]) {
    const d = avg(set.map((it) => ll(it, s) - ll(it, 0)));
    const ci = bootstrapDays(set, (it) => ll(it, s) - ll(it, 0));
    console.log(`  mean × factor^${s.toFixed(1)}    ${(base + d).toFixed(4)}   change ${d >= 0 ? "+" : ""}${d.toFixed(4)}  [95% ${ci.lo >= 0 ? "+" : ""}${ci.lo.toFixed(4)}, ${ci.hi >= 0 ? "+" : ""}${ci.hi.toFixed(4)}] over ${ci.days} game days`);
    if (name === "standard lines" && s === 1) verdict.push({ n: set.length, d, hi: ci.hi });
  }
}

// 3) Calibrated distribution (probability pipeline step 1, logged as
//    dist_p_over) vs the engine's Normal(mean, fixed σ) model_prob on the
//    same graded lines — only rows where both were logged.
{
  const both = rows.filter((r) => typeof r.dist_p_over === "number" && typeof r.model_prob === "number").map((r) => ({
    day: String(r.game_start_time).slice(0, 10), type: r.odds_type || "standard",
    over: r.outcome.actual_value > Number(r.line) ? 1 : 0, eng: r.model_prob, dist: r.dist_p_over,
  }));
  const ll = (p, y) => { const q = clamp(p); return -(y ? Math.log(q) : Math.log(1 - q)); };
  console.log(`\nCalibrated distribution vs engine (logged on the same verdicts): ${both.length} graded lines`);
  for (const [name, set] of [["standard", both.filter((i) => i.type === "standard")], ["all", both]]) {
    if (set.length < 20) { console.log(`  ${name}: ${set.length} — too few yet`); continue; }
    const d = avg(set.map((it) => ll(it.dist, it.over) - ll(it.eng, it.over)));
    const ci = bootstrapDays(set, (it) => ll(it.dist, it.over) - ll(it.eng, it.over));
    console.log(`  ${name.padEnd(9)} n=${String(set.length).padStart(4)}  engine ${avg(set.map((it) => ll(it.eng, it.over))).toFixed(4)}  calibrated ${avg(set.map((it) => ll(it.dist, it.over))).toFixed(4)}  change ${d >= 0 ? "+" : ""}${d.toFixed(4)} [95% ${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}] over ${ci.days} days`);
  }
}

// 4) Probability pipeline (step 2, logged as pipe_*): blended P vs the
//    engine, the market weight refit on these lines, and — the decision
//    metric — how the pipeline's WOULD-BE picks did against break-even.
{
  const logit = (p) => Math.log(p / (1 - p)), sig = (x) => 1 / (1 + Math.exp(-x));
  const ll = (p, y) => { const q = clamp(p); return -(y ? Math.log(q) : Math.log(1 - q)); };
  const P = rows.filter((r) => typeof r.pipe_prob === "number").map((r) => {
    const over = r.outcome.actual_value > Number(r.line) ? 1 : 0;
    const hit = r.direction === "UNDER" ? 1 - over : over;
    return {
      day: String(r.game_start_time).slice(0, 10), type: r.odds_type || "standard", over, hit, tier: r.pipe_tier,
      be: r.pipe_break_even, pipeDir: r.pipe_prob, dist: r.dist_p_over, mkt: r.pipe_market_over,
      engDir: typeof r.model_dir_prob === "number" ? r.model_dir_prob : null,
    };
  });
  console.log(`\nProbability pipeline (pipe_*): ${P.length} graded lines`);
  const withEng = P.filter((x) => x.engDir != null);
  if (withEng.length >= 20) {
    const d = avg(withEng.map((x) => ll(x.pipeDir, x.hit) - ll(x.engDir, x.hit)));
    const ci = bootstrapDays(withEng, (x) => ll(x.pipeDir, x.hit) - ll(x.engDir, x.hit));
    console.log(`  vs engine (bet side): pipeline ${avg(withEng.map((x) => ll(x.pipeDir, x.hit))).toFixed(4)}  engine ${avg(withEng.map((x) => ll(x.engDir, x.hit))).toFixed(4)}  change ${d >= 0 ? "+" : ""}${d.toFixed(4)} [95% ${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}] n=${withEng.length}`);
  } else console.log(`  vs engine: ${withEng.length} lines — too few yet`);
  const mk = P.filter((x) => typeof x.mkt === "number" && typeof x.dist === "number");
  if (mk.length >= 20) {
    console.log(`  market-weight refit on ${mk.length} lines with a market (log loss of P(over); policy uses 0.5):`);
    console.log("   " + [0, 0.25, 0.5, 0.6, 0.7, 0.8, 1].map((w) => `${w}→${avg(mk.map((x) => ll(sig((1 - w) * logit(clamp(x.dist)) + w * logit(clamp(x.mkt))), x.over))).toFixed(4)}`).join("  "));
  }
  // Market shifted by the fitted NB (pipe_nb_*) vs the fixed-σ normal
  // (pipe_*): head to head on lines where both exist.
  const nb = rows.filter((r) => typeof r.pipe_nb_prob === "number" && typeof r.pipe_prob === "number").map((r) => {
    const over = r.outcome.actual_value > Number(r.line) ? 1 : 0;
    return { day: String(r.game_start_time).slice(0, 10), type: r.odds_type || "standard", hit: r.direction === "UNDER" ? 1 - over : over, a: r.pipe_prob, b: r.pipe_nb_prob, tierB: r.pipe_nb_tier, be: r.pipe_break_even };
  });
  if (nb.length >= 20) {
    for (const [name, set] of [["goblin/demon", nb.filter((x) => x.type !== "standard")], ["all", nb]]) {
      if (set.length < 20) continue;
      const d = avg(set.map((x) => ll(x.b, x.hit) - ll(x.a, x.hit)));
      const ci = bootstrapDays(set, (x) => ll(x.b, x.hit) - ll(x.a, x.hit));
      console.log(`  NB-shifted market vs normal (${name}): ${avg(set.map((x) => ll(x.b, x.hit))).toFixed(4)} vs ${avg(set.map((x) => ll(x.a, x.hit))).toFixed(4)}  change ${d >= 0 ? "+" : ""}${d.toFixed(4)} [95% ${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}] n=${set.length} over ${ci.days} days`);
    }
    const picks = nb.filter((x) => x.tierB === "A" || x.tierB === "B");
    if (picks.length) console.log(`  would-be picks with the NB market: n=${picks.length}  hit ${(100 * avg(picks.map((x) => x.hit))).toFixed(1)}%  break-even ${(100 * avg(picks.map((x) => x.be))).toFixed(1)}%`);
  } else console.log(`  NB-shifted market vs normal: ${nb.length} lines — too few yet`);
  for (const [name, set] of [["standard", P.filter((x) => x.type === "standard")], ["all", P]]) {
    const picks = set.filter((x) => x.tier === "A" || x.tier === "B");
    if (!picks.length) { console.log(`  would-be picks (${name}): none yet`); continue; }
    const hit = avg(picks.map((x) => x.hit)), be = avg(picks.map((x) => x.be)), pred = avg(picks.map((x) => x.pipeDir));
    console.log(`  would-be picks (${name}): n=${picks.length}  hit ${(100 * hit).toFixed(1)}%  predicted ${(100 * pred).toFixed(1)}%  break-even ${(100 * be).toFixed(1)}%  ${picks.length >= MIN_STANDARD && hit > be ? "✓" : "✗"} (need ≥ ${MIN_STANDARD} and hit > break-even)`);
  }
}

const v = verdict[0];
console.log("\nGate (standard lines):");
if (!v) console.log("  ✗ not enough priced standard lines yet — keep shadowing");
else {
  console.log(`  ${v.n >= MIN_STANDARD ? "✓" : "✗"} ≥ ${MIN_STANDARD} priced standard lines   ${v.n}`);
  console.log(`  ${v.d < 0 && v.hi < 0 ? "✓" : "✗"} full factor improves log loss, interval below 0   ${v.d.toFixed(4)} (upper ${v.hi.toFixed(4)})`);
  console.log(v.n >= MIN_STANDARD && v.d < 0 && v.hi < 0 ? "  → ADOPT: let the factor adjust the projection mean (then re-check over rates by third)" : "  → keep shadowing");
}
