// End-to-end smoke test that calls live Groq.
// Loads GROQ_API_KEY from .env.local automatically.
// Usage: node scripts/smoke-gemini.mjs ["Player"] ["Prop"] [line]

import {
  gatherGroundTruth,
  buildPrompt,
  propTypeToField,
} from "../api/analyze.js";
import { MODEL_FRAMEWORK } from "../api/lib/framework.js";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();
const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY not found in .env.local");
  process.exit(1);
}

const player = process.argv[2] || "Nikola Jokic";
const propType = process.argv[3] || "PRA OVER";
const line = process.argv[4] || "40.5";

console.log(`Player: ${player}\nProp:   ${propType}\nLine:   ${line}\n`);

const gathered = await gatherGroundTruth({ player, propType, line });
if (gathered.skipReason) {
  console.log(`Orchestrator SKIP: ${gathered.skipReason} — ${gathered.message}`);
  process.exit(0);
}
const { groundTruth, missing } = gathered;
console.log("missing:", missing);
if (missing.length) {
  console.log("Orchestrator returns SKIP without calling Gemini.");
  process.exit(0);
}

const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
console.log(`prompt length: ${prompt.length} chars\n`);
// Rough estimate: 4 chars per token for English text
console.log(`estimated tokens: ${Math.ceil(prompt.length / 4)}\n`);
console.log("Calling Groq...");

const t0 = Date.now();
const res = await fetch(
  "https://api.groq.com/openai/v1/chat/completions",
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GROQ_PRIMARY_MODEL || "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  }
);
const dt = Date.now() - t0;
const data = await res.json();
console.log(`elapsed: ${dt}ms`);

if (data.error) {
  console.error("Groq error:", data.error);
  if (data.failed_generation) {
    console.error("Failed generation:", data.failed_generation);
  }
  process.exit(1);
}

const text = data.choices?.[0]?.message?.content?.trim() || "";
console.log("\n=== Raw Groq Output ===");
console.log(text);
console.log(`Text length: ${text.length}`);

let result;
try { 
  result = JSON.parse(text); 
}
catch (e) {
  console.error("\nJSON parse failed:", e.message);
  console.error("Text that failed to parse:", JSON.stringify(text.substring(0, 200)));
  process.exit(1); 
}

console.log("\n=== Parsed Result ===");
console.log("verdict:    ", result.verdict);
console.log("tier:       ", result.tier);
console.log("confidence: ", result.confidence);
console.log("justification:", result.justification);
console.log("flags:      ", result.flags);
console.log("data_used:  ", JSON.stringify(result.data_used, null, 2));

// Hallucination check.
const field = propTypeToField(propType);
const expected = {
  season_avg: groundTruth.season?.averages?.[field] ?? null,
  l5_avg:     groundTruth.l5?.averages?.[field] ?? null,
  home_away:  groundTruth.home_away ?? null,
  win_prob:   groundTruth.win_prob?.player_team_pct ?? null,
  opponent:   groundTruth.opponent_team?.name ?? null,
};

const numEq = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.05;
const eq = (a, b) => (a == null && b == null) ? true : (numEq(a, b) || a === b);

console.log("\n=== Grounded vs Output ===");
let allMatch = true;
for (const k of Object.keys(expected)) {
  const got = result.data_used?.[k];
  const want = expected[k];
  const ok = eq(got, want);
  if (!ok) allMatch = false;
  console.log(
    `${ok ? "MATCH " : "DIFFER"}  ${k.padEnd(11)} got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`
  );
}
console.log(`\nAll grounded fields match: ${allMatch ? "YES" : "NO"}`);
