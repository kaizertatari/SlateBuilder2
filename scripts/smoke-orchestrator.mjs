// Exercises gatherGroundTruth without calling Gemini.
// Run: node scripts/smoke-orchestrator.mjs ["Player Name"] ["Prop Type"] [line]
// Default: Nikola Jokic / PRA OVER / 40.5

import { gatherGroundTruth } from "../api/analyze.js";

const player = process.argv[2] || "Nikola Jokic";
const propType = process.argv[3] || "PRA OVER";
const line = process.argv[4] || "40.5";

console.log(`Player: ${player}\nProp:   ${propType}\nLine:   ${line}\n`);

const result = await gatherGroundTruth({ player, propType, line });

if (result.skipReason) {
  console.log("SKIP:", result.skipReason);
  console.log("Reason:", result.message);
  process.exit(0);
}

console.log("missing:", result.missing);
console.log("\ngroundTruth:");
console.log(JSON.stringify(result.groundTruth, null, 2));
