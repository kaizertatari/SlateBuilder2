// Compare every PrizePicks EPL line against the model, the sportsbooks and
// the PrizePicks break-even.
//
// Inputs (run the refreshes first):
//   data/epl-pp-lines.json   PrizePicks EPL board   (refresh-epl-prizepicks)
//   data/epl-odds.json       DK + FD markets        (scrape-epl-odds)
//   data/epl-model.json      fitted model           (build-epl-model)
//   data/epl-players.json, data/epl-matches.json   registry + fixtures
//
// For each line:
//   model   P(over | plays) from the player model, with the MARKET's team goal
//           expectations as the game script (teamContext) — the blend's
//           match-level half.
//   market  P(over) from the books' player ladders. Ladders are one-sided and
//           shaded, so the raw ladder rate λ̂ is rescaled per stat by the
//           median market/model ratio ("level-matched"): the books contribute
//           WHO is high or low, the calibrated model sets the level. The
//           per-stat ratios are printed — they are the shading estimate.
//   b/e     per-leg break-even, 2-pick power (3×) reference with the app's
//           goblin/demon factors (approximate for those; over-only).
//
// This is analysis, not a verdict: tiers/gates/blend weights are step 4.
//
// Usage: npm run epl-board-report  [-- --top 25]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectPlayer, priceLine, simulateFantasy, teamTotal } from "../api/_lib/epl/model.js";
import { lineProbs } from "../api/_lib/epl/distributions.js";
import { buildTeamResolver, buildPlayerResolver } from "../api/_lib/epl/names.js";
import { POWER_MULTIPLIER, LINE_TYPE_FACTOR } from "../api/_lib/prizepicks-payouts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const topIdx = process.argv.indexOf("--top");
const TOP = topIdx >= 0 ? Number(process.argv[topIdx + 1]) : 20;

// PrizePicks stat_type → model prop.
export const PP_TO_STAT = {
  "Shots": "shots", "Shots On Target": "sot", "Shots Assisted": "key_passes",
  "Passes Attempted": "passes_att", "Crosses": "crosses_att", "Attempted Dribbles": "dribbles_att",
  "Tackles": "tackles", "Clearances": "clearances", "Fouls": "fouls",
  "Goals": "goals", "Assists": "assists", "Goal + Assist": "goal_assist",
  "Goalie Saves": "saves", "Goals Allowed": "goals_conceded",
  "Outfield Fantasy Score": "fantasy",
};

const breakEven = (type) => 1 / (Math.sqrt(POWER_MULTIPLIER[2]) * (LINE_TYPE_FACTOR[type] ?? 1));

function spearman(xs, ys) {
  const rank = (a) => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(a.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  if (n < 3) return null;
  const d2 = rx.reduce((a, r, i) => a + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const pct = (p) => (p == null ? "  —  " : `${(p * 100).toFixed(1).padStart(5)}%`);

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf8"));
}

async function main() {
  const [pp, odds, model, registry, snap] = await Promise.all([
    readJson("data/epl-pp-lines.json"), readJson("data/epl-odds.json"), readJson("data/epl-model.json"),
    readJson("data/epl-players.json"), readJson("data/epl-matches.json"),
  ]);
  const team = buildTeamResolver(registry);
  const resolvePlayer = buildPlayerResolver(model, registry);
  const tidByAbbr = Object.fromEntries(Object.entries(model.teams).map(([tid, t]) => [t.abbr, tid]));
  const abbrOf = (tid) => model.teams[tid]?.abbr;
  const upcoming = snap.fixtures.filter((f) => !f.finished && !f.cancelled);
  // The fixture nearest the PrizePicks start time — both meetings of a pair
  // are "upcoming" early in the season, and picking the wrong one flips the
  // venue and loses the market game script.
  const fixtureFor = (a, b, startTime) => {
    const t = Date.parse(startTime);
    const cands = upcoming.filter((f) => {
      const h = abbrOf(f.home.team_id), w = abbrOf(f.away.team_id);
      return (h === a && w === b) || (h === b && w === a);
    });
    if (!cands.length) return null;
    const f = cands.sort((x, y) => Math.abs(Date.parse(x.kickoff_utc) - t) - Math.abs(Date.parse(y.kickoff_utc) - t))[0];
    const h = abbrOf(f.home.team_id);
    return h === a ? { home: a, away: b, venueOfA: "home" } : { home: b, away: a, venueOfA: "away" };
  };

  const counts = { props: 0, unsupported: 0, noTeam: 0, noFixture: 0, noPlayer: 0, priorOnly: 0, priced: 0, withMarket: 0 };
  const rows = [];
  const projCache = new Map();
  for (const props of Object.values(pp.by_player)) {
    for (const p of props) {
      counts.props++;
      const stat = PP_TO_STAT[p.stat_type];
      if (!stat) { counts.unsupported++; continue; }
      const mine = team(p.player_team), opp = team(p.opponent);
      if (!mine || !opp) { counts.noTeam++; continue; }
      const fx = fixtureFor(mine, opp, p.start_time);
      if (!fx) { counts.noFixture++; continue; }
      const who = resolvePlayer(p.player, mine);
      if (!who) { counts.noPlayer++; continue; }
      const mp = model.players[who.id];
      if (mp.prior_only) { counts.priorOnly++; continue; }

      const mkt = odds.matches[`${fx.home}-${fx.away}`];
      const lam = mkt?.lambda;
      const venue = fx.venueOfA;
      const teamContext = lam ? { xg_for: venue === "home" ? lam.home : lam.away, xg_against: venue === "home" ? lam.away : lam.home } : null;
      const key = `${who.id}|${opp}`;
      if (!projCache.has(key)) {
        projCache.set(key, {
          play: projectPlayer(model, { playerId: who.id, opponentTeamId: tidByAbbr[opp], venue, teamContext }),
          start: projectPlayer(model, { playerId: who.id, opponentTeamId: tidByAbbr[opp], venue, teamContext, minutes: { started: true } }),
        });
      }
      const { play, start } = projCache.get(key);
      let model_over, model_under, mean;
      if (stat === "fantasy") {
        const sim = simulateFantasy(play);
        if (!sim) { counts.unsupported++; continue; }
        const lp = sim.probOver(p.line);
        model_over = lp.over; model_under = lp.under; mean = sim.mean;
      } else {
        const pl = priceLine(play, stat, p.line);
        if (!pl || pl.p_over == null) { counts.unsupported++; continue; }
        model_over = pl.p_over; model_under = pl.p_under; mean = pl.mean;
      }
      counts.priced++;
      const lamHat = odds.players?.[who.id]?.props?.[stat]?.lambda_hat ?? null;
      const startMean = stat === "fantasy" ? null : priceLine(start, stat, 0.5)?.mean ?? null;
      if (lamHat) counts.withMarket++;
      rows.push({
        player: model.players[who.id].name, team: mine, opp, venue, stat, pp_stat: p.stat_type,
        line: p.line, type: p.odds_type ?? "standard", model_over, model_under, mean,
        lam_hat: lamHat, start_mean: startMean, p_play: play.scenarios.filter((s) => s.m > 0).reduce((a, s) => a + s.p, 0),
      });
    }
  }

  // Market level vs model level per stat (starter means), and rank agreement.
  const shading = {};
  console.log(`EPL board report — PrizePicks board ${pp.fetched_at}, odds ${odds.fetched_at}, model through ${model.trained_through}\n`);
  console.log(`Coverage: ${counts.props} lines | priced ${counts.priced} | with a sportsbook ladder ${counts.withMarket} | unsupported stat ${counts.unsupported} (Goalie Fantasy Score) | player not found ${counts.noPlayer} | prior-only ${counts.priorOnly} | team/fixture unresolved ${counts.noTeam + counts.noFixture}`);
  console.log(`\nMarket ladder rate vs model (starter mean), per stat — ratio = shading estimate; ρ = rank agreement:`);
  for (const stat of [...new Set(rows.map((r) => r.stat))]) {
    const seen = new Map();
    for (const r of rows) if (r.stat === stat && r.lam_hat && r.start_mean > 0) seen.set(`${r.player}|${r.opp}`, r);
    const pairs = [...seen.values()];
    if (pairs.length < 5) continue;
    const ratio = median(pairs.map((r) => r.lam_hat / r.start_mean));
    shading[stat] = ratio;
    const rho = spearman(pairs.map((r) => r.lam_hat), pairs.map((r) => r.start_mean));
    console.log(`  ${stat.padEnd(12)} n=${String(pairs.length).padStart(3)}  market/model ×${ratio.toFixed(2)}   ρ=${rho?.toFixed(2)}`);
  }
  for (const r of rows) {
    if (r.lam_hat && shading[r.stat]) {
      r.market_over = lineProbs(r.line, (r.lam_hat / shading[r.stat]) * (r.mean / (r.start_mean || r.mean)), Infinity).over;
    }
  }

  // Game script: model xG vs market team goal expectations.
  console.log(`\nGame script — model xG vs market λ (home–away):`);
  for (const [key, m] of Object.entries(odds.matches).sort((a, b) => String(a[1].kickoff).localeCompare(String(b[1].kickoff)))) {
    if (!m.lambda) continue;
    const h = tidByAbbr[m.home], a = tidByAbbr[m.away];
    if (!h || !a) continue;
    const mh = teamTotal(model.team_factors.xg, h, a, true), ma = teamTotal(model.team_factors.xg, a, h, false);
    console.log(`  ${key.padEnd(8)} model ${mh.toFixed(2)}–${ma.toFixed(2)}   market ${m.lambda.home.toFixed(2)}–${m.lambda.away.toFixed(2)}`);
  }

  // Standard lines: both sides, vs 57.7%.
  const be = breakEven("standard");
  const std = rows.filter((r) => r.type === "standard").map((r) => {
    const side = r.model_over >= r.model_under ? "OVER" : "UNDER";
    const p = side === "OVER" ? r.model_over : r.model_under;
    const mk = r.market_over == null ? null : side === "OVER" ? r.market_over : 1 - r.market_over;
    return { ...r, side, p, mk, edge: p - be };
  }).sort((a, b) => b.edge - a.edge);
  console.log(`\nStandard lines (${std.length}) — best side by model vs break-even ${pct(be)}; market = level-matched book view of the same side:`);
  console.log(`  ${"player".padEnd(24)} ${"team".padEnd(8)} ${"prop".padEnd(20)} line  side    model  market  play%   edge`);
  for (const r of std.slice(0, TOP)) {
    const agree = r.mk == null ? " " : r.mk >= be ? "✓" : "✗";
    console.log(`  ${r.player.slice(0, 24).padEnd(24)} ${`${r.team}${r.venue === "home" ? "v" : "@"}${r.opp}`.padEnd(8)} ${r.pp_stat.slice(0, 20).padEnd(20)} ${String(r.line).padStart(4)}  ${r.side.padEnd(5)} ${pct(r.p)} ${pct(r.mk)}${agree} ${pct(r.p_play)} ${(r.edge * 100).toFixed(1).padStart(5)}`);
  }

  // Goblins / demons: over-only.
  for (const type of ["goblin", "demon"]) {
    const t = rows.filter((r) => r.type === type).map((r) => ({ ...r, edge: r.model_over - breakEven(type) })).sort((a, b) => b.edge - a.edge);
    const plus = t.filter((r) => r.edge > 0);
    const both = plus.filter((r) => r.market_over != null && r.market_over >= breakEven(type));
    console.log(`\n${type}s (${t.length}, over-only, approx b/e ${pct(breakEven(type))}): model clears b/e on ${plus.length}; market agrees on ${both.length}. Top by model edge:`);
    for (const r of t.slice(0, Math.min(10, TOP))) {
      console.log(`  ${r.player.slice(0, 24).padEnd(24)} ${`${r.team}${r.venue === "home" ? "v" : "@"}${r.opp}`.padEnd(8)} ${r.pp_stat.slice(0, 20).padEnd(20)} ${String(r.line).padStart(4)}  model ${pct(r.model_over)}  market ${pct(r.market_over)}  edge ${(r.edge * 100).toFixed(1)}`);
    }
  }
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
