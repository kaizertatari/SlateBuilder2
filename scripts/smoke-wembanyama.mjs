// Parity check: run /api/analyze and /api/analyze-all against the same
// Wembanyama Rebounds OVER 10.5 input and compare verdicts.
// Run: node scripts/smoke-wembanyama.mjs

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

const { POST: analyzePost } = await import("../api/analyze.js");
const { POST: analyzeAllPost } = await import("../api/analyze-all.js");

const PLAYER = "Victor Wembanyama";
const STAT = "Rebounds";
const DIR = "OVER";
const LINE = 10.5;

function mkReq(url, body, ipSuffix) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `127.0.0.${ipSuffix}`,
    },
    body: JSON.stringify(body),
  });
}

// --- single-prop endpoint -------------------------------------------------
console.log(`\n=== /api/analyze — ${PLAYER} ${STAT} ${DIR} ${LINE} ===`);
const singleRes = await analyzePost(
  mkReq("http://localhost/api/analyze",
    { player: PLAYER, propType: `${STAT} ${DIR}`, line: LINE },
    1)
);
const singleBody = await singleRes.json();
if (singleBody.error) {
  console.log("ERROR:", singleBody.error);
} else {
  console.log("verdict:", singleBody.verdict);
  console.log("tier:   ", singleBody.tier);
  console.log("conf:   ", singleBody.confidence);
  console.log("override:", singleBody.overridden || false, singleBody.override_reasons || []);
  console.log("flags:  ", singleBody.flags);
  console.log("just:   ", singleBody.justification);
  const gt = singleBody.ground_truth;
  if (gt) {
    console.log("home_away:", gt.home_away);
    console.log("season.rpg:", gt.season?.averages?.rpg, " l5.rpg:", gt.l5?.averages?.rpg);
  }
}

// --- batch (now looped) endpoint -----------------------------------------
console.log(`\n=== /api/analyze-all — ${PLAYER} statTypes=[${STAT}] direction=${DIR} ===`);
const allRes = await analyzeAllPost(
  mkReq("http://localhost/api/analyze-all",
    { player: PLAYER, statTypes: [STAT], direction: DIR },
    2)
);
const allBody = await allRes.json();
if (allBody.error) {
  console.log("ERROR:", allBody.error);
} else {
  console.log("total_analyzed:", allBody.total_analyzed);
  console.log("total_s_a:     ", allBody.total_s_a);
  console.log("tier_counts:   ", allBody.tier_counts);
  console.log("errors:        ", allBody.errors || "(none)");
  console.log("skipped:       ", allBody.skipped || "(none)");
  console.log("top_10:");
  for (const r of allBody.top_10 || []) {
    console.log(`  ${r.tier} ${r.direction} ${r.line} ${r.confidence}% — ${r.justification}`);
  }
}

// --- summary --------------------------------------------------------------
console.log("\n=== PARITY ===");
const sVerdict = `${singleBody.verdict}/${singleBody.tier}`;
const aTop = (allBody.top_10 || []).find((r) => r.line === LINE);
let aVerdict;
if (aTop) {
  aVerdict = `${aTop.verdict}/${aTop.tier}`;
} else if (sVerdict === "SKIP/SKIP" && (allBody.tier_counts?.SKIP ?? 0) > 0
  && (allBody.tier_counts?.UNKNOWN ?? 0) === 0) {
  // analyze-all dropped non-S/A from top_10 — but tier_counts confirms
  // a SKIP for this prop, so the verdicts agree.
  aVerdict = "SKIP/SKIP";
} else {
  aVerdict = "(no S/A at this line, no clean SKIP either)";
}
console.log("single endpoint:", sVerdict);
console.log("all endpoint:   ", aVerdict);
console.log("match:          ", sVerdict === aVerdict ? "YES" : "NO — investigate");
