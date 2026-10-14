// Gameday automation (Scheduled Task "NFL Gameday Sweep", every 30 min).
// When an NFL game kicks off within the next --window minutes (default 90):
// refresh the DK/FD odds, then sweep the board for those games. The last
// sweep before kickoff carries the closing book prices (CLV in the grader).
// Silent when there's nothing to do, so the 30-minute cadence doesn't spam
// logs\nfl-gameday.log.
//
// Never opens a browser (the board itself refreshes via "NFL Refresh Board"),
// so it can't collide with the Refresh Bridge's PrizePicks profile.
// Inactives (~90 min out) are NOT in any free feed — a player ruled inactive
// is still priced off the Friday report and voids at grading.
//
// Usage: node scripts/nfl-gameday.mjs [--window 90] [--dry-run]

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { kickoffOf } from "../api/_lib/nfl/verdict.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wIdx = args.indexOf("--window");
const WINDOW_MIN = wIdx >= 0 ? Number(args[wIdx + 1]) : 90;
const DRY = args.includes("--dry-run");

function run(script, extra = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...extra], { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

/** Games kicking off within the window (exported for the smoke). */
export function gamesInWindow(schedule, now, windowMin) {
  return (schedule || []).filter((g) => {
    const ko = kickoffOf(g);
    return Number.isFinite(ko) && ko > now && ko - now <= windowMin * 60000;
  });
}

async function main() {
  const model = JSON.parse(await fs.readFile(path.join(ROOT, "data/nfl-model.json"), "utf8"));
  const soon = gamesInWindow(model.schedule, Date.now(), WINDOW_MIN);
  if (!soon.length) return; // quiet no-op
  console.log(`\n=== ${new Date().toISOString()} NFL gameday: ${soon.map((g) => `${g.away}@${g.home} ${g.gameday} ${g.gametime} ET`).join(", ")}`);
  if (DRY) {
    console.log("  DRY RUN — would refresh odds + sweep");
    return;
  }
  // --push keeps the deployed app's Blob odds in step with the sweep.
  const oddsRc = run("scrape-nfl-odds.mjs", ["--push"]);
  if (oddsRc !== 0) console.warn(`  ! odds refresh exit ${oddsRc} — sweeping with the last odds snapshot`);
  const sweepRc = run("sweep-nfl-board.mjs", ["--within-hours", String((WINDOW_MIN + 5) / 60)]);
  if (sweepRc !== 0) process.exitCode = sweepRc;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}
