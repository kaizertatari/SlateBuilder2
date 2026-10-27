// NBA team tracker, step 2 — build the season-only tracker from the stored
// per-game box scores (scripts/refresh-nba-boxscores.mjs) and check it
// against stats.nba.com's own season team totals.
//
//   data/nba-team-tracker.json          team offense / defense, starters vs
//                                       bench, playstyle tags, opponent-
//                                       adjusted vs-playstyle splits, players
//   logs/nba-team-tracker-latest.txt    human-readable report (latest only)
//
// Accuracy check (exit 1 on failure, artifact still written with
// `validation`): leaguedashteamstats Totals — GP, W, L and every counting
// stat must equal our sums (a ±1–2 confirmed stat correction is a note, not a
// failure); Advanced OFF_RATING / DEF_RATING / PACE within 1.0; every
// player's GP/PTS/REB/AST/STL/BLK/3PM/FGA vs leaguedashplayerstats.
//
// Usage: node scripts/build-nba-team-tracker.mjs [--no-check]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NBA_HEADERS } from "../api/_lib/nba-http.js";
import { currentSeason } from "../api/_lib/nba-stats.js";
import { ABBR_BY_TEAM_ID } from "../api/_lib/team-ids.js";
import { buildTracker, OFF_TAGS, DEF_TAGS } from "../api/_lib/basketball/team-tracker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEASON = currentSeason(new Date(), "NBA");
const BOX = path.join(ROOT, "data", "basketball", "box", `nba-${SEASON}.json`);
const OUT = path.join(ROOT, "data", "nba-team-tracker.json");
const REPORT = path.join(ROOT, "logs", "nba-team-tracker-latest.txt");
const CHECK = !process.argv.includes("--no-check");

const DASH = {
  LastNGames: 0, LeagueID: "00", Month: 0, OpponentTeamID: 0, PaceAdjust: "N", Period: 0, PlusMinus: "N", Rank: "N",
  SeasonType: "Regular Season", DateFrom: "", DateTo: "", GameSegment: "", Location: "", Outcome: "", ShotClockRange: "",
  VsConference: "", VsDivision: "", Season: SEASON,
};
async function dash(measure, perMode, endpoint = "leaguedashteamstats") {
  const url = `https://stats.nba.com/stats/${endpoint}?${new URLSearchParams({ ...DASH, MeasureType: measure, PerMode: perMode })}`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { headers: NBA_HEADERS, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rs = (await res.json()).resultSets[0];
      return Object.fromEntries(rs.rowSet.map((row) => { const o = Object.fromEntries(rs.headers.map((h, j) => [h, row[j]])); return [endpoint === "leaguedashplayerstats" ? o.PLAYER_ID : (ABBR_BY_TEAM_ID[o.TEAM_ID] ?? o.TEAM_ABBREVIATION), o]; }));
    } catch (e) { if (i === 3) throw e; await new Promise((r) => setTimeout(r, 2000 * i)); }
  }
}

async function officialCheck(store, tracker) {
  const problems = [], notes = [];
  const [base, adv] = [await dash("Base", "Totals"), await dash("Advanced", "PerGame")];
  const F = { pts: "PTS", fgm: "FGM", fga: "FGA", fg3m: "FG3M", fg3a: "FG3A", ftm: "FTM", fta: "FTA", oreb: "OREB", dreb: "DREB", reb: "REB", ast: "AST", tov: "TOV", stl: "STL", blk: "BLK" };
  for (const [tri, t] of Object.entries(tracker.teams)) {
    const b = base[tri], a = adv[tri];
    if (!b || !a) { problems.push(`${tri}: missing from leaguedashteamstats`); continue; }
    const gp = t.record.w + t.record.l;
    if (b.GP !== gp || b.W !== t.record.w || b.L !== t.record.l) problems.push(`${tri}: record ${t.record.w}-${t.record.l} (${gp} GP) ≠ official ${b.W}-${b.L} (${b.GP})`);
    const ours = {};
    for (const g of Object.values(store.games)) if (g.teams[tri]) for (const k of Object.keys(F)) ours[k] = (ours[k] ?? 0) + (k === "tov" ? (g.teams[tri].totals.tov_total ?? g.teams[tri].totals.tov) : g.teams[tri].totals[k]);
    for (const [k, h] of Object.entries(F)) if (ours[k] !== b[h]) (Math.abs(ours[k] - b[h]) <= 2 ? notes : problems).push(`${tri}: ${k} ${ours[k]} vs official ${b[h]}`);
    for (const [k, h] of [["ortg", "OFF_RATING"], ["drtg", "DEF_RATING"], ["pace", "PACE"]]) {
      const v = t.offense[k];
      if (Math.abs(v - a[h]) > 1.0) problems.push(`${tri}: ${k} ${v.toFixed(1)} vs official ${a[h]}`);
    }
  }
  // Every player's season totals vs the official player dashboard (exact;
  // a ±1–2 difference on one stat is a stat correction → note).
  const official = await dash("Base", "Totals", "leaguedashplayerstats");
  const PF = { games: "GP", pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", fg3m: "FG3M", fga: "FGA" };
  const mine = new Map();
  for (const g of Object.values(store.games)) for (const p of g.players) {
    const a = mine.get(p.id) ?? { name: p.name, games: 0 };
    a.games++;
    for (const k of Object.keys(PF)) if (k !== "games") a[k] = (a[k] ?? 0) + (p[k] ?? 0);
    mine.set(p.id, a);
  }
  let playersOk = 0;
  for (const [id, a] of mine) {
    const o = official[id];
    if (!o) { problems.push(`player ${a.name} (${id}): not in official player dashboard`); continue; }
    const diffs = Object.entries(PF).filter(([k, h]) => a[k] !== o[h]).map(([k, h]) => `${k} ${a[k]} vs ${o[h]}`);
    if (!diffs.length) { playersOk++; continue; }
    // Judge each stat alone: one corrected game moves several stats by 1
    // (2026-10-25 MEM/SAC — box matched ESPN player-by-player).
    const big = Object.entries(PF).some(([k, h]) => Math.abs(a[k] - o[h]) > 2);
    (big ? problems : notes).push(`player ${a.name}: ${diffs.join(", ")}`);
  }
  const extra = Object.values(official).filter((o) => o.MIN > 0 && !mine.has(o.PLAYER_ID));
  for (const o of extra) problems.push(`player ${o.PLAYER_NAME}: official has ${o.GP} games, tracker has none`);
  notes.push(`players: ${playersOk}/${mine.size} exact match with the official dashboard`);
  return { checked_at: new Date().toISOString(), ok: problems.length === 0, problems, notes };
}

// ---- report ---------------------------------------------------------------
const pct = (x, d = 1) => (x == null ? "  -  " : `${(x * 100).toFixed(d)}%`);
const f1 = (x) => (x == null ? "-" : x.toFixed(1));
const sgn = (x) => (x == null ? "-" : `${x > 0 ? "+" : ""}${x.toFixed(1)}`);

function report(tr) {
  const L = [];
  const lg = tr.league;
  L.push(`NBA team tracker — ${tr.season}, ${tr.games} games through ${tr.through}`);
  L.push(`League: ORtg ${f1(lg.ortg)}  pace ${f1(lg.pace)}  eFG ${pct(lg.efg)}  TS ${pct(lg.ts)}  3PA rate ${pct(lg.rate3)}  TOV% ${pct(lg.tov_pct)}  OREB% ${pct(lg.oreb_pct)}  FT rate ${pct(lg.ft_rate)}  paint ${pct(lg.paint)} of pts  fast-break ${pct(lg.fb)}`);
  if (tr.validation) L.push(`Official check: ${tr.validation.ok ? "PASS" : "FAIL"} (${tr.validation.problems.length} problems, ${tr.validation.notes.length} notes)`);
  const rank = (k, dir) => Object.entries(tr.teams).sort((a, b) => dir * ((a[1].offense[k] ?? 0) - (b[1].offense[k] ?? 0))).map(([t]) => t);
  const ortgRank = rank("ortg", -1), drtgRank = rank("drtg", 1);
  const rows = Object.entries(tr.teams).sort((a, b) => b[1].offense.net - a[1].offense.net);
  L.push("", "TEAMS by net rating");
  L.push("team  W-L   ORtg(rk)  DRtg(rk)   Net  Pace  | eFG   TOV%  OREB%  FTr   3PAr  paint  FB   | oppEFG forcedTOV DREB% opp3PAr oppPaint | starters ppg TS on-ORtg/DRtg | opp-starters ppg TS");
  for (const [t, x] of rows) {
    const o = x.offense, s = x.starters, os = x.opp_starters;
    L.push(`${t.padEnd(4)} ${x.record.w}-${x.record.l}  ${f1(o.ortg).padStart(5)}(${String(ortgRank.indexOf(t) + 1).padStart(2)})  ${f1(o.drtg).padStart(5)}(${String(drtgRank.indexOf(t) + 1).padStart(2)})  ${sgn(o.net).padStart(5)} ${f1(o.pace)} | ${pct(o.efg)} ${pct(o.tov_pct)} ${pct(o.oreb_pct)} ${pct(o.ft_rate)} ${pct(o.rate3)} ${pct(o.paint)} ${pct(o.fb)} | ${pct(o.opp_efg)} ${pct(o.forced_tov)} ${pct(o.dreb_pct)} ${pct(o.opp_rate3)} ${pct(o.opp_paint)} | ${f1(s.ppg)} ${pct(s.ts)} ${f1(s.on_ortg)}/${f1(s.on_drtg)} | ${f1(os.ppg)} ${pct(os.ts)}`);
  }
  L.push("", "PLAYSTYLES (league terciles) and opponent-adjusted results vs styles (adj = rating pts vs expectation; offense + is good, defense − is good)");
  for (const [t, x] of rows) {
    L.push(`${t}: OFF [${x.offense_tags.join(", ") || "balanced"}]  DEF [${x.defense_tags.join(", ") || "balanced"}]`);
    const vs = x.vs_style;
    const o = Object.entries(vs.offense_vs_defense_style).map(([k, v]) => `${k} ${sgn(v.adj)} (${v.games}g: ${v.opps.join("/")})`);
    const d = Object.entries(vs.defense_vs_offense_style).map(([k, v]) => `${k} ${sgn(v.adj)} (${v.games}g: ${v.opps.join("/")})`);
    if (o.length) L.push(`    offense vs: ${o.join("; ")}`);
    if (d.length) L.push(`    defense vs: ${d.join("; ")}`);
  }
  const P = tr.players;
  L.push("", `TOP OFFENSIVE PLAYERS (≥${P.qualify.min_games} games, ≥${P.qualify.min_mpg} mpg; score = z PPG + z pts-above-avg-efficiency + 0.75 z APG + 0.5 z on-court ORtg + 0.25 z low TOV)`);
  for (const [i, p] of P.offense_top.slice(0, 15).entries()) L.push(`${String(i + 1).padStart(2)}. ${p.name.padEnd(24)} ${p.team} ${p.games}g ${f1(p.mpg)}m  ${f1(p.ppg)}p ${f1(p.apg)}a ${f1(p.rpg)}r  TS ${pct(p.ts)} USG ${pct(p.usg)} effAdd ${sgn(p.eff_added)} onORtg ${f1(p.on_ortg)} TOV ${f1(p.tov_pg)}  score ${p.off_score}`);
  L.push("", `TOP DEFENSIVE PLAYERS (≥60 matchup poss; score = z stocks/36 + 0.75 z deflections/36 + 0.5 z contests/36 + z makes saved/g + 0.75 z low on-court DRtg + 0.25 z DREB/36). League matchup FG% ${pct(P.league_matchup_fg)}`);
  for (const [i, p] of P.defense_top.slice(0, 15).entries()) L.push(`${String(i + 1).padStart(2)}. ${p.name.padEnd(24)} ${p.team} ${p.games}g ${f1(p.mpg)}m  stl ${f1(p.spg)} blk ${f1(p.bpg)} stocks36 ${f1(p.stocks_36)} defl36 ${f1(p.deflections_36)} cont36 ${f1(p.contests_36)}  matchup FG ${pct(p.m_fg_pct)} on ${p.m_fga} FGA (saved ${sgn(p.makes_saved_pg)}/g)  onDRtg ${f1(p.on_drtg)}  score ${p.def_score}`);
  return L.join("\n") + "\n";
}

async function main() {
  const store = JSON.parse(await fs.readFile(BOX, "utf8"));
  if (store.season !== SEASON) throw new Error(`box store is ${store.season}, expected ${SEASON}`);
  const tracker = { built_at: new Date().toISOString(), ...buildTracker(store), tags: { offense: OFF_TAGS, defense: DEF_TAGS } };
  if (CHECK) {
    try { tracker.validation = await officialCheck(store, tracker); }
    catch (e) { tracker.validation = { ok: false, problems: [`official check unavailable: ${e.message}`], notes: [] }; }
  }
  await fs.writeFile(OUT, JSON.stringify(tracker) + "\n");
  await fs.mkdir(path.dirname(REPORT), { recursive: true });
  const text = report(tracker);
  await fs.writeFile(REPORT, text);
  console.log(`build-nba-team-tracker: ${tracker.games} games through ${tracker.through}, ${Object.keys(tracker.teams).length} teams → ${path.relative(ROOT, OUT)}; report → ${path.relative(ROOT, REPORT)}`);
  if (tracker.validation) {
    console.log(`  official check: ${tracker.validation.ok ? "PASS" : "FAIL"}`);
    for (const p of tracker.validation.problems) console.log(`  ✗ ${p}`);
    for (const n of tracker.validation.notes) console.log(`  ! ${n}`);
  }
  process.exit(tracker.validation && !tracker.validation.ok ? 1 : 0);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
