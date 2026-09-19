// Matchday automation (Scheduled Task "EPL Matchday Sweep", every 30 min).
// When an EPL fixture kicks off within the next --window minutes (default
// 90): refresh the DK/FD odds, then sweep the board for those fixtures so the
// logged verdicts carry the latest lineups (predicted → confirmed ~1h out).
// A fixture is swept on each run inside its window; the calibration report
// keeps the last pre-kickoff verdict per line. Silent when there's nothing to
// do, so the 30-minute cadence doesn't spam logs\epl-matchday.log.
//
// Never opens a browser (the board itself refreshes via "EPL Refresh Board"),
// so it can't collide with the Refresh Bridge's PrizePicks profile.
//
// Usage: node scripts/epl-matchday.mjs [--window 90] [--dry-run]

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wIdx = args.indexOf("--window");
const WINDOW_MIN = wIdx >= 0 ? Number(args[wIdx + 1]) : 90;
const DRY = args.includes("--dry-run");

function run(script, extra = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...extra], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

async function main() {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-model.json"), "utf8"));
  const now = Date.now();
  const soon = (model.fixtures || []).filter((f) => {
    const ko = Date.parse(f.kickoff);
    return Number.isFinite(ko) && ko > now && ko - now <= WINDOW_MIN * 60000;
  });
  if (!soon.length) return; // quiet no-op
  const abbr = (tid) => model.teams?.[tid]?.abbr ?? tid;
  console.log(`\n=== ${new Date().toISOString()} EPL matchday: ${soon.map((f) => `${abbr(f.home_id)}-${abbr(f.away_id)} @ ${f.kickoff}`).join(", ")}`);
  if (DRY) {
    console.log("  DRY RUN — would refresh odds + sweep");
    return;
  }
  const oddsRc = run("scrape-epl-odds.mjs");
  if (oddsRc !== 0) console.warn(`  ! odds refresh exit ${oddsRc} — sweeping with the last odds snapshot`);
  const sweepRc = run("sweep-epl-board.mjs", ["--within-hours", String((WINDOW_MIN + 5) / 60)]);
  if (sweepRc !== 0) process.exitCode = sweepRc;
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
