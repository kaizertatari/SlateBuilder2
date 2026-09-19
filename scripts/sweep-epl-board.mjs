// Shadow-mode sweep: price EVERY line on the EPL board (both sides where
// allowed) with the live verdict engine and log them to Axiom, so the EPL
// grader accrues calibration data without anyone clicking Analyze.
//
// Run it close to kickoff so the verdicts carry the confirmed lineups
// (FotMob publishes ~1h before); running it more than once is fine — the
// calibration report keeps, per line, the LAST verdict priced before kickoff.
// Lines whose kickoff has passed are never priced (engine gate).
//
// Usage: npm run sweep-epl-board  [-- --within-hours 3] [-- --dry-run]
//   --within-hours N   only fixtures kicking off in the next N hours
//                      (default: every upcoming line on the board)

import { loadEnvLocal } from "./_env.mjs";
import { getEplContext, readEplLines } from "../api/_lib/epl/store.js";
import { eplVerdict } from "../api/_lib/epl/verdict.js";
import { logEplVerdicts } from "../api/_lib/verdict-logger.js";

loadEnvLocal();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const wIdx = args.indexOf("--within-hours");
const WITHIN_MS = wIdx >= 0 ? Number(args[wIdx + 1]) * 3600000 : Infinity;

async function main() {
  const [lines, ctx] = await Promise.all([readEplLines(), getEplContext()]);
  const now = Date.now();
  const verdicts = [];
  const tiers = {};
  const gates = {};
  const lineupByMatch = new Map();
  for (const props of Object.values(lines.by_player || {})) {
    for (const p of props) {
      const ko = Date.parse(p.start_time);
      if (!Number.isFinite(ko) || ko <= now || ko - now > WITHIN_MS) continue;
      const ot = (p.odds_type || "standard").toLowerCase();
      for (const dir of ot === "standard" ? ["OVER", "UNDER"] : ["OVER"]) {
        const v = eplVerdict(p, dir, ctx);
        if (v.pre_filtered) {
          gates[v.skip_reason] = (gates[v.skip_reason] || 0) + 1;
          continue;
        }
        verdicts.push(v);
        tiers[v.tier] = (tiers[v.tier] || 0) + 1;
        if (v.match_id) lineupByMatch.set(`${v.game} (${v.match_id})`, v.detail?.lineup);
      }
    }
  }
  console.log(`=== sweep-epl-board === board ${lines.fetched_at}, odds ${ctx.odds?.fetched_at ?? "—"}`);
  console.log(`  priced ${verdicts.length} line-sides: ${JSON.stringify(tiers)}; gated ${JSON.stringify(gates)}`);
  for (const [m, l] of [...lineupByMatch.entries()].sort()) console.log(`  ${m.padEnd(26)} lineup ${l}`);
  if (!verdicts.length) {
    console.log("  nothing to log (no upcoming lines in the window — refresh the EPL board?)");
    return;
  }
  if (DRY) {
    console.log("  DRY RUN — not logged");
    return;
  }
  if (!process.env.AXIOM_TOKEN) {
    console.warn("  AXIOM_TOKEN not set — nothing logged");
    return;
  }
  logEplVerdicts(verdicts, { source: "epl-sweep" });
  console.log(`  logged ${verdicts.length} verdicts to Axiom (source epl-sweep)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
