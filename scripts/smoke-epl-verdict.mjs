// Hermetic smoke for the EPL verdict engine (api/_lib/epl/verdict.js):
// gates, model/market blend, tier caps, lineup handling, break-evens — on a
// tiny synthetic league fitted with the real model. No network, no files.

import { fitModel } from "../api/_lib/epl/model.js";
import { buildEplContext, eplVerdict, breakEven, EPL_POLICY } from "../api/_lib/epl/verdict.js";
import { parseLineup, lineupOverride } from "../api/_lib/epl/fotmob.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ─── Synthetic league: two teams, four rounds, fixed lineups ───────────────
const TEAMS = { 1: { name: "Alpha FC", short: "Alpha", abbr: "ALP" }, 2: { name: "Beta United", short: "Beta", abbr: "BET" } };
const SQUAD = [["GK", 11], ["CB", 34], ["FB", 32], ["CM", 64], ["W", 83], ["ST", 115]];
function snapshot() {
  const matches = [];
  const rows = [];
  for (let r = 1; r <= 4; r++) {
    const [home, away] = r % 2 ? ["1", "2"] : ["2", "1"];
    const id = `m${r}`;
    matches.push({ match_id: id, round: r, kickoff_utc: `2026-08-${10 + r}T15:00:00Z`, home: { team_id: home, score: 1 }, away: { team_id: away, score: 1 } });
    for (const team of [home, away]) {
      for (const [pos, pid] of SQUAD) {
        const st = pos === "ST";
        rows.push({
          match_id: id, player_id: `${team}-${pos}`, name: `${TEAMS[team].short} ${pos}`, team_id: team, gk: pos === "GK",
          started: true, minutes: 90, position_id: pid, usual_position_id: pos === "GK" ? 0 : 2,
          shots: st ? 4 : 1, sot: st ? 2 : 0, key_passes: 1, passes_att: 40, crosses_att: 1, dribbles_att: 1,
          tackles: pos === "CM" ? 3 : 1, clearances: pos === "CB" ? 5 : 1, fouls: 1, fouled: 1,
          xg: st ? 0.5 : 0.05, xa: 0.1, goals: 0, assists: 0, yellow_cards: 0, red_cards: 0,
          saves: pos === "GK" ? 3 : null,
        });
      }
      // A bench player who never plays (DNP-risk gate).
      rows.push({ match_id: id, player_id: `${team}-BENCH`, name: `${TEAMS[team].short} Bench`, team_id: team, gk: false, started: false, minutes: 0, usual_position_id: 2 });
    }
  }
  return { season: "test", matches, player_matches: rows };
}
const model = fitModel(snapshot(), { registry: null });
model.teams = Object.fromEntries(Object.entries(TEAMS).map(([id, t]) => [id, { abbr: t.abbr, name: t.name }]));
model.players["fpl:9"] = { ...model.players["1-CM"], name: "Prior Only", apps: 0, starts: 0, prior_only: true };
const KICKOFF = "2026-09-20T14:00:00Z";
model.fixtures = [{ match_id: "m5", round: 5, kickoff: KICKOFF, home_id: "1", away_id: "2" }];
const registry = { teams: TEAMS, players: {}, fpl_only: [{ fpl_id: 9, name: "Prior Only", fpl_name: "Prior", abbr: "ALP" }] };
const odds = {
  shading: { shots: 1.0 },
  matches: { "ALP-BET": { lambda: { home: 1.6, away: 1.1 } } },
  players: { "1-ST": { props: { shots: { lambda_hat: 4.0 } } } },
};
// Pinned clock before the synthetic kickoff, so the suite never ages out.
const NOW = Date.parse("2026-09-15T12:00:00Z");
const ctx = (lineups = new Map()) => buildEplContext({ model, registry, odds, lineups, now: NOW });
const prop = (player, stat, line, extra = {}) => ({ player, stat_type: stat, line, odds_type: "standard", player_team: "Alpha", opponent: "Beta", start_time: KICKOFF, ...extra });

console.log("[a] break-evens");
assert("standard 2-pick power = 57.7%", close(breakEven("standard"), 1 / Math.sqrt(3), 1e-12));
assert("goblin harder, demon easier", breakEven("goblin") > breakEven("standard") && breakEven("demon") < breakEven("standard"));

console.log("\n[b] gates");
const c0 = ctx();
const g = (v) => (v.pre_filtered ? v.skip_reason : `tier ${v.tier}`);
assert("unsupported stat", g(eplVerdict(prop("Alpha ST", "Goalie Fantasy Score", 9.5), "OVER", c0)) === "unsupported_stat");
assert("demon UNDER → over-only", g(eplVerdict(prop("Alpha ST", "Shots", 3.5, { odds_type: "demon" }), "UNDER", c0)) === "over_only_line");
assert("unknown team", g(eplVerdict(prop("Alpha ST", "Shots", 2.5, { opponent: "Gamma" }), "OVER", c0)) === "unresolved_team");
assert("no fixture for the pair", g(eplVerdict(prop("Alpha ST", "Shots", 2.5, { player_team: "Beta", opponent: "Beta" }), "OVER", c0)) === "no_fixture");
assert("unknown player", g(eplVerdict(prop("Nobody Here", "Shots", 2.5), "OVER", c0)) === "unresolved_player");
assert("prior-only player", g(eplVerdict(prop("Prior", "Shots", 0.5), "OVER", c0)) === "no_minutes_this_season");
assert("never-plays bench player → DNP risk", g(eplVerdict(prop("Alpha Bench", "Shots", 0.5), "OVER", c0)) === "dnp_risk");
assert("keeper stat on an outfielder", g(eplVerdict(prop("Alpha ST", "Goalie Saves", 2.5), "OVER", c0)) === "wrong_position_stat");
const late = buildEplContext({ model, registry, odds, now: Date.parse(KICKOFF) + 60000 });
assert("line after kickoff → game_started", g(eplVerdict(prop("Alpha ST", "Shots", 2.5), "OVER", late)) === "game_started");

console.log("\n[c] lineups");
const lineup = (type, starters, bench = [], unavailable = []) => parseLineup({ content: { lineup: {
  lineupType: type,
  homeTeam: { id: 1, starters: starters.map((id) => ({ id })), subs: bench.map((id) => ({ id })), unavailable: unavailable.map((id) => ({ id, unavailability: { type: "injury" } })) },
  awayTeam: { id: 2, starters: [], subs: [], unavailable: [] },
} } });
const conf = lineup("standard", ["1-ST"], ["1-CM"]);
assert("confirmed sheet parsed", conf.type === "confirmed" && conf.starters.has("1-ST") && conf.bench.has("1-CM"));
assert("override: starter / bench / out of squad", lineupOverride(conf, "1-ST").started === true && lineupOverride(conf, "1-CM").bench === true && lineupOverride(conf, "1-W").bench === false);
assert("predicted XI is a hint, not a sheet", lineupOverride(lineup("predicted", ["1-ST"]), "1-W").predicted === false);
const cConf = ctx(new Map([["m5", conf]]));
assert("not in confirmed squad → SKIP", g(eplVerdict(prop("Alpha W", "Shots", 0.5), "OVER", cConf)) === "not_in_squad");
const cInj = ctx(new Map([["m5", lineup("predicted", [], [], ["1-ST"])]]));
assert("listed injured → SKIP", g(eplVerdict(prop("Alpha ST", "Shots", 2.5), "OVER", cInj)) === "unavailable");
const started = eplVerdict(prop("Alpha ST", "Shots", 2.5), "OVER", cConf);
assert("confirmed starter: 100% to start", started.detail.p_start === 1 && started.detail.lineup === "confirmed" && started.rules_fired.includes("lineup:confirmed"));

console.log("\n[d] blend + tiers");
const v = eplVerdict(prop("Alpha ST", "Shots", 2.5), "OVER", c0);
const expected = sigmoid(EPL_POLICY.blend.model * logit(v.detail.p_model) + EPL_POLICY.blend.market * logit(v.detail.p_market));
assert("book-priced stat pools model + market in log-odds", !v.detail.model_only && close(v.prob, expected, 2e-3), `${v.prob} vs ${expected}`);
assert("confidence = rounded blended %", v.confidence === Math.round(v.prob * 100));
const mo = eplVerdict(prop("Alpha CB", "Clearances", 3.5), "OVER", c0);
assert("model-only stat shrunk toward the line", mo.detail.model_only && close(mo.prob, sigmoid(EPL_POLICY.modelOnlyShrink * logit(mo.detail.p_model)), 2e-3), `${mo.prob}`);
assert("model-only never above B", mo.tier === "SKIP" || mo.tier === "B");
assert("no S-tier while uncalibrated", ![v, mo].some((x) => x.tier === "S"));
const under = eplVerdict(prop("Alpha ST", "Shots", 2.5), "UNDER", c0);
assert("OVER + UNDER model probs complement (half line)", close(v.detail.p_model + under.detail.p_model, 1, 1e-3));
const demon = eplVerdict(prop("Alpha ST", "Shots", 1.5, { odds_type: "demon" }), "OVER", c0);
assert("demon edge measured vs demon break-even, capped ≤ B", close(demon.break_even, breakEven("demon"), 1e-3) && ["SKIP", "B"].includes(demon.tier), `${demon.tier}`);
assert("justification explains model / books / blend", /Model \d+%/.test(v.justification) && /books \d+%/.test(v.justification) && /break-even/.test(v.justification));
assert("verdict carries grading ids", v.player_id === "1-ST" && v.match_id === "m5" && v.game_start_time === KICKOFF);

console.log(`\nsmoke-epl-verdict: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
