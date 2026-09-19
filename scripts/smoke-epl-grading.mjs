// Hermetic smoke for EPL grading + calibration math (api/_lib/epl/grading.js).

import {
  actualFor, gradeVerdict, latestBeforeKickoff, joinKey, fitLogit, logit, sigmoid, scoreProbs, reliability, wilson,
} from "../api/_lib/epl/grading.js";
import { mulberry32 } from "../api/_lib/epl/distributions.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("[a] actuals + settlement");
const row = { minutes: 90, shots: 3, sot: 2, goals: 1, assists: 1, passes_att: 40, key_passes: 2, clearances: 1, tackles: 2, dribbles_att: 3, crosses_att: 2, fouls: 2, yellow_cards: 1, red_cards: 0, saves: null };
assert("plain stat", actualFor("shots", row) === 3 && actualFor("passes_att", row) === 40);
assert("goal + assist", actualFor("goal_assist", row) === 2);
// 10·1 + 5·1 + 3 + 2 + 0.05·40 + 0.5·2 + 1 + 2 + 3 + 0.5·2 − 1 − 0.5·2 = 28
assert("PrizePicks fantasy formula", actualFor("fantasy", row) === 28, String(actualFor("fantasy", row)));
assert("missing stat on a player who played counts as 0", actualFor("saves", row) === 0);
const v = (stat, line, direction) => ({ epl_stat: stat, line, direction });
assert("OVER hit", gradeVerdict(v("shots", 2.5, "OVER"), row).hit_or_miss === "hit");
assert("UNDER miss", gradeVerdict(v("shots", 2.5, "UNDER"), row).hit_or_miss === "miss");
assert("integer line tie → push", gradeVerdict(v("shots", 3, "OVER"), row).hit_or_miss === "push");
assert("0 minutes → void (dnp)", gradeVerdict(v("shots", 0.5, "OVER"), { ...row, minutes: 0 }).reason === "dnp");
assert("not in the squad → void", gradeVerdict(v("shots", 0.5, "OVER"), null).reason === "not_in_squad");

console.log("\n[b] one verdict per line: last before kickoff");
const base = { player: "P", prop_type: "Shots OVER", line: 1.5, direction: "OVER", game_start_time: "2026-09-20T14:00:00Z" };
const picked = latestBeforeKickoff([
  { ...base, _time: "2026-09-20T09:00:00Z", epl_prob: 0.55 },
  { ...base, _time: "2026-09-20T13:10:00Z", epl_prob: 0.61 }, // confirmed lineup
  { ...base, _time: "2026-09-20T15:00:00Z", epl_prob: 0.9 }, // after kickoff — ignored
]);
assert("keeps the latest pre-kickoff verdict", picked.length === 1 && picked[0].epl_prob === 0.61);
assert("join key matches the basketball grader's", joinKey(base) === "P|Shots OVER|1.5|OVER|2026-09-20T14:00:00Z");

console.log("\n[c] logistic refit recovers known weights");
{
  const rng = mulberry32(11);
  const X = [], y = [];
  for (let i = 0; i < 20000; i++) {
    const a = (rng() - 0.5) * 3, b = (rng() - 0.5) * 3;
    X.push([a, b]);
    y.push(rng() < sigmoid(0.3 * a + 0.7 * b) ? 1 : 0);
  }
  const f = fitLogit(X, y, { prior: [0.5, 0.5], lambda: 1 });
  assert("weights ≈ (0.3, 0.7)", close(f.coef[0], 0.3, 0.05) && close(f.coef[1], 0.7, 0.05), JSON.stringify(f.coef));
  assert("standard errors reported", f.se.every((s) => s > 0 && s < 0.05));
  const small = fitLogit(X.slice(0, 30), y.slice(0, 30), { prior: [0.5, 0.5], lambda: 20 });
  assert("heavy ridge keeps a small sample near the prior", close(small.coef[0], 0.5, 0.25) && close(small.coef[1], 0.5, 0.25), JSON.stringify(small.coef));
}

console.log("\n[d] scores + tables");
assert("logit/sigmoid invert", close(sigmoid(logit(0.62)), 0.62, 1e-12));
const s = scoreProbs([0.9, 0.1], [1, 0]);
assert("confident + right → low log loss", close(s.logloss, -Math.log(0.9), 1e-12) && close(s.brier, 0.01, 1e-12));
const rel = reliability([0.52, 0.53, 0.58, 0.61], [1, 0, 1, 1]);
assert("reliability bins", rel.length === 3 && rel[0].n === 2 && close(rel[0].realized, 0.5, 1e-12));
const w = wilson(60, 100);
assert("Wilson interval brackets the rate", w.lo < 0.6 && w.hi > 0.6 && close(w.lo, 0.502, 0.003));

console.log(`\nsmoke-epl-grading: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
