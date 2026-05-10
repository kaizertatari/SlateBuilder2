// Print the final LLM prompt for visual inspection — no LLM call.
// Usage: node scripts/smoke-prompt.mjs ["Player"] ["Prop Type"] [line]

import { gatherGroundTruth, buildPrompt, propTypeToField } from "../api/analyze.js";
import { MODEL_FRAMEWORK } from "../api/lib/framework.js";

const player = process.argv[2] || "Nikola Jokic";
const propType = process.argv[3] || "PRA OVER";
const line = process.argv[4] || "40.5";

const result = await gatherGroundTruth({ player, propType, line });
if (result.skipReason) {
  console.log("SKIP:", result.skipReason, "-", result.message);
  process.exit(0);
}

console.log("propTypeToField:", propTypeToField(propType));
console.log("missing:", result.missing);
console.log("\n=== PROMPT ===\n");
console.log(buildPrompt(MODEL_FRAMEWORK, result.groundTruth));
