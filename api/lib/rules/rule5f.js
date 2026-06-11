// Rule 5f — Win-prob blowout suppressor + series-tied pre-tip override
// + series-lead closeout. Applies to OVER on any stat.
//
//   85-90% win prob  → A-tier max OVER.
//   >90% win prob    → A-tier max OVER; the flag ADVISES the line should
//                      sit 3+ below the L5 avg (operator judgment — the
//                      engine does not enforce that check).
//   Playoff series tied (leading_team_abbr === null) → suppressor
//                      DISABLED — unless pre-tip override fires.
//   Player's team has series lead at closeout threshold → FULLY ENGAGED
//                      on their OVER.
//   Opponent at closeout threshold → DISABLED (trailing team plays
//                      desperate).
//
// Pre-tip override (series-tied only): when win_prob ≥ 0.80 AND opponent
// has 2+ starters listed OUT/DOUBTFUL AND favored team is at home, treat
// as if win_prob ≥ 0.90 and apply >90% rules regardless of actual figure.

import { isPlayoffGame } from "./_helpers.js";

function isCloseoutThreshold(series, isWnba) {
  if (!series) return false;
  const playerWins = series.player_team_wins ?? 0;
  const oppWins = series.opponent_wins ?? 0;
  const round = String(series.round || "").toLowerCase();
  // Player at closeout threshold = within one win of clinching.
  // WNBA R1 = best-of-3, semis/conf = best-of-5, finals = best-of-7.
  if (isWnba) {
    if (round.includes("first") || round.includes("rd16")) {
      return playerWins === 1 && oppWins <= 1;
    }
    if (round.includes("semi") || round.includes("conf")) {
      return playerWins >= 2 && oppWins <= 2;
    }
    return playerWins >= 3 && oppWins <= 3;
  }
  // NBA — all rounds best-of-7.
  return playerWins >= 3 && oppWins <= 3;
}

function isOpponentCloseout(series, isWnba) {
  if (!series) return false;
  // Mirror logic with sides reversed.
  return isCloseoutThreshold(
    { ...series, player_team_wins: series.opponent_wins, opponent_wins: series.player_team_wins, round: series.round },
    isWnba
  );
}

export function apply(ctx) {
  const { groundTruth, direction } = ctx;
  if (direction !== "OVER") return { fired: false, rule_id: "5f" };

  const wp = groundTruth?.win_prob?.player_team_pct;
  if (wp == null || typeof wp !== "number") return { fired: false, rule_id: "5f" };

  const playoff = isPlayoffGame(groundTruth);
  const series = groundTruth?.series ?? null;
  const seriesTied = playoff && series?.leading_team_abbr == null;
  const isWnba = String(groundTruth?.league || "NBA").toUpperCase() === "WNBA";

  // Series-lead suppressor anchors.
  if (playoff && series) {
    if (isCloseoutThreshold(series, isWnba)) {
      // Player team at closeout — suppressor FULLY ENGAGED.
      return {
        fired: true,
        rule_id: "5f",
        tier_cap: "A",
        confidence_delta: -ctx.weights.suppressor_penalty,
        flag: "⚠️ Rule 5f — series closeout suppressor engaged",
        justification_part: `Rule 5f — player team within one win of clinching (${series.series_record}); blowout suppressor engaged.`,
        suppressor: true,
      };
    }
    if (isOpponentCloseout(series, isWnba)) {
      // Opponent at closeout — trailing team plays desperate, suppressor OFF.
      return { fired: false, rule_id: "5f", justification_part: "Rule 5f — opponent at closeout, suppressor disabled." };
    }
  }

  // Pre-tip override for series-tied games.
  let effectiveWp = wp;
  let overrideFired = false;
  if (seriesTied) {
    const oppOuts = (groundTruth?.mechanisms?.opponent_starters_out ?? 0);
    const homeAway = groundTruth?.home_away;
    if (wp >= 0.80 && oppOuts >= 2 && homeAway === "home") {
      effectiveWp = 0.91;
      overrideFired = true;
    } else {
      // Series tied, no override → suppressor disabled.
      return { fired: false, rule_id: "5f", justification_part: "Rule 5f — series tied, suppressor disabled." };
    }
  }

  // Apply win-prob band thresholds.
  if (effectiveWp >= 0.90) {
    return {
      fired: true,
      rule_id: "5f",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag: overrideFired
        ? "⚠️ Rule 5f — pre-tip blowout override (≥0.80 + 2 starters OUT + home)"
        : `⚠️ Rule 5f — heavy favorite (${(effectiveWp * 100).toFixed(0)}%); advisory: line should sit 3+ below L5 baseline (not enforced)`,
      justification_part: `Rule 5f — win_prob ${(effectiveWp * 100).toFixed(0)}%${overrideFired ? " (pre-tip override)" : ""}; OVER capped at A-tier.`,
      suppressor: true,
    };
  }
  if (effectiveWp >= 0.85) {
    return {
      fired: true,
      rule_id: "5f",
      tier_cap: "A",
      confidence_delta: -ctx.weights.suppressor_penalty,
      flag: `⚠️ Rule 5f — favorite (${(effectiveWp * 100).toFixed(0)}%) blowout suppressor`,
      justification_part: `Rule 5f — win_prob ${(effectiveWp * 100).toFixed(0)}%; OVER capped at A-tier.`,
      suppressor: true,
    };
  }

  return { fired: false, rule_id: "5f" };
}
