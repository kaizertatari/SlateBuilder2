// Rule: Game-Script (Vegas) — the Stage-2 signal.
//
// Pros start from the game the book is pricing: the total sets the scoring
// environment (pace/possessions → counting-stat opportunity) and the spread
// sets blowout/garbage-time risk (a starter's 4th-quarter minutes evaporate
// in a rout). This rule turns the scraped Vegas total + spread into a
// secondary confirm/deny on counting-stat picks:
//
//   • team implied total well above league avg → OVER tailwind  (signal)
//   • team implied total well below league avg → OVER headwind  (suppressor)
//   • big spread (blowout)                     → OVER minutes risk (suppressor),
//                                                 UNDER tailwind   (signal)
//
// Secondary by design: small confidence deltas vs rule-market-edge's. It is a
// refinement of the box-score projection (ENGINE_ACCURACY_PLAN Stage 2), not
// the spine. Self-contained — looks the game up by player name via lookupVegas
// (no ground-truth plumbing); no-ops (fired:false) when DK didn't price the
// player's game, so picks without odds coverage are unaffected.
//
// Bench-over-on-favorite is the one game-script case this can't yet call (it
// needs role/minutes to tell a starter from a reserve) — deferred to Stage 4.

import { lookupVegas } from "../odds.js";

// League-average implied TEAM total (game_total / 2 at a pick'em). Deviations
// beyond ENV_BAND read as a real scoring tail/headwind. Spread magnitude at or
// past BLOWOUT is garbage-time territory. APPROXIMATE league constants — tune
// against calibration, same status as the line-shift slopes in odds.js.
const REF_TEAM_TOTAL = { NBA: 114, WNBA: 83 };
const ENV_BAND = { NBA: 5, WNBA: 4 };
const BLOWOUT = { NBA: 12, WNBA: 11 };

// Counting stats that scale with pace / scoring environment (every stat the
// odds feed prices). Non-volume stats (Blks/Stls/TO) are left untouched.
const COUNTING_STATS = new Set([
  "Points", "Rebounds", "Assists", "3-Pointers Made", "PRA", "PR", "PA", "RA",
]);

export function apply(ctx) {
  const { groundTruth, statType, direction } = ctx;
  const player = groundTruth?.info?.full_name ?? groundTruth?.player;
  if (!player || !COUNTING_STATS.has(statType)) return { fired: false, rule_id: "game-script" };

  const v = lookupVegas({ player, league: groundTruth?.league });
  if (!v || typeof v.team_total !== "number") return { fired: false, rule_id: "game-script" };

  const lg = v.league === "WNBA" ? "WNBA" : "NBA";
  const ref = REF_TEAM_TOTAL[lg];
  const band = ENV_BAND[lg];
  const envDelta = v.team_total - ref;          // + = higher-scoring than avg
  const spreadMag = Math.abs(v.team_spread ?? 0);
  const blowout = spreadMag >= BLOWOUT[lg];

  const isOver = direction === "OVER";
  let signals_added = 0;
  let suppressor = false;
  let confidence_delta = 0;
  const notes = [];

  // Scoring environment — a high team total helps OVERs and hurts UNDERs.
  if (envDelta >= band) {
    if (isOver) { signals_added += 1; confidence_delta += 3; notes.push(`team total ${v.team_total} (+${envDelta.toFixed(0)} vs ${ref} avg) favors OVER`); }
    else { suppressor = true; confidence_delta -= 3; notes.push(`team total ${v.team_total} (+${envDelta.toFixed(0)} vs avg) works against UNDER`); }
  } else if (envDelta <= -band) {
    if (isOver) { suppressor = true; confidence_delta -= 3; notes.push(`team total ${v.team_total} (${envDelta.toFixed(0)} vs ${ref} avg) works against OVER`); }
    else { signals_added += 1; confidence_delta += 3; notes.push(`team total ${v.team_total} (${envDelta.toFixed(0)} vs avg) favors UNDER`); }
  }

  // Blowout — garbage-time caps a starter's counting-stat OVER, helps the UNDER.
  if (blowout) {
    if (isOver) { suppressor = true; confidence_delta -= 4; notes.push(`blowout risk (spread ${v.team_spread})`); }
    else { signals_added += 1; confidence_delta += 2; notes.push(`blowout helps UNDER (spread ${v.team_spread})`); }
  }

  const fired = signals_added > 0 || suppressor;
  const _vegas = {
    game_total: v.game_total,
    team_total: v.team_total,
    opp_total: v.opp_total,
    team_spread: v.team_spread,
    blowout,
  };
  if (!fired) return { fired: false, rule_id: "game-script", _vegas };

  const flag = suppressor && signals_added === 0
    ? `⚠️ Game-script headwind — ${notes.join("; ")}`
    : `✅ Game-script — ${notes.join("; ")}`;

  return {
    fired: true,
    rule_id: "game-script",
    confidence_delta: Math.max(-8, Math.min(6, confidence_delta)),
    suppressor,
    signals_added,
    flag,
    justification_part: `Game-script (Vegas) — ${notes.join("; ")}.`,
    _vegas,
  };
}
