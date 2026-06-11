// UNDER mechanism detection (framework lines 199-205).
//
// The framework's UNDER path requires identifying at least one named
// mechanism before issuing UNDER. Three mechanisms are recognized:
//   1. Minutes Compression — confirmed minutes restriction or rest
//   2. Role Compression    — teammate(s) OUT/DOUBTFUL → opportunity bump for player
//   3. Matchup Ceiling     — opponent defense top-tier by def_rank
//
// Today the LLM judged "confirmed minutes" qualitatively from injury
// prose. The engine replaces that with explicit structured checks
// against injury status text, injury_regions, and team-defense data.
// composeGroundTruth attaches the result so rule modules consume a
// stable shape (no per-rule re-derivation).

import { scaleFor } from "./rules/_helpers.js";
import { MINUTES_LIMITING_REGIONS } from "./injury-regions.js";

const MINUTES_RESTRICTION_PATTERN = /minutes restriction|load management|will rest|on a rest|rest day|sit out|limited minutes/i;

function findPlayerInjury(injuries, playerName) {
  if (!Array.isArray(injuries) || !playerName) return null;
  return injuries.find((e) => e?.player === playerName) ?? null;
}

function teammateAtThreshold(injuries, threshold) {
  if (!Array.isArray(injuries) || !threshold) return null;
  for (const entry of injuries) {
    const status = String(entry?.status || "").toUpperCase();
    const blocking = status.includes("OUT") || status.includes("DOUBTFUL");
    if (!blocking) continue;
    const ppg = entry?.season_ppg ?? entry?.ppg ?? null;
    if (ppg != null && ppg >= threshold) {
      return { player: entry.player, status, ppg };
    }
  }
  return null;
}

/**
 * Detect which UNDER mechanisms are confirmed for this prop.
 *
 * @param {Object} groundTruth - composed ground truth (must include injuries,
 *   injury_regions, opponent_defense, season averages, info.full_name)
 * @returns {{ mech1: Object, mech2: Object, mech3: Object }}
 */
export function detectMechanisms(groundTruth) {
  const scale = scaleFor(groundTruth);
  const playerName = groundTruth?.info?.full_name ?? null;
  const ownInjuries = groundTruth?.injuries?.player_team ?? [];
  const oppInjuries = groundTruth?.injuries?.opponent ?? [];

  // Mechanism 1 — confirmed minutes restriction.
  const ownInjury = findPlayerInjury(ownInjuries, playerName);
  const detailMatch = ownInjury?.detail && MINUTES_RESTRICTION_PATTERN.test(ownInjury.detail);
  const regions = groundTruth?.injury_regions?.[playerName] ?? null;
  const regionImplies = regions && Object.entries(regions).some(([k, v]) => v && MINUTES_LIMITING_REGIONS.has(k));
  const mech1Confirmed = !!(detailMatch || regionImplies);
  // Surface mech1 as a "minutes_restriction" value when the prose names
  // a number; otherwise null (the FT-floor mechanism-1 override only
  // kicks in when a numeric R is present).
  let restriction = null;
  if (ownInjury?.detail) {
    const m = String(ownInjury.detail).match(/(\d{1,2})\s*(?:min|minutes?|m)/i);
    if (m) restriction = Number(m[1]);
  }

  // Mechanism 2 — teammate role compression (own-team OUT/DOUBTFUL at multi-star threshold).
  const teammate = teammateAtThreshold(ownInjuries, scale.multi_star_ppg_threshold);
  const mech2 = teammate
    ? { confirmed: true, teammate: teammate.player, teammate_ppg: teammate.ppg, status: teammate.status }
    : { confirmed: false };

  // Mechanism 3 — matchup ceiling (opponent def_rank top tier).
  const defRank = groundTruth?.opponent_defense?.def_rank ?? null;
  const mech3 = defRank != null && defRank <= scale.def_rank_top_tier
    ? { confirmed: true, def_rank: defRank, top_tier: scale.def_rank_top_tier }
    : { confirmed: false, def_rank: defRank };

  return {
    mech1: {
      confirmed: mech1Confirmed,
      restriction,
      source: detailMatch ? "detail_text" : (regionImplies ? "injury_region" : null),
    },
    mech2,
    mech3,
    // Also surface oppInjuries-count for Rule 5f pre-tip override.
    opponent_starters_out: oppInjuries.filter((e) => {
      const s = String(e?.status || "").toUpperCase();
      return s.includes("OUT") || s.includes("DOUBTFUL");
    }).length,
  };
}
