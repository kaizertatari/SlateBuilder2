// Shadow-mode sweep: price EVERY line on the NFL board (both sides where
// allowed) with the live verdict engine and log them to Axiom, so the NFL
// grader accrues calibration data without anyone clicking Analyze.
//
// Run it inside the last 90 minutes before kickoff (scripts/nfl-gameday.mjs
// does, right after refreshing the book odds): the last verdict per line
// then carries the closing book price, which the grader turns into CLV.
// Running it more than once is fine — the grader and the reports keep, per
// line, the LAST verdict priced before kickoff. Lines whose kickoff has
// passed are never priced (engine gate).
//
// Usage: npm run sweep-nfl-board  [-- --within-hours 2] [-- --dry-run]
//   --within-hours N   only games kicking off in the next N hours
//                      (default: every upcoming line on the board)

import { loadEnvLocal } from "./_env.mjs";
import { getNflContext, readNflLines } from "../api/_lib/nfl/store.js";
import { nflVerdict } from "../api/_lib/nfl/verdict.js";
import { logNflVerdicts } from "../api/_lib/verdict-logger.js";

loadEnvLocal();
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const wIdx = args.indexOf("--within-hours");
const WITHIN_MS = wIdx >= 0 ? Number(args[wIdx + 1]) * 3600000 : Infinity;

async function main() {
  const [lines, ctx] = await Promise.all([readNflLines(), getNflContext()]);
  const now = Date.now();
  const verdicts = [];
  const tiers = {};
  const gates = {};
  const games = new Map();
  for (const props of Object.values(lines.by_player || {})) {
    for (const p of props) {
      const ko = Date.parse(p.start_time);
      if (!Number.isFinite(ko) || ko <= now || ko - now > WITHIN_MS) continue;
      const ot = (p.odds_type || "standard").toLowerCase();
      for (const dir of ot === "standard" ? ["OVER", "UNDER"] : ["OVER"]) {
        const v = nflVerdict(p, dir, ctx);
        if (v.pre_filtered) {
          gates[v.skip_reason] = (gates[v.skip_reason] || 0) + 1;
          continue;
        }
        verdicts.push(v);
        tiers[v.tier] = (tiers[v.tier] || 0) + 1;
        const g = games.get(v.game_id) ?? { kickoff: v.game_start_time, n: 0, booked: 0 };
        g.n++;
        if (!v.detail?.model_only) g.booked++;
        games.set(v.game_id, g);
      }
    }
  }
  console.log(`=== sweep-nfl-board === board ${lines.fetched_at ?? "—"}, odds ${ctx.odds?.fetched_at ?? "—"}, model ${ctx.model?.fitted_at ?? "—"}`);
  console.log(`  priced ${verdicts.length} line-sides: ${JSON.stringify(tiers)}; gated ${JSON.stringify(gates)}`);
  for (const [id, g] of [...games.entries()].sort()) console.log(`  ${String(id).padEnd(18)} ${g.kickoff}  ${g.n} line-sides (${g.booked} book-priced)`);
  if (!verdicts.length) {
    console.log("  nothing to log (no upcoming lines in the window — refresh the NFL board?)");
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
  logNflVerdicts(verdicts, { source: "nfl-sweep" });
  console.log(`  logged ${verdicts.length} verdicts to Axiom (source nfl-sweep)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
