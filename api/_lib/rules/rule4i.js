// Rule 4i — referenced in framework.js:237 suppressor priority
// (`Rule 6 → 4c → 4i → 5f → 5c`) but never defined in the v3.5 spec.
// Engine includes a no-op stub so the priority chain stays intact and
// future-proof. If the spec ever defines 4i, fill in here.

export function apply() {
  return { fired: false, rule_id: "4i" };
}
