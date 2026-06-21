// Calibration report (read-only, SUGGEST-ONLY — makes no changes).
//
// Joins engine-only verdicts <-> graded outcomes from Axiom and reports
// where the framework is and isn't calibrated, so rule-weights.js tuning
// is driven by data instead of guesswork. Mirrors grade-outcomes' join
// (player|prop|line|dir|start). This script proposes nothing on its own;
// any weight change is a separate, approved step.
//
// Usage:
//   node scripts/calibration-report.mjs                 # 90d window
//   node scripts/calibration-report.mjs --lookback 45
//   node scripts/calibration-report.mjs --dataset props_verdict
//
// Reads hits/(hits+miss) — pushes and DNP voids are reported separately,
// never in the denominator. 95% CIs are Wilson score intervals; lean on
// them, not point estimates, when n is small.

import { loadEnvLocal } from "./_env.mjs";
import { shadowTierFor } from "../api/_lib/rule-weights.js";
loadEnvLocal();

const QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// Mirror of api/_lib/rules/_helpers.js ASSIST_CONTAINING — kept inline so
// the report stays a standalone descriptive tool. If that set changes,
// update here too (this only affects the assist-family slice label).
const ASSIST_CONTAINING = new Set(["Assists", "PA", "RA", "PRA", "Fantasy Score"]);

function parseArgs(argv) {
  const out = { lookback: 90 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lookback") out.lookback = parseInt(argv[++i], 10);
    else if (argv[i] === "--dataset") out.dataset = argv[++i];
  }
  return out;
}

async function queryAxiom(token, apl, startTime, endTime) {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl, startTime, endTime }),
  });
  if (!res.ok) throw new Error(`Axiom HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = await res.json();
  const t = data?.tables?.[0];
  if (!t?.fields || !t?.columns) return [];
  const fields = t.fields.map((f) => f.name);
  const n = t.columns[0]?.length ?? 0;
  const rows = [];
  for (let i = 0; i < n; i++) { const r = {}; fields.forEach((f, c) => (r[f] = t.columns[c][i])); rows.push(r); }
  return rows;
}

const joinKey = (e) => [e.player, e.prop_type, Number(e.line), e.direction, e.game_start_time].map((x) => String(x ?? "")).join("|");
const canonicalStat = (pt) => (pt ? String(pt).replace(/\s+(OVER|UNDER)\s*$/i, "").trim() : null);
// Coerce Axiom values: numeric-or-null, and tri-state boolean (true/false/null)
// — signal fields are missing on pre-Stage verdicts, so default to null.
const num = (x) => { if (x == null || x === "") return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const tri = (x) => (x === true || x === "true" ? true : x === false || x === "false" ? false : null);

function normRules(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith("[")) { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } }
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

// Wilson score interval for a binomial proportion (z=1.96 → 95%).
function wilson(hits, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = hits / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function stat(picks) {
  let h = 0, m = 0, pu = 0;
  for (const p of picks) { if (p.hm === "hit") h++; else if (p.hm === "miss") m++; else if (p.hm === "push") pu++; }
  const den = h + m;
  const [lo, hi] = wilson(h, den);
  return { n: picks.length, h, m, pu, den, pct: den > 0 ? h / den : null, lo, hi };
}
function fmtRate(s) {
  if (s.den === 0) return `n=${String(s.n).padStart(3)}  (none decided)`;
  const ci = s.lo != null ? ` [${(100 * s.lo).toFixed(0)}-${(100 * s.hi).toFixed(0)}]` : "";
  return `n=${String(s.n).padStart(3)} dec=${String(s.den).padStart(3)}  hit ${(100 * s.pct).toFixed(1)}%${ci}  (h${s.h}/m${s.m}/p${s.pu})`;
}

function section(title, picks, keyFn, { sortKey = false } = {}) {
  console.log(`\n— ${title} —`);
  const g = {};
  for (const p of picks) { const k = keyFn(p); if (k == null) continue; (g[k] ??= []).push(p); }
  const entries = Object.entries(g).map(([k, ps]) => [k, stat(ps)]);
  entries.sort((a, b) => (sortKey ? String(a[0]).localeCompare(String(b[0])) : b[1].n - a[1].n));
  for (const [k, s] of entries) console.log(`  ${String(k).padEnd(18)} ${fmtRate(s)}`);
}

function reliability(title, picks, valueFn, bins, { showGap = true } = {}) {
  console.log(`\n— ${title} —`);
  const have = picks.filter((p) => valueFn(p) != null);
  if (!have.length) { console.log("  (no data yet — populates as new verdicts log this field)"); return; }
  for (const [lo, hi] of bins) {
    const ps = have.filter((p) => { const v = valueFn(p); return v >= lo && v <= hi; });
    if (!ps.length) continue;
    const s = stat(ps);
    const mid = (lo + hi) / 2;
    const gap = (showGap && s.pct != null) ? `  gap ${(100 * s.pct - mid) >= 0 ? "+" : ""}${(100 * s.pct - mid).toFixed(0)}` : "";
    const pred = showGap ? ` (pred~${mid.toFixed(0)})` : "";
    console.log(`  ${String(lo).padStart(3)}-${String(hi).padStart(3)}${pred}  ${fmtRate(s)}${gap}`);
  }
}

function crosstab(title, picks, rowFn, cols, colFn) {
  console.log(`\n— ${title} —`);
  const rows = {};
  for (const p of picks) { const r = rowFn(p); if (r == null) continue; (rows[r] ??= []).push(p); }
  console.log(`  ${"".padEnd(14)}${cols.map((c) => c.padStart(15)).join("")}`);
  for (const [r, ps] of Object.entries(rows).sort((a, b) => b[1].length - a[1].length)) {
    let line = `  ${String(r).padEnd(14)}`;
    for (const c of cols) {
      const s = stat(ps.filter((p) => colFn(p) === c));
      line += (s.den > 0 ? `${(100 * s.pct).toFixed(0)}% n${s.n}` : `– n${s.n}`).padStart(15);
    }
    console.log(line);
  }
}

function ruleLift(title, picks) {
  console.log(`\n— per-rule marginal lift: ${title} (base ${fmtRate(stat(picks))}) —`);
  const ids = new Set();
  for (const p of picks) for (const r of p.rules) ids.add(r);
  const noRule = picks.filter((p) => p.rules.length === 0);
  if (noRule.length) console.log(`  ${"(no rules fired)".padEnd(18)} ${fmtRate(stat(noRule))}`);
  if (ids.size === 0) { console.log("  (no rules_fired recorded)"); return; }
  const rows = [];
  for (const id of ids) {
    const f = stat(picks.filter((p) => p.rules.includes(id)));
    const a = stat(picks.filter((p) => !p.rules.includes(id)));
    rows.push({ id, f, a, lift: (f.pct != null && a.pct != null) ? 100 * (f.pct - a.pct) : null });
  }
  rows.sort((x, y) => (Math.abs(y.lift ?? 0) - Math.abs(x.lift ?? 0)) || (y.f.n - x.f.n));
  for (const { id, f, a, lift } of rows) {
    const small = (f.den < 8 || a.den < 8) ? " *" : "  ";
    const liftStr = lift == null ? "—" : `${lift >= 0 ? "+" : ""}${lift.toFixed(1)}`;
    const fired = f.den > 0 ? `n${f.n}/${(100 * f.pct).toFixed(0)}%` : `n${f.n}/–`;
    const abs = a.den > 0 ? `n${a.n}/${(100 * a.pct).toFixed(0)}%` : `n${a.n}/–`;
    console.log(`  ${id.padEnd(18)} fired ${fired.padStart(10)}   absent ${abs.padStart(10)}   lift ${liftStr.padStart(6)}${small}`);
  }
}

// Shadow comparison for the pending snapToBand fix: how the live tiers
// would migrate if the raw score drove demote/SKIP, and — the money
// question — whether the picks it would SKIP are actually net-losing.
function shadowSection(picks) {
  const have = picks.filter((p) => p.shadow != null);
  console.log(`\n— snapToBand-fix shadow (would-be tier if raw score drove demote/SKIP) —`);
  console.log(`  coverage: ${have.length}/${picks.length} graded picks carry raw_score/shadow`);
  if (!have.length) { console.log("  (populates as verdicts log raw_score/shadow_tier going forward)"); return; }
  for (const lt of ["S", "A", "B"]) {
    const row = have.filter((p) => p.tier === lt);
    if (!row.length) continue;
    const to = {};
    for (const p of row) to[p.shadow] = (to[p.shadow] ?? 0) + 1;
    const moves = Object.entries(to).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  ");
    console.log(`  live ${lt} (n=${row.length}) → ${moves}`);
  }
  const wouldSkip = have.filter((p) => p.tier !== "SKIP" && p.shadow === "SKIP");
  const survivors = have.filter((p) => p.shadow !== "SKIP");
  console.log(`  would-be SKIP'd (issued today): ${fmtRate(stat(wouldSkip))}`);
  console.log(`  survivors (still issued):       ${fmtRate(stat(survivors))}`);
}

// Stage 1–5 signal calibration — the money question: do the new signals
// actually predict outcomes on STANDARD lines (where the ≥3× payout lives and
// the engine was previously a coin flip)? Reliability curves want the realized
// hit rate to track the predicted probability (gap → 0). Each slice degrades to
// "(no data yet)" until graded signal-bearing verdicts accrue — this is the rig.
function signalCalibration(graded) {
  const standard = graded.filter((p) => p.odds === "standard");
  console.log(`\n=== SIGNAL CALIBRATION (Stage 1–5) — the standard-line edge question ===`);
  console.log(`Standard-line graded: ${fmtRate(stat(standard))}`);
  const anySignal = standard.some((p) =>
    p.marketFair != null || p.modelP != null || p.agree != null || p.blowout != null || p.b2b != null || p.teammateOut);
  if (!standard.length || !anySignal) {
    console.log("  (no graded standard-line signal data yet — populates as market-aware");
    console.log("   verdicts settle and the daily grader runs. The rig is wired + ready.)");
    return;
  }
  const pctBins = [[40, 46], [47, 52], [53, 57], [58, 62], [63, 80]];
  reliability("Market no-vig P(bet side) → realized [standard]", standard, (p) => (p.marketFair != null ? p.marketFair * 100 : null), pctBins);
  reliability("Model P(bet side) → realized [standard]", standard, (p) => (p.modelP != null ? p.modelP * 100 : null), pctBins);
  section("Market edge bucket [standard]", standard, (p) => (p.edge == null ? null : p.edge < 0 ? "edge<0" : p.edge < 0.05 ? "0-5%" : p.edge < 0.1 ? "5-10%" : "10%+"), { sortKey: true });
  section("Model × Market [standard]", standard, (p) => (p.agree == null ? null : p.agree ? "agree" : "conflict"), { sortKey: true });
  section("Vegas blowout [standard]", standard, (p) => (p.blowout == null ? null : p.blowout ? "blowout" : "normal"), { sortKey: true });
  section("Rest [standard]", standard, (p) => (p.t34 ? "3-in-4" : p.b2b === true ? "b2b" : p.b2b === false ? "rested" : null), { sortKey: true });
  section("Usage star-teammate-out [standard]", standard, (p) => (p.teammateOut ? "star-out" : null));
}

// Brier score (lower = better) of a bet-side probability vs the binary outcome,
// over decided picks where the probability is present. Returns null if empty.
function brierOf(picks, valueFn) {
  const ps = picks.filter((p) => valueFn(p) != null && (p.hm === "hit" || p.hm === "miss"));
  if (!ps.length) return null;
  let s = 0;
  for (const p of ps) { const y = p.hm === "hit" ? 1 : 0; s += (valueFn(p) - y) ** 2; }
  return { brier: s / ps.length, n: ps.length };
}

// World Cup group-stage checkpoint slice (WC_FRAMEWORK_SPEC.md §7). Market-led:
// the DK-ladder fair_over is the spine, model_dir_prob (v2 minutes-mixture) the
// confirmer, model_prob_point (v1 point-Poisson) logged alongside so this
// checkpoint can compare v1 vs v2 tail calibration (spec calibration item).
// Only Shots/SOT/Goalie Saves grade off ESPN; Tackles/Clearances/Passes/Fantasy
// need the FBref match-stats enrichment grade (see RUNBOOK "Refresh WC match
// stats") before they appear here. The headline question (§7): is the market
// curve flat at PP's 0.5 pricing? If so, tighten S/A thresholds or abstain.
function wcCalibration(graded) {
  const wc = graded.filter((p) => p.league === "WC");
  console.log(`\n=== WORLD CUP calibration slice (spec §7 checkpoint) ===`);
  if (!wc.length) {
    console.log("  (no graded WC verdicts in window — verify verdict logging is live and that the");
    console.log("   FBref match-stats grade has run for Tackles/Clearances/Passes/Fantasy)");
    return;
  }
  console.log(`WC graded: ${fmtRate(stat(wc))}`);
  section("WC by stat", wc, (p) => p.stat);
  section("WC by tier", wc, (p) => p.tier, { sortKey: true });
  section("WC by direction", wc, (p) => p.direction, { sortKey: true });
  const bins = [[35, 46], [46, 50], [50, 54], [54, 58], [58, 64], [64, 100]];
  reliability("WC market fair_over (ladder) → realized", wc, (p) => (p.marketFair != null ? p.marketFair * 100 : null), bins);
  reliability("WC model v2 (minutes-mix) dir_prob → realized", wc, (p) => (p.modelP != null ? p.modelP * 100 : null), bins);
  reliability("WC model v1 (point-Poisson) → realized", wc, (p) => (p.modelPoint != null ? p.modelPoint * 100 : null), bins);
  const bm = brierOf(wc, (p) => p.marketFair), b2 = brierOf(wc, (p) => p.modelP), b1 = brierOf(wc, (p) => p.modelPoint);
  console.log(`\n— WC Brier (lower=better), bet-side prob vs outcome —`);
  const bl = (lbl, b) => console.log(`  ${lbl.padEnd(22)} ${b ? `${b.brier.toFixed(4)} (n=${b.n})` : "(no data)"}`);
  bl("market fair_over", bm); bl("model v2 (mix)", b2); bl("model v1 (point)", b1);
  section("WC model × market", wc, (p) => (p.agree == null ? null : p.agree ? "agree" : "conflict"), { sortKey: true });
  section("WC market_edge bucket", wc, (p) => (p.edge == null ? null : p.edge < 0 ? "edge<0" : p.edge < 0.05 ? "0-5%" : p.edge < 0.08 ? "5-8%" : "8%+"), { sortKey: true });
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  if (!token) { console.error("AXIOM_TOKEN not set in .env.local"); process.exit(1); }
  const args = parseArgs(process.argv.slice(2));
  const dataset = args.dataset || process.env.AXIOM_DATASET || "props_verdict";
  const end = new Date();
  const start = new Date(end.getTime() - args.lookback * 24 * 3600 * 1000);
  const startISO = start.toISOString(), endISO = end.toISOString();

  // NOTE: no `| project` on verdicts. Axiom throws "invalid field" if you
  // name a field it has never ingested, and new fields (e.g. raw_score)
  // appear over time — pulling full rows is schema-proof.
  // `| limit 100000` is REQUIRED: Axiom defaults to 1000 rows when no limit is
  // given, which silently truncates both pulls (the join then drops most of the
  // window — and whole leagues, e.g. WC, vanish). Mirrors _axiom.mjs.
  const verdicts = (await queryAxiom(token, `['${dataset}'] | where event_type == "verdict" | limit 100000`, startISO, endISO))
    .filter((v) => v.engine_mode === "rules");
  const outcomes = await queryAxiom(token, `['${dataset}'] | where event_type == "outcome" | project player, prop_type, line, direction, game_start_time, hit_or_miss | limit 100000`, startISO, endISO);

  const vByKey = new Map();
  for (const v of verdicts) { const k = joinKey(v), prev = vByKey.get(k); if (!prev || new Date(v._time) > new Date(prev._time)) vByKey.set(k, v); }
  const oByKey = new Map();
  for (const o of outcomes) oByKey.set(joinKey(o), o);

  const graded = [];
  let issued = 0, skip = 0, unmatched = 0, voids = 0;
  for (const [k, v] of vByKey) {
    if (v.tier === "SKIP" || v.verdict === "SKIP") { skip++; continue; }
    issued++;
    const o = oByKey.get(k);
    if (!o) { unmatched++; continue; }
    if (o.hit_or_miss === "void") { voids++; continue; }
    graded.push({
      tier: v.tier ?? "?", direction: v.direction ?? "?", odds: v.odds_type ?? "none",
      stat: canonicalStat(v.prop_type), conf: v.confidence, raw: v.raw_score ?? null,
      shadow: v.shadow_tier ?? (v.raw_score != null ? shadowTierFor(v.tier ?? "?", v.raw_score) : null),
      hm: o.hit_or_miss, rules: normRules(v.rules_fired),
      league: v.league ?? null,
      // Stage 1–5 signal telemetry (null on verdicts logged before each stage).
      marketFair: num(v.market_fair_at_line), edge: num(v.market_edge),
      modelP: num(v.model_dir_prob), agree: tri(v.model_market_agree),
      // WC v1 point-Poisson over-prob, logged beside v2 minutes-mix model_dir_prob
      // so the group-stage checkpoint can compare v1 vs v2 tail calibration.
      modelPoint: num(v.model_prob_point),
      blowout: tri(v.vegas_blowout), b2b: tri(v.back_to_back), t34: tri(v.three_in_four),
      teammateOut: v.usage_teammate_out ?? null,
    });
  }
  const rawCoverage = graded.filter((p) => p.raw != null).length;

  console.log(`=== Calibration report (${dataset}) — SUGGEST-ONLY, no changes made ===`);
  console.log(`Window: ${startISO.slice(0, 10)} → ${endISO.slice(0, 10)} (${args.lookback}d)`);
  console.log(`Engine-only verdicts: ${verdicts.length} → unique ${vByKey.size}  | issued(S/A/B) ${issued}  SKIP ${skip}`);
  console.log(`Outcomes: ${outcomes.length}  | matched ${issued - unmatched}/${issued}  ungraded ${unmatched}  voids/DNP ${voids}`);
  console.log(`Overall: ${fmtRate(stat(graded))}`);
  console.log(`raw_score coverage: ${rawCoverage}/${graded.length} graded picks (forward-looking field)`);

  reliability("Reliability by confidence (predicted vs realized)", graded, (p) => p.conf,
    [[62, 65], [66, 69], [70, 73], [74, 77], [78, 81], [82, 85], [86, 90]]);
  reliability("Reliability by raw pre-snap score", graded, (p) => p.raw,
    [[0, 61], [62, 66], [67, 71], [72, 76], [77, 81], [82, 86], [87, 200]], { showGap: false });

  section("By tier", graded, (p) => p.tier, { sortKey: true });
  section("By direction", graded, (p) => p.direction, { sortKey: true });
  section("By odds_type", graded, (p) => p.odds);
  section("By stat", graded, (p) => p.stat);
  section("By assist-family", graded, (p) => (ASSIST_CONTAINING.has(p.stat) ? "assist-containing" : "non-assist"), { sortKey: true });

  crosstab("direction × tier  (cell = hit% / n)", graded, (p) => p.direction, ["S", "A", "B"], (p) => p.tier);
  crosstab("assist-family × tier", graded, (p) => (ASSIST_CONTAINING.has(p.stat) ? "assist" : "non-assist"), ["S", "A", "B"], (p) => p.tier);

  ruleLift("all issued", graded);
  ruleLift("A+B only", graded.filter((p) => p.tier === "A" || p.tier === "B"));
  shadowSection(graded);
  signalCalibration(graded);
  wcCalibration(graded);

  console.log(`\n* small-n: a side has <8 decided picks — treat as noise.`);
  console.log(`This report proposes nothing. Weight changes go through rule-weights.js`);
  console.log(`with explicit approval + held-out validation (see CLAUDE.local.md / memory).`);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
