// Smoke for the NFL verdict engine (api/_lib/nfl/verdict.js), the name /
// team resolver (names.js) and the market tilt (distributions.js), on a
// handcrafted model + odds snapshot so a data refresh can't move it.

import { buildNflContext, nflVerdict, mapNflStat, kickoffOf, NFL_POLICY } from "../api/_lib/nfl/verdict.js";
import { buildPlayerResolver, nflTeam, normName } from "../api/_lib/nfl/names.js";
import { NFL_MODEL_PARAMS } from "../api/_lib/nfl/model.js";
import { tiltToMarket, tiltedLineProbs, sampleLineProbs, mulberry32, sampleNormal } from "../api/_lib/distributions.js";

let pass = 0, fail = 0;
const check = (name, ok, info = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !info ? "" : ` — ${info}`}`); };
const near = (a, b, t = 1e-3) => Number.isFinite(a) && Math.abs(a - b) <= t;

// ─── Tilt ────────────────────────────────────────────────────────────────────
const rng = mulberry32(7);
const draws = Array.from({ length: 20000 }, () => Math.round(200 + 60 * sampleNormal(rng)));
const t = tiltToMarket(draws, 220.5, 0.5);
check("tilt: hits the market price at the book line", t && near(tiltedLineProbs(220.5, t).over, 0.5, 1e-6));
check("tilt: shifts the mean to the book level, keeps the spread", t && Math.abs(t.mean - 220.5) < 2 && near(tiltedLineProbs(280.5, t).over, 0.16, 0.02), t && `${t.mean} ${tiltedLineProbs(280.5, t).over}`);
check("tilt: no-op when the model already agrees", near(tiltToMarket(draws, 200.5, sampleLineProbs(200.5, draws).over).theta, 0, 1e-3));
check("tilt: unreachable target → null", tiltToMarket([0, 0, 1], 5.5, 0.5) === null && tiltToMarket(draws, 220.5, 1) === null);

// ─── Names / teams / stats ───────────────────────────────────────────────────
check("nflTeam: PP + book spellings", nflTeam("LAR") === "LA" && nflTeam("WSH") === "WAS" && nflTeam("JAC") === "JAX" && nflTeam("KC") === "KC" && nflTeam("Los Angeles Chargers") === "LAC" && nflTeam("Narnia") === null);
check("normName drops suffixes / punctuation / accents", normName("Kyle Pitts Sr.") === "kyle pitts" && normName("Amon-Ra St. Brown") === "amon ra st brown" && normName("D'Andre Swift") === "dandre swift");
const reg = {
  a: { name: "Kyle Pitts", team: "ATL" }, b: { name: "Marvin Mims Jr.", team: "DEN" }, c: { name: "Cameron Skattebo", team: "NYG" },
  d: { name: "Marquise Brown", team: "PHI" }, e: { name: "Mike Williams", team: "NYJ", last: { season: 2025, week: 4 } }, f: { name: "Mike Williams", team: "PIT", last: { season: 2026, week: 5 } },
};
const res = buildPlayerResolver(reg);
check("resolver: suffix variants", res("Kyle Pitts Sr.", "ATL") === "a" && res("Marvin Mims", "DEN") === "b");
check("resolver: first-name variant via last name + initial on the team", res("Cam Skattebo", "NYG") === "c" && res("Cam Skattebo", null) === null);
check("resolver: alias table", res("Hollywood Brown", "PHI") === "d");
check("resolver: same name, team decides", res("Mike Williams", "PIT") === "f" && res("Mike Williams", "NYJ") === "e");
check("mapNflStat: case-insensitive, unknown → null", mapNflStat("Pass Yards") === "pass_yds" && mapNflStat("RUSH+REC YDS") === "rush_rec_yds" && mapNflStat("Longest Rush") === null);
check("kickoffOf: EDT before Nov 1, EST after", kickoffOf({ gameday: "2026-10-15", gametime: "20:15" }) === Date.parse("2026-10-16T00:15:00Z") && kickoffOf({ gameday: "2026-11-08", gametime: "13:00" }) === Date.parse("2026-11-08T18:00:00Z"));

// ─── Verdicts on a handcrafted model ─────────────────────────────────────────
const flat = (mean, sigma) => ({ coef: [mean, 0, 0], seasonAdj: 0, sigma, off: {}, def: {} });
const last = { season: 2026, week: 5 };
const wr = (name, extra = {}) => ({ pos: "WR", team: "SEA", name, status: "ACT", last, games: 5, tgtShare: 0.25, carShare: 0, catch: 0.68, ypr: 12.5, ypc: 0, recTd: 0.05, rushTd: 0, offPct: 0.9, ...extra });
const model = {
  current: 2026, lastWeek: 5, params: NFL_MODEL_PARAMS, league: { points: 22 },
  team: { pass_att: flat(33, 5), rush_att: flat(26, 4), tackles: flat(60, 6) },
  players: {
    qb1: { pos: "QB", team: "SEA", name: "Sam Darnold", status: "ACT", last, games: 5, tgtShare: 0, carShare: 0.08, attShare: 0.95, attShareStart: 0.97, starts: 5, catch: 0.5, ypr: 5, ypc: 4, recTd: 0, rushTd: 0.02, qb: { cmp: 0.66, ypc: 11, td: 0.045, int: 0.022 } },
    qb2: { pos: "QB", team: "SEA", name: "Drew Lock", status: "ACT", last, games: 1, tgtShare: 0, carShare: 0.01, attShare: 0.03, attShareStart: null, starts: 0, catch: 0.5, ypr: 5, ypc: 3, recTd: 0, rushTd: 0.01, qb: { cmp: 0.62, ypc: 10.5, td: 0.04, int: 0.025 } },
    wr1: wr("Jaxon Smith-Njigba"),
    wrIr: wr("Hurt Reserve", { status: "RES" }),
    wrQ: wr("Questionable Guy"),
    wrOut: wr("Out Guy"),
    wrDoubt: wr("Doubtful Guy"),
    wrBack: wr("Back Guy", { last: { season: 2026, week: 2 } }),
    k1: { pos: "K", team: "SEA", name: "Jason Myers", status: "ACT", last, games: 0, k: { fgPerG: 1.8, patPerG: 2.2 } },
  },
  qbStarters: { SEA: { player_id: "qb1", season: 2026, week: 5 } },
  schedule: [{ game_id: "2026_06_SEA_DEN", season: 2026, week: 6, gameday: "2026-10-15", gametime: "20:15", away: "SEA", home: "DEN", spread_line: -2.5, total_line: 40.5 }],
  injuries: { weeks: {
    6: { wrQ: { report_status: "Questionable", injury: "Hamstring" }, wrOut: { report_status: "Out", injury: "Ankle" }, wrDoubt: { report_status: "Doubtful", injury: "Knee" } },
    5: { wr1: { report_status: "Out", injury: "Groin" } },
  } },
};
const START = "2026-10-16T00:15:00Z";
const odds = {
  games: { "SEA@DEN": { home: "DEN", away: "SEA", start_time: START, total: 40.5, home_spread: 2.5 } },
  by_player: {
    "Sam Darnold": [{ stat: "pass_yds", line: 220.5, fair_over: 0.5, books: 2, team: "SEA", game: "SEA@DEN" }],
    "Jaxon Smith-Njigba": [{ stat: "rec_yds", line: 70.5, fair_over: 0.5, books: 2, team: "SEA", game: "SEA@DEN" }],
    "Drew Lock": [],
    "Questionable Guy": [{ stat: "rec_yds", line: 70.5, fair_over: 0.5, books: 1, team: "SEA", game: "SEA@DEN" }],
    "Back Guy": [{ stat: "rec_yds", line: 70.5, fair_over: 0.5, books: 1, team: "SEA", game: "SEA@DEN" }],
  },
  anytime_td: { "Jaxon Smith-Njigba": [{ book: "draftkings", american: 105, implied: 0.4878, team: "SEA" }] },
};
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ctx = buildNflContext({ model, odds, now: NOW });
const prop = (player, stat_type, line, extra = {}) => ({ player, stat_type, line, odds_type: "standard", player_team: "SEA", opponent: "DEN", start_time: START, ...extra });
const v = (p, d = "OVER", c = ctx) => nflVerdict(p, d, c);

const atBook = v(prop("Sam Darnold", "Pass Yards", 220.5));
check("at the book line the market side = the book's fair price", near(atBook.detail.p_market, 0.5, 0.01), JSON.stringify(atBook.detail));
check("at the book line a 50/50 market can't clear break-even", atBook.tier === "SKIP" && v(prop("Sam Darnold", "Pass Yards", 220.5), "UNDER").tier === "SKIP");
const soft = v(prop("Sam Darnold", "Pass Yards", 195.5));
check("a PrizePicks line well under the book line → OVER tiered", soft.tier !== "SKIP" && soft.detail.p_market > 0.6 && soft.prob > NFL_POLICY.tierEdge.B + soft.break_even, `${soft.tier} ${soft.prob}`);
check("tiers never exceed A (uncalibrated)", soft.tier === "A" || soft.tier === "B");
check("blend sits between model and market", soft.prob >= Math.min(soft.detail.p_model, soft.detail.p_market) - 1e-3 && soft.prob <= Math.max(soft.detail.p_model, soft.detail.p_market) + 1e-3);
check("verdicts are deterministic (seeded)", v(prop("Sam Darnold", "Pass Yards", 195.5)).prob === nflVerdict(prop("Sam Darnold", "Pass Yards", 195.5), "OVER", buildNflContext({ model, odds, now: NOW })).prob);
const kick = v(prop("Jason Myers", "FG Made", 1.5));
check("model-only stat is priced + logged but never tiered", kick.tier === "SKIP" && !kick.pre_filtered && kick.prob != null && kick.rules_fired.includes("nfl-model-only"), JSON.stringify(kick.rules_fired));
const td = v(prop("Jaxon Smith-Njigba", "Rush+Rec TDs", 0.5));
check("anytime TD prices Rush+Rec TDs 0.5 (one-sided, overround removed)", near(td.detail.p_market, 0.4878 / NFL_POLICY.tdOverround, 0.01), String(td.detail.p_market));
check("gate: IR → inactive_roster", v(prop("Hurt Reserve", "Receiving Yards", 50.5)).skip_reason === "inactive_roster");
check("gate: Out → injury_out", v(prop("Out Guy", "Receiving Yards", 50.5)).skip_reason === "injury_out");
check("gate: Doubtful → injury_doubtful", v(prop("Doubtful Guy", "Receiving Yards", 50.5)).skip_reason === "injury_doubtful");
const q = v(prop("Questionable Guy", "Receiving Yards", 45.5));
check("Questionable → capped at B with a re-run flag", q.tier === "B" && q.rules_fired.includes("cap:questionable"), `${q.tier} ${q.rules_fired}`);
const back = v(prop("Back Guy", "Receiving Yards", 45.5));
check("returning from absence → capped at B", back.tier === "B" && back.rules_fired.includes("cap:returning"), `${back.tier} ${back.rules_fired}`);
check("gate: backup QB with no book price → qb_not_starter", v(prop("Drew Lock", "Pass Yards", 20.5)).skip_reason === "qb_not_starter");
check("a backup QB's non-passing stat still prices", v(prop("Drew Lock", "Rush Yards", 0.5)).skip_reason !== "qb_not_starter");
// Week-6 report not out yet → last week's Out caps.
const noReport = buildNflContext({ model: { ...model, injuries: { weeks: { 5: model.injuries.weeks[5] } } }, odds, now: NOW });
const wasOut = v(prop("Jaxon Smith-Njigba", "Receiving Yards", 50.5), "OVER", noReport);
check("Out last week, no report this week → capped at B", wasOut.tier === "B" && wasOut.rules_fired.includes("cap:was-out"), `${wasOut.tier} ${wasOut.rules_fired}`);
check("this week's report supersedes last week's Out", !v(prop("Jaxon Smith-Njigba", "Receiving Yards", 50.5)).rules_fired.includes("cap:was-out"));
check("gate: kickoff passed", nflVerdict(prop("Sam Darnold", "Pass Yards", 195.5), "OVER", { ...ctx, now: Date.parse(START) + 1 }).skip_reason === "game_started");
check("gate: goblin UNDER", v(prop("Sam Darnold", "Pass Yards", 195.5, { odds_type: "goblin" }), "UNDER").skip_reason === "over_only_line");
check("gate: unsupported stat", v(prop("Sam Darnold", "Longest Completion", 40.5)).skip_reason === "unsupported_stat");
check("gate: unknown team", v(prop("Sam Darnold", "Pass Yards", 195.5, { player_team: "XXX" })).skip_reason === "unresolved_team");
check("gate: no game between the teams", v(prop("Sam Darnold", "Pass Yards", 195.5, { opponent: "KC" })).skip_reason === "no_game");
check("gate: unknown player", v(prop("Nobody Atall", "Pass Yards", 195.5)).skip_reason === "unresolved_player");
check("gate: stat that doesn't apply to the player", v(prop("Jason Myers", "Pass Yards", 195.5)).skip_reason === "wrong_position_stat");
check("gate: kicker Fantasy Score is unsupported, not a wrong position", v(prop("Jason Myers", "Fantasy Score", 8)).skip_reason === "unsupported_stat");
check("game line comes from the books (home margin = −home spread)", atBook.detail.game_line.source === "books" && atBook.detail.game_line.home_margin === -2.5);
check("PrizePicks team spelling LAR-style resolves through the same path", v(prop("Sam Darnold", "Pass Yards", 195.5, { player_team: "Seattle Seahawks", opponent: "DEN" })).tier === soft.tier);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
