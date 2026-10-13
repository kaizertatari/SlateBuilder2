// Smoke for the cross-league calibration helpers (scripts/_calib.mjs).

import { normalizeRow, exclusionOf, hitSummary, compareSources, sigmaCheck, unlockChecklist, statOf } from "./_calib.mjs";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

const epl = normalizeRow({ league: "EPL", tier: "B", odds_type: "standard", direction: "UNDER", epl_stat: "shots", epl_prob: 0.62, epl_p_model: 0.6, epl_p_market: 0.64, epl_break_even: 0.577, epl_mean: 1.2, confidence: 62, outcome: { hit_or_miss: "hit", actual_value: 0 } });
check("EPL engine P = blended epl_prob", epl.p_engine === 0.62 && epl.p_model === 0.6 && epl.p_market === 0.64);
check("EPL break-even read from row", epl.break_even === 0.577 && epl.y === 1 && epl.bettable);

const bb = normalizeRow({ league: "WNBA", tier: "S", odds_type: "goblin", direction: "OVER", prop_type: "Points OVER", model_dir_prob: 0.81, market_fair_at_line: 0.7, model_mean: 20, model_sigma: 5, confidence: 90, outcome: { hit_or_miss: "miss", actual_value: 10 } });
check("basketball engine P = projection model_dir_prob", bb.p_engine === 0.81 && bb.p_market === 0.7);
check("basketball confidence scored as p_conf", near(bb.p_conf, 0.9));
check("break-even falls back to line type", near(bb.break_even, 1 / (Math.sqrt(3) * 0.76)));
check("stat strips direction suffix", bb.stat === "Points" && statOf({ prop_type: "PRA UNDER" }) === "PRA");
check("pre-filtered SKIP is not bettable", !normalizeRow({ league: "NBA", tier: "SKIP", pre_filtered: true, outcome: { hit_or_miss: "hit" } }).bettable);

check("exclusion: post-kickoff", exclusionOf({ logged_after_kickoff: true, outcome: { hit_or_miss: "hit" } }) === "logged after kickoff");
check("exclusion: push / void / ungraded", exclusionOf({ outcome: { hit_or_miss: "push" } }) === "push" && exclusionOf({ outcome: { hit_or_miss: "void" } }) === "void" && exclusionOf({}) === "ungraded");
check("exclusion: settled counts", exclusionOf({ outcome: { hit_or_miss: "miss" } }) === null);

const rows = [
  { y: 1, p_engine: 0.7, break_even: 0.577, odds_type: "standard" },
  { y: 0, p_engine: 0.6, break_even: 0.577, odds_type: "standard" },
  { y: 1, p_engine: 0.8, break_even: 0.577, odds_type: "standard" },
  { y: 1, p_engine: null, break_even: 0.76, odds_type: "goblin" },
];
const s = hitSummary(rows);
check("hitSummary hit rate + predicted ignores nulls", s.n === 4 && near(s.hit, 0.75) && near(s.predicted, 0.7));

const cmp = compareSources(rows, ["p_engine"]);
check("compareSources uses only rows with every source", cmp.n === 3);
check("compareSources adds coin-flip + base-rate baselines", cmp.scores.length === 3 && near(cmp.scores[1].logloss, Math.log(2)));

const zRows = [-1, 1, -1, 1].map((d) => ({ mean: 10, sigma: 2, actual: 10 + 2 * d }));
const z = sigmaCheck(zRows);
check("sigmaCheck sd(z) and mean(z)", near(z.sd_z, Math.sqrt(4 / 3)) && near(z.mean_z, 0));
check("sigmaCheck flags mean running high", sigmaCheck([{ mean: 10, sigma: 1, actual: 8 }, { mean: 10, sigma: 1, actual: 9 }]).mean_z < 0);
check("sigmaCheck needs ≥2 rows with σ", sigmaCheck([{ mean: 1, sigma: 1, actual: 1 }]) === null);

const good = Array.from({ length: 150 }, (_, i) => ({ y: i % 10 < 6 ? 1 : 0, p_engine: 0.61, break_even: 0.577, odds_type: "standard" }));
check("unlock: 150 standard at 60% vs 61% predicted unlocks", unlockChecklist(good).unlocked);
check("unlock: goblins don't count toward the standard sample", !unlockChecklist(good.slice(0, 149).concat(rows.slice(3))).unlocked);
const over = good.map((r) => ({ ...r, p_engine: 0.7 }));
check("unlock: 10-pt overconfidence blocks", !unlockChecklist(over).unlocked && !unlockChecklist(over).checks[2].ok);
check("unlock: no engine P blocks", unlockChecklist(good.map((r) => ({ ...r, p_engine: null }))).checks[2].value === "no engine probability");

console.log(`\nsmoke-calib: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
