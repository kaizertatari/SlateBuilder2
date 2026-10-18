// Fit DEF_BLEND_K (api/_lib/team-defense.js) — how fast a team's NBA
// defensive rating should move from last season to this season.
//
// For each season pair (last → this) and each games-played n, it predicts a
// team's rest-of-season DRtg (games n+1..end) from
//     w · DRtg(first n games) + (1 − w) · DRtg(last season),  w = n/(n+k)
// (each season centred on its league mean), and reports the RMSE per k.
// The recommended k minimises mean RMSE over n = 1..MAX_N. The current
// in-progress season joins as a target once it has ≥ MAX_N + 10 games.
// Suggest-only: edit DEF_BLEND_K by hand after review. Run from home
// (stats.nba.com refuses most cloud IPs).
//
// Usage: node scripts/fit-defense-blend.mjs [--seasons 2023-24,2024-25,2025-26]

import { NBA_HEADERS } from "../api/_lib/nba-http.js";
import { currentSeason } from "../api/_lib/nba-stats.js";
import { DEF_BLEND_K } from "../api/_lib/team-defense.js";

const MAX_N = 30;
const KS = [0, 2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, Infinity];
const SHOW_N = [1, 3, 5, 8, 10, 12, 15, 20, 30];

const label = (y) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;

function parseSeasons(argv) {
  const i = argv.indexOf("--seasons");
  if (i >= 0) return argv[i + 1].split(",");
  const cur = parseInt(currentSeason(new Date(), "NBA"), 10);
  return [label(cur - 3), label(cur - 2), label(cur - 1), label(cur)];
}

// Team-game rows → { team: [{ date, ptsAllowed, poss }] } (possessions
// averaged over both sides of the game).
async function seasonGames(season) {
  const p = new URLSearchParams({ Counter: 0, Direction: "ASC", LeagueID: "00", PlayerOrTeam: "T", Season: season, SeasonType: "Regular Season", Sorter: "DATE" });
  const res = await fetch(`https://stats.nba.com/stats/leaguegamelog?${p}`, { headers: NBA_HEADERS, signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error(`leaguegamelog ${season} HTTP ${res.status}`);
  const rs = (await res.json()).resultSets?.[0];
  if (!rs?.rowSet?.length) return {};
  const ix = (k) => rs.headers.indexOf(k);
  const byGame = new Map();
  for (const row of rs.rowSet) {
    const id = row[ix("GAME_ID")];
    if (!byGame.has(id)) byGame.set(id, []);
    byGame.get(id).push({
      team: row[ix("TEAM_ABBREVIATION")], date: row[ix("GAME_DATE")], pts: row[ix("PTS")],
      poss: row[ix("FGA")] + 0.44 * row[ix("FTA")] - row[ix("OREB")] + row[ix("TOV")],
    });
  }
  const teams = {};
  for (const g of byGame.values()) {
    if (g.length !== 2) continue;
    for (const [a, b] of [[g[0], g[1]], [g[1], g[0]]]) {
      (teams[a.team] ??= []).push({ date: a.date, ptsAllowed: b.pts, poss: (a.poss + b.poss) / 2 });
    }
  }
  for (const t in teams) teams[t].sort((x, y) => x.date.localeCompare(y.date));
  return teams;
}

const drtg = (gs) => (100 * gs.reduce((s, g) => s + g.ptsAllowed, 0)) / gs.reduce((s, g) => s + g.poss, 0);
const centre = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return v.map((x) => x - m); };
const rmse = (x, y) => Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / x.length);

async function main() {
  const seasons = parseSeasons(process.argv.slice(2));
  const data = {};
  for (const s of seasons) {
    data[s] = await seasonGames(s);
    const n = Math.min(...Object.values(data[s]).map((g) => g.length));
    console.log(`${s}: ${Object.keys(data[s]).length} teams, ≥${Number.isFinite(n) ? n : 0} games each`);
  }
  const pairs = [];
  for (let i = 1; i < seasons.length; i++) {
    const P = data[seasons[i - 1]], C = data[seasons[i]];
    const teams = Object.keys(C).filter((t) => P[t]);
    const minGames = Math.min(...teams.map((t) => C[t].length));
    if (teams.length < 10 || minGames < MAX_N + 10) {
      console.log(`  (skip ${seasons[i]} as a target — needs ≥ ${MAX_N + 10} games per team)`);
      continue;
    }
    pairs.push({ name: `${seasons[i - 1]}→${seasons[i]}`, teams, P, C });
  }
  if (!pairs.length) throw new Error("no usable season pairs");

  // err[n][k] = mean RMSE over pairs
  const err = {};
  for (let n = 1; n <= MAX_N; n++) {
    err[n] = KS.map((k) => {
      const w = Number.isFinite(k) ? n / (n + k) : 0;
      let tot = 0;
      for (const { teams, P, C } of pairs) {
        const prior = centre(teams.map((t) => drtg(P[t])));
        const early = centre(teams.map((t) => drtg(C[t].slice(0, n))));
        const rest = centre(teams.map((t) => drtg(C[t].slice(n))));
        tot += rmse(early.map((x, i) => w * x + (1 - w) * prior[i]), rest);
      }
      return tot / pairs.length;
    });
  }

  const kName = (k) => (Number.isFinite(k) ? `k=${k}` : "last only");
  console.log(`\nRest-of-season DRtg RMSE (pts/100), mean over ${pairs.map((p) => p.name).join(", ")}`);
  console.log("k=0 = this season only; 'last only' = last season only\n");
  console.log("n".padEnd(5) + KS.map((k) => kName(k).padStart(10)).join(""));
  for (const n of SHOW_N) console.log(String(n).padEnd(5) + err[n].map((e) => e.toFixed(2).padStart(10)).join(""));

  const overall = KS.map((_, j) => Object.values(err).reduce((s, row) => s + row[j], 0) / MAX_N);
  console.log("mean".padEnd(5) + overall.map((e) => e.toFixed(2).padStart(10)).join(""));
  const best = overall.indexOf(Math.min(...overall.filter((_, j) => Number.isFinite(KS[j]) && KS[j] > 0)));
  const curIdx = KS.indexOf(DEF_BLEND_K);
  console.log(`\nRecommended DEF_BLEND_K = ${KS[best]} (mean RMSE ${overall[best].toFixed(3)})`);
  if (curIdx >= 0) console.log(`Current   DEF_BLEND_K = ${DEF_BLEND_K} (mean RMSE ${overall[curIdx].toFixed(3)})`);
  console.log("Suggest-only — edit DEF_BLEND_K in api/_lib/team-defense.js if the gain is material (> ~0.03).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
