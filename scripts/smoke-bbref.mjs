// Smoke-test the Basketball-Reference splits pipeline.
//
// Two checks:
//  1. Live parse — calls fetchPlayerSplits against three known slugs and
//     prints the home/road averages. Validates the BR HTML hasn't shifted.
//  2. Snapshot read — loads api/_lib/bbref.js and queries the snapshot for
//     the same three players (whatever names are committed in the snapshot).
//     A miss is fine; the snapshot may be empty or pre-refresh.
//
// Run: npm run smoke:bbref
//      node scripts/smoke-bbref.mjs

import { fetchPlayerSplits } from "./refresh-bbref-splits.mjs";

const PROBES = [
  { name: "Shai Gilgeous-Alexander", slug: "gilgesh01" },
  { name: "LeBron James", slug: "jamesle01" },
  { name: "Cade Cunningham", slug: "cunnica01" },
];

const endYear = (() => {
  const d = new Date();
  return d.getUTCMonth() + 1 >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
})();

function fmt(avg) {
  if (!avg) return "null";
  return `${avg.games}g · ${avg.minutes}mp · ${avg.ppg}p · ${avg.rpg}r · ${avg.apg}a`;
}

console.log(`=== smoke-bbref (season end year ${endYear}) ===\n`);

console.log("Live parse:");
for (const p of PROBES) {
  process.stdout.write(`  ${p.name.padEnd(28)} (${p.slug}) ... `);
  const r = await fetchPlayerSplits(p.slug, endYear);
  if (r.error) {
    console.log(`FAIL — ${r.error}`);
  } else {
    console.log("ok");
    console.log(`    home: ${fmt(r.home)}`);
    console.log(`    road: ${fmt(r.road)}`);
  }
  await new Promise((res) => setTimeout(res, 3500));
}

console.log("\nSnapshot read:");
const adapter = await import("../api/_lib/bbref.js");
const meta = adapter.snapshotMeta();
console.log(`  meta: season=${meta.season} fetched_at=${meta.fetched_at} players=${meta.player_count}`);
for (const p of PROBES) {
  const r = adapter.getHomeAwaySplits(p.name);
  console.log(`  ${p.name.padEnd(28)} -> ${r ? "hit" : "miss"}`);
}
