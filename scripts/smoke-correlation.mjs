// Smoke for same-game correlation (api/_lib/correlation.js) and its use in the
// slate builder.

import { normInv, bvnCdf, legCorrelation, hitDistribution, hasSameGamePair, CORRELATION_PRIORS } from "../api/_lib/correlation.js";
import { normCdf } from "../api/_lib/distributions.js";
import { buildSlate } from "../api/_lib/slate-builder.js";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const near = (a, b, tol = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

check("normInv inverts normCdf", [0.01, 0.2, 0.5, 0.577, 0.9, 0.995].every((p) => near(normCdf(normInv(p)), p, 1e-7)));
check("normInv edges", normInv(0) === -Infinity && normInv(1) === Infinity && near(normInv(0.5), 0, 1e-7));
check("bvn ρ=0 is the product", near(bvnCdf(0.3, -0.4, 0), normCdf(0.3) * normCdf(-0.4), 1e-12));
check("bvn at 0,0: ¼ + asin(ρ)/2π", near(bvnCdf(0, 0, 0.5), 0.25 + Math.asin(0.5) / (2 * Math.PI), 1e-6));
check("bvn ρ<0 below the product", bvnCdf(0.2, 0.2, -0.4) < normCdf(0.2) ** 2);
check("bvn ρ→1 → min(Φ(h),Φ(k))", near(bvnCdf(0.1, 0.5, 0.999999), normCdf(0.1), 2e-3));

const leg = (o) => ({ prob: 0.6, direction: "OVER", league: "WNBA", stat: "Points", line: 10.5, ...o });
const a = leg({ player: "A", player_team: "X", gameCapKey: "X|Y" });
const tm = leg({ player: "B", player_team: "X", gameCapKey: "X|Y" });
const op = leg({ player: "C", player_team: "Y", gameCapKey: "X|Y" });
const other = leg({ player: "D", player_team: "Z", gameCapKey: "W|Z" });
check("different games → ρ 0", legCorrelation(a, other) === 0);
check("teammate ρ uses the teammate prior", near(legCorrelation(a, tm), CORRELATION_PRIORS.WNBA.teammate));
check("opponent ρ uses the opponent prior", near(legCorrelation(a, op), CORRELATION_PRIORS.WNBA.opponent));
check("same player is the strongest link", legCorrelation(a, { ...a, stat: "PRA" }) > legCorrelation(a, tm));
check("opposite directions flip the sign", near(legCorrelation(a, { ...tm, direction: "UNDER" }), -CORRELATION_PRIORS.WNBA.teammate));
check("unknown league falls back to the default table", near(legCorrelation({ ...a, league: "NFL" }, { ...tm, league: "NFL" }), CORRELATION_PRIORS.default.teammate));

const indep = hitDistribution([a, other, leg({ player: "E", gameCapKey: "Q|R" })]);
check("all different games = independent Poisson-binomial", near(indep[3], 0.6 ** 3, 1e-12) && near(indep.reduce((x, y) => x + y, 0), 1, 1e-12));
const pair = hitDistribution([a, tm]);
check("teammate pair: P(both) > p²", pair[2] > 0.36 && near(pair.reduce((x, y) => x + y, 0), 1, 1e-9));
check("pair marginals preserved", near(pair[1] / 2 + pair[2], 0.6, 1e-9));
const trio = hitDistribution([a, tm, op]);
check("3 legs in one game simulated, sums to 1", near(trio.reduce((x, y) => x + y, 0), 1, 1e-9) && trio[3] > 0.216);
check("simulation is deterministic", hitDistribution([a, tm, op])[3] === trio[3]);
const cache = new Map();
hitDistribution([a, tm, other], { cache });
check("group memo caches multi-leg games only", cache.size === 1);
check("hasSameGamePair", hasSameGamePair([a, tm]) && !hasSameGamePair([a, other]));

// Slate builder integration.
const cand = (player, team, game, prob, stat = "Points") => ({ player, stat_type: stat, direction: "OVER", line: 10.5, odds_type: "standard", prob, game, player_team: team, league: "WNBA" });
const board = [
  cand("P1", "AAA", "AAA@BBB", 0.66), cand("P1", "AAA", "AAA@BBB", 0.65, "Rebounds"),
  cand("P2", "AAA", "AAA@BBB", 0.64), cand("P3", "CCC", "CCC@DDD", 0.63), cand("P4", "EEE", "EEE@FFF", 0.62),
];
const one = buildSlate(board, { targetMultiplier: 5, size: 3, maxPerGame: 1 });
check("maxPerGame 1: legs from 3 games, not correlated", !one.abstained && !one.slate.correlated && new Set(one.slate.legs.map((l) => l.game)).size === 3);
check("maxPerGame 1: EV matches Π p", near(one.slate.p_all, 0.66 * 0.63 * 0.62, 1e-3));
const two = buildSlate(board, { targetMultiplier: 5, size: 3, maxPerGame: 2 });
const players = two.slate?.legs.map((l) => l.player) ?? [];
check("never two legs on one player, even with maxPerGame 2", players.length === 3 && new Set(players).size === 3);
check("same-game slate priced jointly", two.slate?.correlated === true);
const stacked = two.slate.legs.filter((l) => l.game === "AAA@BBB").length === 2;
check("joint p_all differs from Π p when stacked", !stacked || Math.abs(two.slate.p_all - two.slate.legs.reduce((x, l) => x * l.prob, 1)) > 1e-3);

console.log(`\nsmoke-correlation: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
