// One-off driver: invoke POST /api/analyze-all directly for a small set of
// players, collect S/A picks, and print the top-N with S first then A.
// Run: node scripts/smoke-find-picks.mjs

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

const { POST } = await import("../api/analyze-all.js");

const PLAYERS = [
  "Shai Gilgeous-Alexander",
  "Cade Cunningham",
  "Donovan Mitchell",
  "LeBron James",
  "James Harden",
  "Jalen Williams",
  "Chet Holmgren",
];

const all = [];
let i = 0;
for (const player of PLAYERS) {
  i++;
  process.stderr.write(`[${i}/${PLAYERS.length}] ${player} ...\n`);
  const req = new Request("http://localhost/api/analyze-all", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `127.0.0.${i}`,
    },
    body: JSON.stringify({ player }),
  });
  try {
    const res = await POST(req);
    const body = await res.json();
    if (body.error) {
      process.stderr.write(`  ERROR: ${body.error}\n`);
      continue;
    }
    process.stderr.write(`  analyzed=${body.total_analyzed} s_a=${body.total_s_a}\n`);
    for (const r of body.top_10 || []) all.push(r);
  } catch (e) {
    process.stderr.write(`  THREW: ${e.message}\n`);
  }
}

all.sort((a, b) => {
  const t = { S: 0, A: 1 };
  const td = (t[a.tier] ?? 9) - (t[b.tier] ?? 9);
  if (td !== 0) return td;
  return (b.confidence || 0) - (a.confidence || 0);
});

const top5 = all.slice(0, 5);
console.log("\n=== TOP 5 (S-tier first, then A-tier) ===\n");
console.log(JSON.stringify(top5, null, 2));
