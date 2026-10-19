// Backtest: shifting a sportsbook's fair price to the PrizePicks line — the
// engine's fixed-σ normal (odds.js fairProbAtLine) vs the fitted negative
// binomial (dist.js nbShiftOver) — on graded lines where the PrizePicks line
// differs from the book line (goblins/demons: typically 2–7 points away).
//
// Graded rows store only the SHIFTED price (no_vig_prob) and the gap
// (market_line_delta), so the book's own price is recovered by inverting
// fairProbAtLine (bisection; exact for one book, approximate when two books
// were averaged). Dispersion r per stat comes from the league's artifact
// (data/<league>-opp-model.json → dist), with r×½ and r×2 as sensitivity.
//
// Usage: node scripts/backtest-market-shift.mjs [--league WNBA]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGraded } from "./_graded.mjs";
import { fairProbAtLine } from "../api/_lib/odds.js";
import { nbShiftOver, PROP_KEY } from "../api/_lib/basketball/dist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const li = args.indexOf("--league");
const LEAGUE = (li >= 0 ? args[li + 1] : "WNBA").toUpperCase();
const dist = JSON.parse(fs.readFileSync(path.join(ROOT, "data", `${LEAGUE.toLowerCase()}-opp-model.json`), "utf8")).dist;
const clamp = (p) => Math.min(0.99, Math.max(0.01, p));
const ll = (p, y) => -(y ? Math.log(clamp(p)) : Math.log(1 - clamp(p)));

function recoverBookPrice(shifted, bookLine, targetLine, stat) {
  let lo = 0.02, hi = 0.98;
  const f = (p) => fairProbAtLine({ fairOver: p, bookLine, targetLine, stat, league: LEAGUE });
  // fairProbAtLine is increasing in the book price
  if (shifted <= f(lo) || shifted >= f(hi)) return null; // clamped — not recoverable
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) < shifted) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

const items = [];
let unrecoverable = 0;
for (const r of readGraded({ league: LEAGUE })) {
  const o = r.outcome ?? {};
  if (r.logged_after_kickoff || !["hit", "miss"].includes(o.hit_or_miss) || typeof r.no_vig_prob !== "number") continue;
  const delta = Number(r.market_line_delta ?? 0), line = Number(r.line);
  if (!delta) continue;
  const stat = String(r.prop_type).replace(/\s+(OVER|UNDER)$/i, "").trim(), key = PROP_KEY[stat];
  if (!key || !(dist?.r?.[key] > 0)) continue;
  const bookLine = line - delta;
  const book = recoverBookPrice(r.no_vig_prob, bookLine, line, stat);
  if (book == null) { unrecoverable++; continue; }
  const over = o.actual_value > line ? 1 : 0;
  const nb = (mult) => nbShiftOver({ pOver: book, bookLine, targetLine: line, r: dist.r[key] * mult });
  items.push({ type: r.odds_type || "standard", day: String(r.game_start_time).slice(0, 10), over, gap: Math.abs(delta), normal: r.no_vig_prob, nb: nb(1), nbHalf: nb(0.5), nbDouble: nb(2), stat });
}

console.log(`${LEAGUE} graded lines with a market and a line gap: ${items.length} (unrecoverable clamped prices skipped: ${unrecoverable})`);
for (const [name, set] of [["goblin", items.filter((i) => i.type === "goblin")], ["demon", items.filter((i) => i.type === "demon")], ["standard (gap)", items.filter((i) => i.type === "standard")], ["all", items]]) {
  if (!set.length) continue;
  const s = (k) => (set.reduce((a, it) => a + ll(it[k], it.over), 0) / set.length).toFixed(4);
  const days = new Set(set.map((i) => i.day)).size;
  console.log(`  ${name.padEnd(15)} n=${String(set.length).padStart(3)} (${days} days, median gap ${[...set].sort((a, b) => a.gap - b.gap)[Math.floor(set.length / 2)].gap})  over rate ${(100 * set.reduce((a, i) => a + i.over, 0) / set.length).toFixed(1)}%   normal ${s("normal")}   NB ${s("nb")}   (NB r×½ ${s("nbHalf")}, r×2 ${s("nbDouble")})`);
}
const g = items.filter((i) => i.type === "goblin");
if (g.length) {
  const avg = (k) => (100 * g.reduce((a, i) => a + i[k], 0) / g.length).toFixed(1);
  console.log(`\nGoblin mean P(over): normal ${avg("normal")}%  NB ${avg("nb")}%  realised ${(100 * g.reduce((a, i) => a + i.over, 0) / g.length).toFixed(1)}%`);
}
