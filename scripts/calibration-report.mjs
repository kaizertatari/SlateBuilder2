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
loadEnvLocal();

const QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

// Mirror of api/lib/rules/_helpers.js ASSIST_CONTAINING — kept inline so
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
  const verdicts = (await queryAxiom(token, `['${dataset}'] | where event_type == "verdict"`, startISO, endISO))
    .filter((v) => v.engine_mode === "rules");
  const outcomes = await queryAxiom(token, `['${dataset}'] | where event_type == "outcome" | project player, prop_type, line, direction, game_start_time, hit_or_miss`, startISO, endISO);

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
      hm: o.hit_or_miss, rules: normRules(v.rules_fired),
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

  console.log(`\n* small-n: a side has <8 decided picks — treat as noise.`);
  console.log(`This report proposes nothing. Weight changes go through rule-weights.js`);
  console.log(`with explicit approval + held-out validation (see CLAUDE.local.md / memory).`);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
