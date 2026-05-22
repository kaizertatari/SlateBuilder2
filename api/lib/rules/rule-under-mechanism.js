// UNDER mechanism gate (framework lines 198-213).
//
// UNDER props are NOT issued by default. The framework requires at
// least one named mechanism (Mech 1 / 2 / 3) to be confirmed; without
// one, the verdict is SKIP. With one or more, the tier ceiling is
// fixed by the confidence table:
//
//   3 mechanisms confirmed       = S possible
//   2 mechanisms                 = A max
//   Mech 1 alone (minutes)       = A max
//   Mech 2 alone (role)          = B max, SKIP advisory
//   Mech 3 alone (matchup)       = B max, SKIP advisory
//   No mechanism                 = SKIP
//
// Rule 5i has its own UNDER path for Points/PRA (FT-floor with
// Mechanism-1 override). When 5i clears (totalFloor well below line),
// the prop already has a numeric reason to issue UNDER and this
// mechanism gate can pass with a single mechanism. When 5i fires SKIP,
// this rule never sees the verdict (5a hard-skips first).

import { computeFtFloorCheck, FT_FLOOR_PROPS } from "./_helpers.js";

export function apply(ctx) {
  const { groundTruth, statType, direction, line } = ctx;
  if (direction !== "UNDER") return { fired: false, rule_id: "under-mechanism" };

  const mechs = groundTruth?.mechanisms ?? {};
  const m1 = !!mechs.mech1?.confirmed;
  const m2 = !!mechs.mech2?.confirmed;
  const m3 = !!mechs.mech3?.confirmed;
  const count = (m1 ? 1 : 0) + (m2 ? 1 : 0) + (m3 ? 1 : 0);

  // Special case: Points/PRA UNDER with a comfortable FT-floor margin
  // gives the verdict a numeric foundation that the framework treats
  // as functionally equivalent to a confirmed mechanism. If the floor
  // clears by >2 pts, allow A-tier with no other mechanism required.
  let ftFloorClears = false;
  if (FT_FLOOR_PROPS.has(statType)) {
    const ft = computeFtFloorCheck({ groundTruth, line });
    if (ft && !ft.invalid && (line - ft.totalFloor) >= 2) {
      ftFloorClears = true;
    }
  }

  if (count === 0 && !ftFloorClears) {
    return {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: "SKIP",
      confidence_delta: 0,
      flag: "⚠️ no named UNDER mechanism (Mech 1/2/3 all unconfirmed)",
      justification_part: "UNDER mechanism gate — no Mechanism 1, 2, or 3 confirmed; SKIP.",
      hard_skip: true,
    };
  }

  // Map confirmed mechanisms to the framework's confidence table.
  const fragments = [];
  if (m1) fragments.push("Mech 1 (minutes)");
  if (m2) fragments.push("Mech 2 (role)");
  if (m3) fragments.push("Mech 3 (matchup)");
  if (ftFloorClears && fragments.length === 0) fragments.push("5i FT-floor clear");

  if (count >= 3) {
    return {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: null,            // allow S consideration
      confidence_delta: ctx.weights.signal_bonus,
      flag: null,
      justification_part: `UNDER mechanism gate — 3 mechanisms confirmed (${fragments.join(", ")}); S possible.`,
    };
  }
  if (count === 2) {
    return {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: "A",
      confidence_delta: 0,
      flag: null,
      justification_part: `UNDER mechanism gate — 2 mechanisms confirmed (${fragments.join(", ")}); A-tier max.`,
    };
  }
  // Single-mechanism cases.
  if (m1 || ftFloorClears) {
    return {
      fired: true,
      rule_id: "under-mechanism",
      tier_cap: "A",
      confidence_delta: 0,
      flag: null,
      justification_part: `UNDER mechanism gate — ${ftFloorClears ? "5i FT-floor clears comfortably" : "Mech 1 (minutes) confirmed"}; A-tier max.`,
    };
  }
  // Mech 2 alone or Mech 3 alone → B-tier max with SKIP advisory.
  return {
    fired: true,
    rule_id: "under-mechanism",
    tier_cap: "B",
    confidence_delta: -ctx.weights.suppressor_penalty,
    flag: `⚠️ UNDER mechanism single-signal (${m2 ? "Mech 2" : "Mech 3"} only) — B-tier max, SKIP advisory`,
    justification_part: `UNDER mechanism gate — only ${m2 ? "Mech 2 (role)" : "Mech 3 (matchup)"} confirmed; B-tier max with SKIP advisory.`,
  };
}
