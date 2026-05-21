// Unit smoke for the LLM-guardrail extensions to verdict-verifier.
//   (a) data_used hallucination detection — auditDataUsed surfaces a
//       mismatch entry when the LLM emits a number that diverges from
//       groundTruth.
//   (b) Unjustified SKIP detection — verifyVerdict returns should_retry
//       when the LLM SKIPs without citing a framework rule and no
//       mechanical gate fires.
//   (c) Framework-cited SKIP — at least one framework token in flags[]
//       classifies the SKIP as framework_cited (no retry).
//   (d) Mechanical override — pre-existing behavior for OVER that fails
//       the over-buffer check; should still downgrade to SKIP with
//       overridden:true and skip_kind:"mechanical_override".

import { verifyVerdict, auditDataUsed } from "../api/lib/verdict-verifier.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS — ${name}`);
    passed++;
  } else {
    console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`);
    failed++;
  }
}

const baseGroundTruth = {
  league: "WNBA",
  home_away: "away",
  opponent_team: { name: "Phoenix Mercury", abbr: "PHX" },
  win_prob: { player_team_pct: 0.4 },
  season: { averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pra: 33.8, pr: 28.3, pa: 32.3, ra: 7 } },
  l5: { type: "Regular Season", n: 4, averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pra: 33.8 } },
};

// (a) Hallucinated season_avg
console.log("\n[a] data_used mismatch detection");
const halResult = {
  verdict: "OVER", tier: "A", confidence: 70,
  flags: [],
  data_used: { season_avg: 3.5, l5_avg: 26.75, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const halAudit = auditDataUsed({ groundTruth: baseGroundTruth, llmResult: halResult, statType: "Points" });
assert("season_avg mismatch flagged", halAudit.length === 1 && halAudit[0].field === "season_avg",
  `got ${JSON.stringify(halAudit)}`);

// (a2) Weighted L5 echo — should NOT flag as mismatch. The framework
// tells the LLM to govern off weighted L5 when present, so emitting the
// weighted value is framework-correct even though the data_used schema
// literally says to copy from l5.averages.
const weightedGT = {
  ...baseGroundTruth,
  l5: {
    type: "Regular Season", n: 4,
    averages: { ppg: 26.75, rpg: 1.5, apg: 5.5, pra: 33.8, pa: 32.3 },
    weighted: { averages: { ppg: 26.9, pa: 33 } },
  },
};
const weightedResult = {
  verdict: "OVER", tier: "B", confidence: 65,
  flags: [],
  data_used: { season_avg: 32.3, l5_avg: 33, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const weightedAudit = auditDataUsed({ groundTruth: weightedGT, llmResult: weightedResult, statType: "PA" });
assert("weighted L5 echo accepted (no mismatch)", weightedAudit.length === 0,
  `got ${JSON.stringify(weightedAudit)}`);

// (a3) Raw L5 echo when both raw and weighted exist — still accepted.
const rawL5Result = {
  verdict: "OVER", tier: "B", confidence: 65,
  flags: [],
  data_used: { season_avg: 32.3, l5_avg: 32.3, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const rawL5Audit = auditDataUsed({ groundTruth: weightedGT, llmResult: rawL5Result, statType: "PA" });
assert("raw L5 echo accepted when weighted also present", rawL5Audit.length === 0,
  `got ${JSON.stringify(rawL5Audit)}`);

// (a4) Neither raw nor weighted — flagged.
const fabricatedL5Result = {
  verdict: "OVER", tier: "B", confidence: 65,
  flags: [],
  data_used: { season_avg: 32.3, l5_avg: 99, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const fabricatedAudit = auditDataUsed({ groundTruth: weightedGT, llmResult: fabricatedL5Result, statType: "PA" });
assert("fabricated l5_avg (neither raw nor weighted) flagged", fabricatedAudit.length === 1 && fabricatedAudit[0].field === "l5_avg",
  `got ${JSON.stringify(fabricatedAudit)}`);

const halVerified = verifyVerdict({
  groundTruth: baseGroundTruth, statType: "Points", direction: "OVER", line: 20.5, llmResult: halResult,
});
assert("verifyVerdict surfaces data_used_mismatches on non-SKIP",
  Array.isArray(halVerified.data_used_mismatches) && halVerified.data_used_mismatches.length === 1);

// (b) Unjustified SKIP — no flags
console.log("\n[b] Unjustified SKIP detection (should retry)");
const unjustified = {
  verdict: "SKIP", tier: "SKIP", confidence: 0,
  flags: [],
  data_used: { season_avg: 26.75, l5_avg: 26.75, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const unjVerified = verifyVerdict({
  groundTruth: baseGroundTruth, statType: "Points", direction: "OVER", line: 20.5, llmResult: unjustified,
});
assert("skip_kind === unjustified", unjVerified.skip_kind === "unjustified",
  `got ${unjVerified.skip_kind}`);
assert("should_retry === true", unjVerified.should_retry === true);
assert("retry_reason === unjustified_skip", unjVerified.retry_reason === "unjustified_skip");

// Re-verification path with isRetry=true (simulates the orchestrator's
// second call after the LLM re-prompt still returned an unjustified SKIP).
const finalVerified = verifyVerdict({
  groundTruth: baseGroundTruth, statType: "Points", direction: "OVER", line: 20.5,
  llmResult: unjustified, isRetry: true,
});
assert("on retry: skip_kind === unjustified_after_retry", finalVerified.skip_kind === "unjustified_after_retry");
assert("on retry: should_retry === false (one-shot cap)", finalVerified.should_retry === false);

// (c) Framework-cited SKIP
console.log("\n[c] Framework-cited SKIP (no retry)");
const cited = {
  verdict: "SKIP", tier: "SKIP", confidence: 0,
  flags: ["⚠️ Game 1 — model recommends SKIP (Game 1 hit 18.8% in v3.3 sample)"],
  data_used: { season_avg: 26.75, l5_avg: 26.75, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const citedVerified = verifyVerdict({
  groundTruth: baseGroundTruth, statType: "Points", direction: "OVER", line: 20.5, llmResult: cited,
});
assert("skip_kind === framework_cited", citedVerified.skip_kind === "framework_cited",
  `got ${citedVerified.skip_kind}`);
assert("should_retry === false on framework_cited", citedVerified.should_retry === false);

// Verify a rule-label-only flag is also recognized (e.g., "Rule 5i")
const ruleLabel = {
  verdict: "SKIP", tier: "SKIP", confidence: 0,
  flags: ["⚠️ Rule 5i FT-floor violation: total_floor exceeds line"],
  data_used: { season_avg: 26.75, l5_avg: 26.75, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const ruleLabelVerified = verifyVerdict({
  groundTruth: baseGroundTruth, statType: "Points", direction: "UNDER", line: 35, llmResult: ruleLabel,
});
assert("rule label '5i' classifies as framework_cited", ruleLabelVerified.skip_kind === "framework_cited",
  `got ${ruleLabelVerified.skip_kind}`);

// (d) Mechanical override — OVER that fails the buffer check
console.log("\n[d] Mechanical override (existing behavior, with skip_kind)");
const buffFailGT = {
  ...baseGroundTruth,
  season: { averages: { ppg: 10 } },
  l5: { type: "Regular Season", n: 5, averages: { ppg: 10 } },
};
const goodLooking = {
  verdict: "OVER", tier: "A", confidence: 75,
  flags: [],
  data_used: { season_avg: 10, l5_avg: 10, home_away: "away", win_prob: 0.4, opponent: "Phoenix Mercury" },
};
const overridden = verifyVerdict({
  groundTruth: buffFailGT, statType: "Points", direction: "OVER", line: 20, llmResult: goodLooking,
});
assert("overridden === true", overridden.overridden === true);
assert("verdict downgraded to SKIP", overridden.verdict === "SKIP");
assert("skip_kind === mechanical_override", overridden.skip_kind === "mechanical_override");
assert("override_reasons populated", Array.isArray(overridden.override_reasons) && overridden.override_reasons.includes("over_buffer_failed"));

console.log(`\n=== smoke-verifier: ${passed} pass, ${failed} fail ===`);
process.exit(failed > 0 ? 1 : 0);
