// End-to-end smoke test that calls live Gemini.
// Loads GOOGLE_API_KEY from .env.local automatically.
// Usage: node scripts/smoke-gemini.mjs ["Player"] ["Prop"] [line]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  gatherGroundTruth,
  buildPrompt,
  propTypeToField,
} from "../api/analyze.js";
import { MODEL_FRAMEWORK } from "../api/lib/framework.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvLocal();
const apiKey = process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;
if (!apiKey) {
  console.error("GOOGLE_API_KEY not found in .env.local");
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
console.log("Calling Gemini...");

const t0 = Date.now();
const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    }),
  }
);
const dt = Date.now() - t0;
const data = await res.json();
console.log(`elapsed: ${dt}ms`);

if (data.error) {
  console.error("Gemini error:", data.error);
  process.exit(1);
}

const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
console.log("\n=== Raw Gemini Output ===");
console.log(text);

let result;
try { result = JSON.parse(text); }
catch (e) { console.error("\nJSON parse failed:", e.message); process.exit(1); }

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
