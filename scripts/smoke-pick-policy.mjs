// Smoke for the shared pick policy (api/_lib/pick-policy.js).

import { breakEven, blendProb, tierForEdge, capTier, logit, sigmoid } from "../api/_lib/pick-policy.js";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const policy = { tierEdge: { A: 0.05, B: 0.015 }, maxTier: "A", approxPayoutMaxTier: "B", modelOnlyMaxTier: "B" };

check("standard break-even = 1/√3 (2-pick power 3×)", near(breakEven("standard"), 1 / Math.sqrt(3)));
check("goblin harder, demon easier, unknown = standard", breakEven("goblin") > breakEven("standard") && breakEven("demon") < breakEven("standard") && breakEven("xyz") === breakEven("standard"));

const b = blendProb({ pModel: 0.7, pMarket: 0.6, blend: { model: 0.5, market: 0.5 }, modelOnlyShrink: 0.5 });
check("blend pools in log-odds", !b.modelOnly && near(b.prob, sigmoid(0.5 * logit(0.7) + 0.5 * logit(0.6))));
const mo = blendProb({ pModel: 0.7, pMarket: null, blend: { model: 0.5, market: 0.5 }, modelOnlyShrink: 0.5 });
check("no market → model-only, shrunk toward 50%", mo.modelOnly && mo.prob < 0.7 && mo.prob > 0.5);
check("shrink 0 → exactly 50%", near(blendProb({ pModel: 0.9, blend: { model: 1, market: 0 }, modelOnlyShrink: 0 }).prob, 0.5));
check("extreme probabilities are clamped, never ±∞", Number.isFinite(logit(1e-4)) && blendProb({ pModel: 1, pMarket: 0, blend: { model: 1, market: 1 }, modelOnlyShrink: 1 }).prob > 0);

const be = breakEven("standard");
check("edge ≥ A threshold → A", tierForEdge(be + 0.06, "standard", policy).tier === "A");
check("edge between B and A → B", tierForEdge(be + 0.02, "standard", policy).tier === "B");
check("edge below B → SKIP", tierForEdge(be + 0.01, "standard", policy).tier === "SKIP");
check("S threshold respected only when maxTier allows", tierForEdge(be + 0.2, "standard", { ...policy, tierEdge: { ...policy.tierEdge, S: 0.1 } }).tier === "A"
  && tierForEdge(be + 0.2, "standard", { ...policy, maxTier: "S", tierEdge: { ...policy.tierEdge, S: 0.1 } }).tier === "S");
const gob = tierForEdge(breakEven("goblin") + 0.1, "goblin", policy);
check("goblin edge measured vs goblin break-even and capped at B", gob.tier === "B" && near(gob.break_even, breakEven("goblin")) && gob.rules.includes("cap:approx-payout"));
check("goblin at a standard-looking 70% is a SKIP", tierForEdge(0.7, "goblin", policy).tier === "SKIP");
const m = tierForEdge(be + 0.1, "standard", policy, { modelOnly: true });
check("model-only capped at B with a flag", m.tier === "B" && m.rules.includes("cap:model-only") && m.flags.length === 1);
check("SKIP carries no caps", tierForEdge(0.3, "goblin", policy, { modelOnly: true }).rules.length === 0);
check("capTier never raises a tier", capTier("B", "A") === "B" && capTier("S", "B") === "B" && capTier("SKIP", "S") === "SKIP");

console.log(`\nsmoke-pick-policy: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
