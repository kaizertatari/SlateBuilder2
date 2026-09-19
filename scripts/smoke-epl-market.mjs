// Hermetic smoke for the EPL market math (api/_lib/epl/market.js) and the
// team/player name resolvers (api/_lib/epl/names.js). No network.

import { americanToProb, devig, poissonTail, poissonPmfs, fitLadder, fitTeamLambdas } from "../api/_lib/epl/market.js";
import { normPlayer, buildTeamResolver, buildPlayerResolver } from "../api/_lib/epl/names.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("[a] odds conversion");
assert("−500 (unicode minus) → 83.3%", close(americanToProb("−500"), 500 / 600, 1e-12));
assert("+165 → 37.7%", close(americanToProb("+165"), 100 / 265, 1e-12));
assert("numeric 100 → 50%", americanToProb(100) === 0.5);
assert("garbage → null", americanToProb("n/a") === null && americanToProb(0) === null);
const dv = devig([0.55, 0.3, 0.25]);
assert("de-vig sums to 1 and keeps ratios", close(dv[0] + dv[1] + dv[2], 1, 1e-12) && close(dv[0] / dv[1], 0.55 / 0.3, 1e-12));
assert("de-vig with a missing side → null", devig([0.5, null]) === null);
assert("Poisson tail", close(poissonTail(2, 1), 1 - Math.exp(-2), 1e-12) && poissonTail(2, 0) === 1);

console.log("\n[b] team goal expectations from match markets");
{
  // Exact market for λ_home 1.8, λ_away 0.9, then fit it back.
  const ph = poissonPmfs(1.8, 12), pa = poissonPmfs(0.9, 12);
  let home = 0, draw = 0, away = 0;
  const tot = new Array(25).fill(0);
  for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
    const p = ph[i] * pa[j];
    if (i > j) home += p; else if (i === j) draw += p; else away += p;
    tot[i + j] += p;
  }
  const over = (pmf, line) => 1 - pmf.slice(0, Math.floor(line) + 1).reduce((a, b) => a + b, 0);
  const fit = fitTeamLambdas({
    result: { home, draw, away },
    totals: [{ line: 2.5, over: over(tot, 2.5) }, { line: 1.5, over: over(tot, 1.5) }],
    homeTotals: [{ line: 1.5, over: over(ph, 1.5) }],
    awayTotals: [{ line: 0.5, over: over(pa, 0.5) }],
  });
  assert("recovers λ_home / λ_away", close(fit.home, 1.8, 0.01) && close(fit.away, 0.9, 0.01), JSON.stringify(fit));
  assert("near-zero residual on an exact market", fit.rmse < 0.002, String(fit.rmse));
  assert("needs ≥ 2 observations", fitTeamLambdas({ result: null, totals: [{ line: 2.5, over: 0.5 }] }) === null);
}

console.log("\n[c] one-sided ladder fit");
{
  const lam = 2.6, c = 1.05;
  const rungs = [1, 2, 3, 4].map((k) => ({ k, implied: Math.min(0.98, c * poissonTail(lam, k)) }));
  const fit = fitLadder(rungs);
  assert("recovers the ladder's λ", close(fit.lambda, lam, 0.1), JSON.stringify(fit));
  assert("recovers the overround", close(fit.overround, c, 0.03), JSON.stringify(fit));
  const one = fitLadder([{ k: 1, implied: 0.5 }]);
  assert("single rung: default overround, λ inverted", one.rungs_used === 1 && close(poissonTail(one.lambda, 1), 0.5 / 1.06, 1e-3));
  assert("no usable rungs → null", fitLadder([{ k: 1, implied: 0.995 }]) === null && fitLadder([]) === null);
}

console.log("\n[d] name resolution");
assert("dotless ı / ø transliterate", normPlayer("Ferdi Kadıoğlu") === normPlayer("Ferdi Kadioglu") && normPlayer("Martin Ødegaard") === normPlayer("Martin Odegaard"));
assert("hyphen = space", normPlayer("Kiernan Dewsbury-Hall") === normPlayer("Kiernan Dewsbury Hall"));
const registry = {
  teams: {
    1: { name: "Tottenham Hotspur", short: "Tottenham", abbr: "TOT" },
    2: { name: "Nottingham Forest", short: "Nottm Forest", abbr: "NFO" },
    3: { name: "Hull City", short: "Hull", abbr: "HUL" },
    4: { name: "Brighton & Hove Albion", short: "Brighton", abbr: "BHA" },
    5: { name: "Arsenal", short: "Arsenal", abbr: "ARS" },
    6: { name: "Newcastle United", short: "Newcastle", abbr: "NEW" },
  },
  players: {
    p1: { fpl_name: "McBurnie", first_name: "Oliver", second_name: "McBurnie" },
    p2: { fpl_name: "Gabriel", first_name: "Gabriel", second_name: "dos Santos Magalhães" },
  },
  fpl_only: [{ fpl_id: 99, name: "Joelinton Cássio Apolinário de Lira", fpl_name: "Joelinton", abbr: "NEW" }],
};
const team = buildTeamResolver(registry);
assert("book team spellings", team("Spurs") === "TOT" && team("Forest") === "NFO" && team("Nottm Forest") === "NFO" && team("Hull City AFC") === "HUL" && team("Brighton & Hove Albion FC") === "BHA");
assert("unknown team → null", team("Real Madrid") === null && team("") === null);
const model = {
  teams: { 3: { abbr: "HUL" }, 5: { abbr: "ARS" }, 6: { abbr: "NEW" } },
  players: {
    p1: { name: "Oli McBurnie", team_id: "3" },
    p2: { name: "Gabriel", team_id: "5" },
    p3: { name: "Gabriel Jesus", team_id: "5" },
    p4: { name: "Gabriel", team_id: "6" },
    "fpl:99": { name: "Joelinton Cássio Apolinário de Lira", team_id: "6", prior_only: true },
  },
};
const player = buildPlayerResolver(model, registry);
assert("exact name within team", player("Gabriel Jesus", "ARS")?.id === "p3");
assert("same name, team decides", player("Gabriel", "ARS")?.id === "p2" && player("Gabriel", "NEW")?.id === "p4");
assert("nickname via surname in team (Oliver → Oli)", player("Oliver McBurnie", "HUL")?.id === "p1");
assert("long form via FPL name (Gabriel Magalhães)", player("Gabriel Magalhães", "ARS")?.id === "p2");
assert("prior-only by FPL short name", player("Joelinton", "NEW")?.id === "fpl:99");
assert("ambiguous without a team → null", player("Gabriel") === null);
assert("unknown player → null", player("Harvey Foster", "HUL") === null);

console.log(`\nsmoke-epl-market: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
