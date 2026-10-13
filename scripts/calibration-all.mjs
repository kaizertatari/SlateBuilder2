// Cross-league calibration report (read-only, suggest-only) over the durable
// graded store data/graded/ — not Axiom, so it spans past the 30-day window.
// Same sections for every league:
//   1. Coverage — what was graded and what is excluded (pushes, voids,
//      verdicts logged after kickoff).
//   2. Picks — hit rate vs break-even by tier / line type / direction / stat.
//   3. Probability sources — log loss + Brier of engine, model, market and
//      confidence/100 vs coin-flip and base-rate baselines, on identical lines.
//   4. Reliability of the engine probability, and σ sizing where logged.
//   5. Shadow-mode unlock checklist.
// League-specific refits stay in their own reports (epl-calibration-report).
//
// Usage:
//   npm run calibration-all
//   npm run calibration-all -- --league NBA --since 2026-10

import { readGraded } from "./_graded.mjs";
import { normalizeRow, hitSummary, groupBy, compareSources, reliability, sigmaCheck, unlockChecklist } from "./_calib.mjs";
import { SLATE_PENDING_LEAGUES } from "../api/_lib/prop-types.js";

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LEAGUE = arg("--league");
const SINCE = arg("--since");

const pct = (x) => (x == null ? "   —  " : `${(x * 100).toFixed(1)}%`.padStart(6));
const f4 = (x) => (x == null ? "  —   " : x.toFixed(4));

function pickTable(title, rows, keyFn, minN = 1) {
  const groups = groupBy(rows, keyFn).filter(([, g]) => g.length >= minN);
  if (!groups.length) return;
  console.log(`\n  ${title}`);
  for (const [k, g] of groups) {
    const s = hitSummary(g);
    console.log(`    ${String(k).padEnd(24)} n=${String(s.n).padStart(4)}  hit ${pct(s.hit)} [${pct(s.lo)}–${pct(s.hi)}]  predicted ${pct(s.predicted)}  break-even ${pct(s.break_even)}`);
  }
}

function sourceTable(title, rows, sources) {
  const { n, scores } = compareSources(rows, sources);
  if (!n) return;
  console.log(`\n  ${title} — n=${n} lines (lower = better)`);
  for (const s of scores) console.log(`    ${s.source.padEnd(24)} log loss ${f4(s.logloss)}  Brier ${f4(s.brier)}`);
}

function leagueReport(league, raw) {
  const all = raw.map(normalizeRow);
  const settled = all.filter((r) => !r.excluded);
  const picks = settled.filter((r) => r.bettable);
  const months = [...new Set(all.map((r) => String(r.game_start_time).slice(0, 7)))].sort();
  const mode = SLATE_PENDING_LEAGUES[league] ? `shadow mode (target: ${SLATE_PENDING_LEAGUES[league]})` : "live";

  console.log(`\n${"═".repeat(78)}\n${league} — ${mode}\n${"═".repeat(78)}`);
  const excl = groupBy(all.filter((r) => r.excluded), (r) => r.excluded).map(([k, g]) => `${k} ${g.length}`).join(", ");
  console.log(`  ${all.length} graded lines (${months[0]} → ${months.at(-1)}); ${settled.length} settled hit/miss; excluded: ${excl || "none"}`);
  console.log(`  ${picks.length} picks issued (tier ≠ SKIP); ${settled.length - picks.length} SKIPs scored as counterfactuals`);

  if (picks.length) {
    const s = hitSummary(picks);
    console.log(`\n  ALL PICKS  n=${s.n}  hit ${pct(s.hit)} [${pct(s.lo)}–${pct(s.hi)}]  predicted ${pct(s.predicted)}  break-even ${pct(s.break_even)}`);
    pickTable("Picks by tier", picks, (r) => r.tier);
    pickTable("Picks by line type", picks, (r) => r.odds_type);
    pickTable("Picks by direction", picks, (r) => r.direction);
    pickTable("Picks by stat (n ≥ 5)", picks, (r) => r.stat, 5);
  }
  pickTable("SKIP counterfactual — logged side, by line type (did skipping help?)", settled.filter((r) => !r.bettable), (r) => `${r.pre_filtered ? "pre-filter" : "engine"} ${r.odds_type}`);

  sourceTable("Probability sources, all settled lines with an engine P", settled, ["p_engine"]);
  sourceTable("Model vs market, lines with both", settled, ["p_model", "p_market"]);
  if (league !== "EPL") sourceTable("Basketball confidence read as a probability", settled, ["p_conf"]);

  const withP = settled.filter((r) => r.p_engine != null);
  if (withP.length) {
    console.log("\n  Reliability — engine P, all settled lines");
    for (const b of reliability(withP.map((r) => r.p_engine), withP.map((r) => r.y))) {
      console.log(`    ${b.range.padEnd(9)} n=${String(b.n).padStart(4)}  predicted ${pct(b.predicted)}  realized ${pct(b.realized)}`);
    }
  }

  const sig = groupBy(settled, (r) => r.stat).map(([k, g]) => [k, sigmaCheck(g)]).filter(([, c]) => c && c.n >= 10);
  if (sig.length) {
    const tot = sigmaCheck(settled);
    console.log(`\n  σ sizing — sd(z) of (actual − mean)/σ; 1.00 = right-sized, >1 = σ too narrow; mean(z) < 0 = mean runs high`);
    console.log(`    ${"ALL".padEnd(24)} n=${String(tot.n).padStart(4)}  sd(z) ${tot.sd_z.toFixed(2)}  mean(z) ${tot.mean_z.toFixed(2)}`);
    for (const [k, c] of sig) console.log(`    ${String(k).padEnd(24)} n=${String(c.n).padStart(4)}  sd(z) ${c.sd_z.toFixed(2)}  mean(z) ${c.mean_z.toFixed(2)}`);
  }

  const u = unlockChecklist(picks);
  console.log("\n  Unlock checklist (standard picks)");
  for (const c of u.checks) console.log(`    ${c.ok ? "✓" : "✗"} ${c.label.padEnd(44)} ${c.value}`);
  console.log(`    → ${u.unlocked ? "criteria met — eligible to leave shadow mode (a separate, approved step)" : "keep in shadow mode / not validated"}`);
}

const rows = readGraded({ league: LEAGUE, sinceMonth: SINCE });
if (!rows.length) {
  console.log("No graded rows in data/graded/ for that filter. Run: npm run export-graded");
  process.exit(0);
}
console.log(`Cross-league calibration report — data/graded/ (${rows.length} rows${SINCE ? `, since ${SINCE}` : ""})`);
for (const [league, g] of groupBy(rows, (r) => r.league)) leagueReport(league, g);
