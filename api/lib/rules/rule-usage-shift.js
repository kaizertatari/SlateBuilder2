// Rule: Usage shift — Stage 4 role-change signal (OVER side).
//
// The plan's highest-leverage edge: when a high-usage teammate is OUT, the
// player's usage/minutes/production jump immediately but the prop line lags —
// the "role-shift staleness" edge. mechanisms.mech2 detects that (a star
// own-teammate OUT/DOUBTFUL at the per-league ppg threshold); Stage-4b injury
// enrichment finally gives it the teammate ppg it needs to fire.
//
//   • mech2 confirmed (star teammate out)      → OVER usage tailwind (signal)
//   • mech1 confirmed (own minutes restriction) → OVER suppressor (fewer minutes)
//
// OVER-only by design: rule-under-mechanism already folds mech1/2/3 into the
// UNDER path, so handling UNDER here would double-count. This rule fills the
// symmetric OVER-side gap, where neither mechanism was previously expressed.
// Counting stats only; no-ops when no mechanism is confirmed.

const COUNTING_STATS = new Set([
  "Points", "Rebounds", "Assists", "3-Pointers Made", "PRA", "PR", "PA", "RA",
]);

export function apply(ctx) {
  const { groundTruth, statType, direction } = ctx;
  if (direction !== "OVER" || !COUNTING_STATS.has(statType)) {
    return { fired: false, rule_id: "usage-shift" };
  }

  const mechs = groundTruth?.mechanisms ?? {};
  const m2 = mechs.mech2?.confirmed ? mechs.mech2 : null;   // star teammate out
  const m1 = mechs.mech1?.confirmed ? mechs.mech1 : null;   // own minutes restriction

  const _usage = {
    teammate_out: m2?.teammate ?? null,
    teammate_ppg: m2?.teammate_ppg ?? null,
    minutes_restriction: m1 ? (m1.restriction ?? true) : null,
  };
  if (!m1 && !m2) return { fired: false, rule_id: "usage-shift", _usage };

  let signals_added = 0;
  let suppressor = false;
  let confidence_delta = 0;
  const notes = [];

  if (m2) {
    signals_added += 1;
    confidence_delta += 4;
    notes.push(`${m2.teammate} out (${m2.teammate_ppg} ppg) → usage redistribution`);
  }
  if (m1) {
    suppressor = true;
    confidence_delta -= 4;
    notes.push(`minutes restriction${m1.restriction ? ` (~${m1.restriction}m)` : ""}`);
  }

  return {
    fired: true,
    rule_id: "usage-shift",
    confidence_delta: Math.max(-8, Math.min(6, confidence_delta)),
    suppressor,
    signals_added,
    flag: m1 && !m2
      ? `⚠️ Usage — ${notes.join("; ")}`
      : `✅ Usage — ${notes.join("; ")}`,
    justification_part: `Usage shift — ${notes.join("; ")}.`,
    _usage,
  };
}
