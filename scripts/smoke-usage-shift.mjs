// Smoke for rule-usage-shift (Stage 4b role-change OVER signal). No network.
//   node scripts/smoke-usage-shift.mjs
import { apply } from "../api/lib/rules/rule-usage-shift.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };
const ctx = ({ statType = "Points", direction = "OVER", mechanisms }) => ({ groundTruth: { mechanisms }, statType, direction });
const m2 = { confirmed: true, teammate: "Star Guy", teammate_ppg: 22, status: "OUT" };
const m1 = { confirmed: true, restriction: 24 };

// A) mech2 (star teammate out) + OVER → usage tailwind
{
  const r = apply(ctx({ mechanisms: { mech2: m2 } }));
  ok(r.fired && r.signals_added >= 1 && !r.suppressor && r.confidence_delta > 0, "A: mech2 OVER → signal");
  ok(r._usage && r._usage.teammate_out === "Star Guy" && r._usage.teammate_ppg === 22, "A: _usage carries teammate");
}
// B) mech1 (own minutes restriction) + OVER → suppressor
{
  const r = apply(ctx({ mechanisms: { mech1: m1 } }));
  ok(r.fired && r.suppressor && r.confidence_delta < 0 && r._usage.minutes_restriction === 24, "B: mech1 OVER → suppressor");
}
// C) both → signal AND suppressor (conflicting role signals)
{
  const r = apply(ctx({ mechanisms: { mech1: m1, mech2: m2 } }));
  ok(r.fired && r.signals_added >= 1 && r.suppressor, "C: mech1+mech2 both fire");
}
// D) UNDER → no fire (rule-under-mechanism owns UNDER)
{
  const r = apply(ctx({ direction: "UNDER", mechanisms: { mech2: m2 } }));
  ok(!r.fired, "D: UNDER → no fire (under-mechanism owns it)");
}
// E) non-counting stat → no fire
{
  const r = apply(ctx({ statType: "Blocks", mechanisms: { mech2: m2 } }));
  ok(!r.fired, "E: non-counting stat → no fire");
}
// F) no confirmed mechanism → no fire, _usage surfaced
{
  const r = apply(ctx({ mechanisms: { mech1: { confirmed: false }, mech2: { confirmed: false } } }));
  ok(!r.fired && r._usage, "F: no mechanism → no fire, _usage present");
}

console.log(`\nsmoke-usage-shift: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
