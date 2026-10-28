// Copy graded verdict↔outcome pairs from Axiom into data/graded/ (see
// scripts/_graded.mjs). Axiom retention is 30 days, so this must run at least
// every few weeks — the daily grade task runs it after grading.
//
// Usage:
//   node scripts/export-graded.mjs                # last 30 days, all leagues
//   node scripts/export-graded.mjs --dry-run      # report counts, write nothing
//   node scripts/export-graded.mjs --league EPL

import { loadEnvLocal } from "./_env.mjs";
import { queryAxiomWindowed } from "./_axiom.mjs";
import { joinGraded, mergeIntoStore } from "./_graded.mjs";
loadEnvLocal();

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const lgIdx = args.indexOf("--league");
const LEAGUE = lgIdx >= 0 ? args[lgIdx + 1] : null;
const ALL_LEAGUES = ["NBA", "WNBA", "NFL", "EPL"];

async function main() {
  const token = process.env.AXIOM_TOKEN;
  if (!token) throw new Error("AXIOM_TOKEN missing (.env.local)");
  const D = `['${process.env.AXIOM_DATASET || "props_verdict"}']`;
  // Pull past the 30-day retention so nothing still held is missed. One
  // league at a time, in day windows: the whole dataset is far past Axiom's
  // 50,000-row cap (NFL sweeps alone log 20k+ verdicts on a busy day).
  const start = new Date(Date.now() - 40 * 86400000).toISOString();
  for (const league of LEAGUE ? [LEAGUE] : ALL_LEAGUES) {
    const where = (type) => `${D} | where event_type == "${type}" and league == "${league}"`;
    const verdicts = await queryAxiomWindowed(token, where("verdict"), { start });
    const outcomes = await queryAxiomWindowed(token, where("outcome"), { start });
    const rows = joinGraded(verdicts, outcomes);
    console.log(`export-graded ${league}${DRY ? " (DRY RUN)" : ""}: ${verdicts.length} verdicts, ${outcomes.length} outcomes → ${rows.length} joined rows`);
    const { files, skipped } = mergeIntoStore(rows, { dry: DRY });
    for (const f of files) console.log(`  ${f.file.padEnd(22)} +${f.added} new, ${f.replaced} regraded, ${f.total} total`);
    if (skipped) console.log(`  ${skipped} rows skipped (unparseable game_start_time)`);
    const orphans = outcomes.length - rows.length;
    if (orphans > 0) console.log(`  ${orphans} outcome events without a surviving verdict (duplicates or verdict aged out)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
