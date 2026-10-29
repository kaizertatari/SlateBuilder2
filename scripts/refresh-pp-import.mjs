// Refresh every PrizePicks board from files saved in the operator's own
// browser (data/pp-import/ — see pp-import.mjs). Runs the basketball import
// (guarded: validator + restore), then NFL and EPL with --push. A league with
// no saved file just refuses to write; the others still run.
//
// Usage: npm run refresh-pp:import

import { spawnSync } from "node:child_process";

const steps = [
  ["NBA/WNBA", "npm", ["run", "refresh-prizepicks:import"]],
  ["NFL", "node", ["scripts/refresh-nfl-prizepicks.mjs", "--push", "--import", "data/pp-import"]],
  ["EPL", "node", ["scripts/refresh-epl-prizepicks.mjs", "--push", "--import", "data/pp-import"]],
];

const results = [];
for (const [name, cmd, args] of steps) {
  console.log(`\n##### ${name} #####`);
  // One command string (no args array): npm is a .cmd shim on Windows, which
  // needs a shell, and Node warns on args + shell.
  const r = spawnSync([cmd, ...args].join(" "), { stdio: "inherit", shell: true });
  results.push([name, r.status === 0 ? "updated" : "NOT updated (kept previous snapshot)"]);
}
console.log("\n##### summary #####");
for (const [name, status] of results) console.log(`  ${name.padEnd(9)} ${status}`);
