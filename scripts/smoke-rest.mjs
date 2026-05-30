// Smoke for rule-rest (Stage 4 schedule-density fatigue). No network.
//   node scripts/smoke-rest.mjs
import { apply } from "../api/lib/rules/rule-rest.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };
const ctx = ({ statType = "Points", direction = "OVER", rest }) => ({ groundTruth: { rest }, statType, direction });

// A) OVER + back-to-back → suppressor
{
  const r = apply(ctx({ direction: "OVER", rest: { rest_days: 1, back_to_back: true, three_in_four: false } }));
  ok(r.fired && r.suppressor && r.confidence_delta < 0 && r.signals_added === 0, "A: OVER b2b → suppressor");
}
// B) 3-in-4 is heavier than a lone back-to-back
{
  const b2b = apply(ctx({ direction: "OVER", rest: { rest_days: 1, back_to_back: true, three_in_four: false } }));
  const t34 = apply(ctx({ direction: "OVER", rest: { rest_days: 1, back_to_back: true, three_in_four: true } }));
  ok(t34.confidence_delta < b2b.confidence_delta, "B: 3-in-4 heavier than b2b");
}
// C) UNDER + back-to-back → signal (fatigue favors under)
{
  const r = apply(ctx({ direction: "UNDER", rest: { rest_days: 1, back_to_back: true, three_in_four: false } }));
  ok(r.fired && !r.suppressor && r.signals_added >= 1 && r.confidence_delta > 0, "C: UNDER b2b → signal");
}
// D) rested → no fire, but _rest surfaced
{
  const r = apply(ctx({ direction: "OVER", rest: { rest_days: 3, back_to_back: false, three_in_four: false } }));
  ok(!r.fired && r._rest && r._rest.rest_days === 3, "D: rested → no fire, _rest present");
}
// E) non-counting stat → no fire
{
  const r = apply(ctx({ statType: "Blocks", direction: "OVER", rest: { rest_days: 1, back_to_back: true, three_in_four: false } }));
  ok(!r.fired, "E: non-counting stat → no fire");
}
// F) no rest block → no fire
{
  const r = apply(ctx({ direction: "OVER", rest: null }));
  ok(!r.fired, "F: no rest data → no fire");
}

console.log(`\nsmoke-rest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
