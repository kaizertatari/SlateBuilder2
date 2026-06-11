// Rule 5b — rebound + block-prop suppressors.
//   5b.i  Foul-Prone Matchup: 2+ frontcourt (C/PF) on either team with
//         mobility-limiting injuries → reduce rebound expectation by
//         1.5 boards on OVER side. Tier-cap to A-max.
//         Also fires on Blks+Stls OVER — frontcourt mobility-impaired
//         players draw fouls instead of contesting shots, capping the
//         minutes available for blocks.
//   5b.ii Shooting-Slump: player has shot fg_pct < 0.35 in 2+ of l5.games
//         → -15% on rebound OVER. Tier-cap to A-max.
//         Rebound-family only; Blks+Stls aren't FG-dependent.

// (No helpers imported — this rule reads injuries/regions/l5 directly.)

const REBOUND_FAMILY = new Set(["Rebounds", "PR", "RA", "PRA"]);
// Block-family props that share the foul-prone (5b.i) suppressor logic.
// Standalone Blocks/Steals aren't in STATS today; if they're ever added,
// extend this set + the buffer table.
const BLOCK_FAMILY = new Set(["Blocks+Steals"]);
const MOBILITY_REGIONS = ["knee", "ankle", "lower_leg", "achilles", "hip", "back"];

function isFrontcourtName(playerName, regions) {
  // Without a roster→position map we can't strictly classify C/PF. The
  // framework intentionally tolerates name-based heuristics (line 199).
  // For now, treat any mobility-region injury as a candidate — the rule
  // is "2+ frontcourt with mobility-limiting", so we approximate by
  // requiring the injury entry to have a relevant region. False positives
  // here are conservative (suppressor caps at A-max, doesn't SKIP).
  if (!regions) return false;
  return MOBILITY_REGIONS.some((r) => regions[r]);
}

function countMobilityImpaired(injuries, injuryRegions) {
  if (!Array.isArray(injuries) || !injuryRegions) return 0;
  let count = 0;
  for (const e of injuries) {
    const status = String(e?.status || "").toUpperCase();
    if (!(status.includes("OUT") || status.includes("DOUBTFUL") || status.includes("QUESTIONABLE"))) continue;
    const regions = injuryRegions[e.player];
    if (isFrontcourtName(e.player, regions)) count += 1;
  }
  return count;
}

export function apply(ctx) {
  const { groundTruth, statType, direction } = ctx;
  if (direction !== "OVER") return { fired: false, rule_id: "5b" };
  const isRebound = REBOUND_FAMILY.has(statType);
  const isBlock = BLOCK_FAMILY.has(statType);
  if (!isRebound && !isBlock) return { fired: false, rule_id: "5b" };

  const own = groundTruth?.injuries?.player_team ?? [];
  const opp = groundTruth?.injuries?.opponent ?? [];
  const regions = groundTruth?.injury_regions ?? {};
  const ownImpaired = countMobilityImpaired(own, regions);
  const oppImpaired = countMobilityImpaired(opp, regions);
  const foulProne = (ownImpaired + oppImpaired) >= 2;

  // 5b.ii shooting slump — raw L5 game-level fg_pct. Rebound family only;
  // a cold shooting stretch doesn't suppress block/steal opportunities.
  const l5Games = groundTruth?.l5?.games ?? [];
  const slumpGames = isRebound
    ? l5Games.filter((g) => (g?.fg_pct ?? 1) < 0.35).length
    : 0;
  const slump = isRebound && slumpGames >= 2;

  if (!foulProne && !slump) {
    return { fired: false, rule_id: "5b" };
  }

  const parts = [];
  if (foulProne) parts.push(`5b.i foul-prone matchup (${ownImpaired + oppImpaired} frontcourt mobility-impaired)`);
  if (slump) parts.push(`5b.ii shooting slump (${slumpGames} of last 5 games <35% FG)`);

  const propLabel = isRebound ? "rebound" : "block/steal";
  return {
    fired: true,
    rule_id: "5b",
    tier_cap: "A",
    confidence_delta: -ctx.weights.suppressor_penalty,
    flag: `⚠️ ${parts.join(" + ")}`,
    justification_part: `Rule 5b — ${parts.join("; ")}; ${propLabel} OVER capped at A-tier.`,
    suppressor: true,
  };
}
