// Hermetic smoke for the FotMob parser (api/_lib/epl/fotmob.js). Builds a
// synthetic pageProps in FotMob's shape (verified against live pages
// 2026-09-18) — no network.

import {
  extractNextData, parseMatch, parseFixtures, matchPageUrl, FOTMOB_EPL_LEAGUE_ID,
} from "../api/_lib/epl/fotmob.js";

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? `  (${detail})` : ""}`); }
}

const stat = (key, value, total) => ({ key, stat: total == null ? { value, type: "integer" } : { value, total, type: "fractionWithPercentage" } });

function player({ id, optaId, name, teamId, gk = false, stats }) {
  return { id, optaId, name, teamId, isGoalkeeper: gk, usualPosition: gk ? 0 : 2, stats };
}

const pageProps = {
  general: { matchId: "900", matchRound: "3", leagueId: 47 },
  header: { teams: [{ name: "Home FC", id: 1, score: 2 }, { name: "Away FC", id: 2, score: 1 }] },
  content: {
    matchFacts: {
      infoBox: { "Match Date": { utcTime: "2026-09-01T19:00:00.000Z" }, Referee: { text: "A. Ref" }, Stadium: { name: "Ground" } },
      events: { events: [{ type: "Card", card: "Yellow", player: { id: 10 } }, { type: "Goal", player: { id: 10 } }] },
    },
    lineup: {
      homeTeam: {
        id: 1,
        starters: [{ id: 10, positionId: 83, usualPlayingPositionId: 3, verticalLayout: { x: 0.8, y: 0.85 } }],
        subs: [
          { id: 11, usualPlayingPositionId: 2, performance: { substitutionEvents: [{ time: 70, type: "subIn" }] } },
          { id: 12, usualPlayingPositionId: 1 },
        ],
        unavailable: [{ id: 13, name: "Hurt Guy", unavailability: { type: "injury", expectedReturn: "Late September 2026" } }],
      },
      awayTeam: {
        id: 2,
        starters: [{ id: 20, positionId: 11, usualPlayingPositionId: 0, verticalLayout: { x: 0.5, y: 0.1 } }],
        subs: [],
        unavailable: [],
      },
    },
    playerStats: {
      10: player({
        id: 10, optaId: 555, name: "Striker One", teamId: 1,
        stats: [
          { key: "top_stats", stats: {
            "Minutes played": stat("minutes_played", 90), Goals: stat("goals", 2), "Total shots": stat("total_shots", 5),
            "Shots on target": stat("ShotsOnTarget", 3), "Accurate passes": stat("accurate_passes", 20, 25),
            "Chances created": stat("chances_created", 2), "Expected goals (xG)": { key: "expected_goals", stat: { value: 1.35, type: "double" } },
          } },
          { key: "attack", stats: { "Accurate crosses": stat("accurate_crosses", 1, 4), "Successful dribbles": stat("dribbles_succeeded", 2, 5) } },
          // same key again in another group — first occurrence wins
          { key: "duels", stats: { Fouls: stat("fouls", 1), "Was fouled": stat("was_fouled", 3), "Total shots": stat("total_shots", 99) } },
          { key: "defense", stats: { Tackles: stat("matchstats.headers.tackles", 1), Clearances: stat("clearances", 0) } },
        ],
      }),
      11: player({ id: 11, optaId: 556, name: "Sub Mid", teamId: 1, stats: [{ key: "top_stats", stats: { "Minutes played": stat("minutes_played", 20), "Accurate passes": stat("accurate_passes", 9, 10) } }] }),
      12: player({ id: 12, optaId: 557, name: "Unused Def", teamId: 1, stats: [] }),
      20: player({
        id: 20, optaId: 558, name: "Keeper Two", teamId: 2, gk: true,
        stats: [{ key: "top_stats", stats: { "Minutes played": stat("minutes_played", 90), Saves: stat("saves", 4), "Goals conceded": stat("goals_conceded", 2), "Accurate passes": stat("accurate_passes", 15, 30) } }],
      }),
    },
    stats: {
      Periods: {
        All: {
          stats: [
            { key: "top_stats", stats: [
              { key: "BallPossesion", stats: [58, 42] },
              { key: "expected_goals", stats: ["1.88", "0.40"] },
              { key: "total_shots", stats: [12, 6] },
              { key: "accurate_passes", stats: ["29 (83%)", "15 (50%)"] },
            ] },
            { key: "passes", stats: [
              { key: "passes", stats: [null, null] }, // group header row — skipped
              { key: "passes", stats: [35, 30] },
              { key: "own_half_passes", stats: [10, 20] },
              { key: "opposition_half_passes", stats: [19, 5] },
            ] },
            { key: "defence", stats: [{ key: "keeper_saves", stats: [1, 4] }, { key: "matchstats.headers.tackles", stats: [7, 9] }] },
            { key: "discipline", stats: [{ key: "fouls", stats: [8, 12] }] },
          ],
        },
      },
    },
  },
};

console.log("[a] extractNextData / matchPageUrl");
const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`;
assert("extracts pageProps", extractNextData(html)?.general?.matchId === "900");
assert("missing script → null", extractNextData("<html></html>") === null);
assert("broken JSON → null", extractNextData('<script id="__NEXT_DATA__">{oops</script>') === null);
assert("match URL is by id, not team pairing", matchPageUrl("5795367") === "https://www.fotmob.com/match/5795367");

console.log("\n[b] parseMatch");
const parsed = parseMatch(pageProps, { pageUrl: "/matches/x/y#900" });
const { match, players, unavailable } = parsed;
assert("match id / league / round", match.match_id === "900" && match.league_id === FOTMOB_EPL_LEAGUE_ID && match.round === 3);
assert("teams + score", match.home.team_id === "1" && match.home.score === 2 && match.away.score === 1);
assert("referee + kickoff", match.referee === "A. Ref" && match.kickoff_utc === "2026-09-01T19:00:00.000Z");
const s1 = players.find((p) => p.player_id === "10");
assert("striker core stats", s1.minutes === 90 && s1.goals === 2 && s1.shots === 5 && s1.sot === 3 && s1.xg === 1.35, JSON.stringify(s1));
assert("first occurrence of a duplicated key wins", s1.shots === 5);
assert("fraction stats split into accurate / attempted", s1.passes_acc === 20 && s1.passes_att === 25 && s1.crosses_att === 4 && s1.dribbles_att === 5);
assert("shots assisted = chances created", s1.key_passes === 2);
assert("fouls, was fouled, tackles", s1.fouls === 1 && s1.fouled === 3 && s1.tackles === 1);
assert("starter + layout + position", s1.started === true && s1.position_id === 83 && s1.layout?.y === 0.85);
assert("yellow card from events", s1.yellow_cards === 1 && s1.red_cards === 0);
assert("opta id + side", s1.opta_id === "555" && s1.side === "home");
const sub = players.find((p) => p.player_id === "11");
assert("sub: not started, sub_in minute", sub.started === false && sub.sub_in === 70 && sub.minutes === 20);
const unused = players.find((p) => p.player_id === "12");
assert("unused sub: minutes 0, stats null", unused.minutes === 0 && unused.shots === null && unused.started === false);
const gk = players.find((p) => p.player_id === "20");
assert("keeper saves / conceded / gk flag", gk.gk === true && gk.saves === 4 && gk.goals_conceded === 2 && gk.side === "away");

console.log("\n[c] team stats");
const hs = match.team_stats.home, as = match.team_stats.away;
assert("possession + xG numbers", hs.possession === 58 && hs.xg === 1.88 && as.xg === 0.4);
assert("'29 (83%)' → accurate count 29", hs.passes_acc === 29);
assert("group header row skipped (passes = 35, not null)", hs.passes_att === 35 && as.passes_att === 30);
assert("own / opposition half passes", hs.own_half_passes === 10 && hs.opp_half_passes === 19);
assert("crosses / dribbles attempted summed from players", hs.crosses_att === 4 && hs.dribbles_att === 5);
assert("keeper saves + tackles + fouls", as.keeper_saves === 4 && hs.tackles === 7 && as.fouls === 12);
assert("missing team stat → null", hs.corners === null);

console.log("\n[d] unavailable + fixtures");
assert("unavailable list", unavailable.length === 1 && unavailable[0].type === "injury" && unavailable[0].team_id === "1");
const fx = parseFixtures({ fixtures: { allMatches: [
  { id: 900, round: "3", pageUrl: "/m", home: { id: 1, name: "Home FC", shortName: "Home" }, away: { id: 2, name: "Away FC", shortName: "Away" }, status: { utcTime: "2026-09-01T19:00:00Z", finished: true, started: true, cancelled: false, scoreStr: "2 - 1" } },
  { id: 901, round: "4", pageUrl: "/n", home: { id: 2, name: "Away FC" }, away: { id: 1, name: "Home FC" }, status: { utcTime: "2026-09-08T19:00:00Z", finished: false, started: false } },
] } });
assert("fixtures parsed with status", fx.length === 2 && fx[0].finished && !fx[1].finished && fx[0].match_id === "900" && fx[1].round === 4);
assert("no playerStats → null", parseMatch({ content: {}, header: pageProps.header }) === null);

console.log(`\nsmoke-epl-data: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
