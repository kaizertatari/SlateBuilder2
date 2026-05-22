// Rule 5i — FT-Floor Insurance Guard. UNDER on Points/PRA invalid when
// player's FT-protected floor exceeds line. The Mechanism 1 override
// (confirmed minutes restriction) scales FT volume down proportionally.
// _helpers.computeFtFloorCheck does the math; this rule just decides
// SKIP vs valid + applies the Mechanism 1 / 2 / 3 confidence tier table.

import { computeFtFloorCheck, FT_FLOOR_PROPS } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (direction !== "UNDER" || !FT_FLOOR_PROPS.has(statType)) {
    return { fired: false, rule_id: "5i" };
  }

  const ft = computeFtFloorCheck({ groundTruth, line });
  if (!ft) return { fired: false, rule_id: "5i" };

  if (ft.invalid) {
    return {
      fired: true,
      rule_id: "5i",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: `⚠️ Rule 5i FT-floor violation: total_floor ${ft.totalFloor.toFixed(2)} ≥ line ${line}`,
      justification_part: `Rule 5i — FT-protected floor (${ft.fta} FTA × ${(ft.ftPct * 100).toFixed(0)}% + fg_floor ${ft.fgFloor}) = ${ft.totalFloor.toFixed(2)}, exceeds line ${line}; UNDER invalid.`,
      hard_skip: true,
    };
  }

  // Band check (line - 2 ≤ total_floor < line): UNDER A-tier max,
  // requires Mechanism 1 or 2 to be confirmed.
  const buffer = line - ft.totalFloor;
  if (buffer < 2) {
    const mech1 = groundTruth?.mechanisms?.mech1?.confirmed;
    const mech2 = groundTruth?.mechanisms?.mech2?.confirmed;
    if (!mech1 && !mech2) {
      return {
        fired: true,
        rule_id: "5i",
        tier_cap: "SKIP",
        confidence_delta: 0,
        flag: "⚠️ Rule 5i — total_floor within 2pts of line, no Mech 1 or 2 confirmed",
        justification_part: `Rule 5i — total_floor ${ft.totalFloor.toFixed(2)} within 2pts of line ${line} and no confirmed Mech 1/2; UNDER not safe.`,
        hard_skip: true,
      };
    }
    return {
      fired: true,
      rule_id: "5i",
      tier_cap: "A",
      confidence_delta: 0,
      flag: "⚠️ Rule 5i — narrow FT-floor margin, A-tier max",
      justification_part: `Rule 5i — total_floor ${ft.totalFloor.toFixed(2)} within 2pts of line ${line}; Mech ${mech1 ? "1" : "2"} confirmed; UNDER capped at A-tier.`,
    };
  }

  // total_floor < line - 2 — UNDER valid (other mechanism still required
  // for issuance; that's enforced by the UNDER mechanism gate elsewhere).
  return {
    fired: true,
    rule_id: "5i",
    tier_cap: null,
    confidence_delta: 0,
    flag: null,
    justification_part: `Rule 5i — total_floor ${ft.totalFloor.toFixed(2)} well below line ${line}; FT-floor clear.`,
  };
}
