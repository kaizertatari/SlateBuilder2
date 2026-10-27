// Smoke: NBA team tracker — box score parser, accuracy validator, tracker math.
import { parseGame, validateGame, compareTotals, parseEspnTeamTotals, minutesOf } from "../api/_lib/basketball/boxscores.js";
import { buildTracker, ratesOf } from "../api/_lib/basketball/team-tracker.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };

// --- synthetic two-team game -------------------------------------------------
// Each team: 5 starters + 2 bench. Player line: [min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf]
function team(tri, id0, lines) {
  const players = lines.map(([min, fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, ast, stl, blk, tov, pf], i) => ({
    personId: id0 + i, firstName: tri, familyName: `P${i}`, position: i < 5 ? "G" : "",
    statistics: { minutes: `${min}:00`, fieldGoalsMade: fgm, fieldGoalsAttempted: fga, threePointersMade: fg3m, threePointersAttempted: fg3a,
      freeThrowsMade: ftm, freeThrowsAttempted: fta, reboundsOffensive: oreb, reboundsDefensive: dreb, reboundsTotal: oreb + dreb,
      assists: ast, steals: stl, blocks: blk, turnovers: tov, foulsPersonal: pf, points: 2 * fgm + fg3m + ftm, plusMinusPoints: 0 },
  }));
  const agg = (ps) => {
    const s = {}; for (const p of ps) for (const [k, v] of Object.entries(p.statistics)) if (k !== "minutes") s[k] = (s[k] ?? 0) + v;
    s.minutes = `${ps.reduce((a, p) => a + minutesOf(p.statistics.minutes), 0)}:00`; return s;
  };
  return { teamTricode: tri, players, statistics: agg(players), starters: agg(players.slice(0, 5)), bench: agg(players.slice(5)) };
}
const L = (min, fgm, fga, fg3m, fg3a) => [min, fgm, fga, fg3m, fg3a, 2, 2, 1, 4, 3, 1, 0, 2, 2];
const home = team("AAA", 100, [L(36, 8, 16, 2, 6), L(34, 6, 12, 2, 5), L(34, 5, 10, 1, 3), L(32, 4, 9, 1, 4), L(32, 4, 8, 0, 1), L(36, 3, 7, 1, 3), L(36, 2, 5, 0, 2)]);
const away = team("BBB", 200, [L(36, 7, 15, 1, 5), L(34, 6, 13, 2, 6), L(34, 5, 11, 1, 4), L(32, 4, 10, 0, 2), L(32, 3, 8, 1, 3), L(36, 3, 6, 0, 1), L(36, 1, 4, 0, 1)]);
const margin = home.statistics.points - away.statistics.points;
home.statistics.plusMinusPoints = margin; away.statistics.plusMinusPoints = -margin;
const misc = (pp, opp) => ({ statistics: { pointsPaint: pp, oppPointsPaint: opp, pointsFastBreak: 10, oppPointsFastBreak: 8, pointsSecondChance: 9, oppPointsSecondChance: 7, pointsOffTurnovers: 12, oppPointsOffTurnovers: 11 }, players: [] });
const adv = (poss) => ({ statistics: { possessions: poss, pace: poss, offensiveRating: 0, defensiveRating: 0 }, players: [] });
const payloads = {
  trad: { boxScoreTraditional: { gameId: "0099", homeTeam: home, awayTeam: away } },
  misc: { boxScoreMisc: { homeTeam: misc(40, 36), awayTeam: misc(36, 40) } },
  adv: { boxScoreAdvanced: { homeTeam: adv(100), awayTeam: adv(99) } },
  hustle: null, def: null,
};
const g = parseGame(payloads, "2026-10-20");
ok(g && g.home === "AAA" && g.away === "BBB", "parseGame reads both teams");
ok(g.players.filter((p) => p.team === "AAA" && p.starter).length === 5, "5 starters flagged from position");
ok(minutesOf("PT33M15.00S") === 33.25 && minutesOf("33:15") === 33.25, "minutesOf parses both clock formats");
ok(validateGame(g).length === 0, `clean game validates (${validateGame(g).join("; ")})`);

// Corrupt one starter's points → starters+bench, players, and starters-block checks fire.
const bad = structuredClone(g);
bad.players.find((p) => p.team === "AAA" && p.starter).pts += 2;
ok(validateGame(bad).some((x) => x.includes("players")), "player-sum mismatch detected");
const bad2 = structuredClone(g); bad2.players.find((p) => p.team === "BBB" && !p.starter).starter = true;
ok(validateGame(bad2).some((x) => x.includes("6 starters")), "wrong starter count detected");
const bad3 = structuredClone(g); bad3.teams.AAA.misc.pts_paint = 1;
ok(validateGame(bad3).some((x) => x.includes("paint")), "paint vs opponent-allowed mismatch detected");

// compareTotals / ESPN parser
const espn = parseEspnTeamTotals({ boxscore: { teams: [{ team: { abbreviation: "AA" }, statistics: [
  { name: "fieldGoalsMade-fieldGoalsAttempted", displayValue: `${g.teams.AAA.totals.fgm}-${g.teams.AAA.totals.fga}` },
  { name: "totalRebounds", displayValue: String(g.teams.AAA.totals.reb + 1) }] }] } }, (a) => (a === "AA" ? "AAA" : a));
const diff = compareTotals(g, espn, "ESPN");
ok(diff.some((x) => x.includes("AAA: reb")) && !diff.some((x) => x.includes("AAA: fga")), "compareTotals flags only differing fields");
ok(diff.some((x) => x.includes("BBB: no ESPN row")), "missing source row reported");

// --- tracker math ------------------------------------------------------------
const store = { season: "2099-00", games: { [g.game_id]: g } };
const g2 = structuredClone(g); g2.game_id = "0100"; g2.date = "2026-10-22";
store.games[g2.game_id] = g2;
const tr = buildTracker(store, { minPlayerMpg: 0, minPlayerGames: 1 });
const A = tr.teams.AAA, T = g.teams.AAA.totals, O = g.teams.BBB.totals;
ok(A.record.w + A.record.l === 2, "two games counted");
ok(Math.abs(A.offense.ortg - (100 * T.pts) / 100) < 1e-9, "ORtg = 100·pts / own poss");
ok(Math.abs(A.defense.drtg - (100 * O.pts) / 99) < 1e-9, "DRtg = 100·opp pts / OPPONENT poss");
ok(Math.abs(A.offense.efg - (T.fgm + 0.5 * T.fg3m) / T.fga) < 1e-9, "eFG formula");
ok(Math.abs(A.offense.oreb_pct - T.oreb / (T.oreb + O.dreb)) < 1e-9, "OREB% formula");
ok(Math.abs(A.starters.ppg - g.teams.AAA.starters.pts) < 1e-9, "starters ppg from starter rows");
ok(Math.abs(A.opp_starters.ppg - g.teams.BBB.starters.pts) < 1e-9, "opponent starters ppg");
ok(ratesOf([]).ortg === null, "empty rates are null, not NaN");
ok(tr.players.offense_top.length > 0 && tr.players.offense_top[0].off_score != null, "offense leaderboard scored");
g.teams.AAA.totals.tov_total = T.tov + 3;
const tr2 = buildTracker({ season: "x", games: { a: g } }, { minPlayerMpg: 0, minPlayerGames: 1 });
ok(Math.abs(tr2.teams.AAA.offense.tov_pct - (T.tov + 3) / 100) < 1e-9, "team turnovers (tov_total) used for TOV%");

console.log(`smoke-team-tracker: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
