// NBA team tracker, step 2: pure aggregation of the per-game box scores
// (api/_lib/basketball/boxscores.js) into season-only team offense / defense,
// starters-only splits, league-relative playstyle tags, opponent-adjusted
// performance against each playstyle, and player leaderboards.
//
// Definitions (all season-to-date, this season only):
//   poss        official possessions from the advanced box (per team-game)
//   ORtg/DRtg   100 · points scored ÷ own possessions / allowed ÷ opponent possessions
//   eFG         (FGM + 0.5·3PM) / FGA          TS  PTS / (2·(FGA + 0.44·FTA))
//   TOV%        TOV / poss                      OREB%  OREB / (OREB + opp DREB)
//   FT rate     FTA / FGA                       3PA rate  3PA / FGA
//   paint / fast-break / 2nd-chance shares = those points ÷ total points
//   Opponent-adjusted game residual (vs-playstyle splits):
//     offense: game ORtg − (team ORtg + opp DRtg − league ORtg)
//     defense: game DRtg − (team DRtg + opp ORtg − league ORtg)   (negative = better D)
//   with the game itself left out of both season ratings (leave-one-out), so a
//   team's one game doesn't explain itself.

const sum = (a, f = (x) => x) => a.reduce((s, x) => s + (f(x) ?? 0), 0);
const div = (a, b) => (b > 0 ? a / b : null);
const r = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

export const OFF_TAGS = {
  pace: { label: ["Fast pace", "Slow pace"], hi: true },
  rate3: { label: ["3PT-heavy", "Inside-oriented"], hi: true },
  paint: { label: ["Paint attack", "Perimeter scoring"], hi: true },
  fb: { label: ["Transition", "Half-court"], hi: true },
  ast_pct: { label: ["Ball movement", "Isolation / self-created"], hi: true },
  oreb_pct: { label: ["Crashes the glass", "Gets back (no crash)"], hi: true },
  ft_rate: { label: ["Draws fouls", "Rarely gets to the line"], hi: true },
};
export const DEF_TAGS = {
  opp_rate3: { label: ["Concedes threes", "Runs teams off the 3PT line"], hi: true },
  opp_paint: { label: ["Soft in the paint", "Paint deny"], hi: true },
  forced_tov: { label: ["Turnover-forcing pressure", "Low-pressure / no gambles"], hi: true },
  opp_ft_rate: { label: ["Foul-prone", "Disciplined (few fouls)"], hi: true },
  dreb_pct: { label: ["Cleans the defensive glass", "Gives up offensive boards"], hi: true },
  blk_rate: { label: ["Rim protection", "No rim protection"], hi: true },
};

function lineOf(t, o) {
  // t / o = the stored team block for the team and its opponent in one game
  const T = t.totals, O = o.totals, poss = t.adv?.poss ?? null;
  // Team turnovers (shot clock, 8-second, ...) aren't in the v3 box — the
  // refresh attaches the game log's total as tov_total.
  const tov = T.tov_total ?? T.tov, oTov = O.tov_total ?? O.tov;
  return {
    poss, o_poss: o.adv?.poss ?? null, pts: T.pts, opp_pts: O.pts, fgm: T.fgm, fga: T.fga, fg3m: T.fg3m, fg3a: T.fg3a, ftm: T.ftm, fta: T.fta,
    oreb: T.oreb, dreb: T.dreb, ast: T.ast, tov, stl: T.stl, blk: T.blk, pf: T.pf,
    o_fgm: O.fgm, o_fga: O.fga, o_fg3m: O.fg3m, o_fg3a: O.fg3a, o_ftm: O.ftm, o_fta: O.fta, o_oreb: O.oreb, o_dreb: O.dreb, o_tov: oTov, o_ast: O.ast,
    paint: t.misc?.pts_paint ?? null, fb: t.misc?.pts_fb ?? null, sc: t.misc?.pts_2nd ?? null, pot: t.misc?.pts_off_tov ?? null,
    o_paint: t.misc?.opp_pts_paint ?? null, o_fb: t.misc?.opp_pts_fb ?? null, o_sc: t.misc?.opp_pts_2nd ?? null, o_pot: t.misc?.opp_pts_off_tov ?? null,
    pace: t.adv?.pace ?? null, deflections: t.hustle?.deflections ?? null, contests: t.hustle?.contests ?? null,
    bench_pts: t.bench.pts, starter_pts: t.starters.pts,
  };
}

/** Rates from summed game lines (sums over any subset of games). */
export function ratesOf(lines) {
  const S = (k) => sum(lines, (x) => x[k]);
  const n = lines.length, poss = S("poss"), oPoss = S("o_poss");
  return {
    games: n, poss,
    ppg: div(S("pts"), n), opp_ppg: div(S("opp_pts"), n),
    // Official definitions: ORtg per own possessions, DRtg per OPPONENT possessions.
    ortg: div(100 * S("pts"), poss), drtg: div(100 * S("opp_pts"), oPoss), net: div(100 * S("pts"), poss) - div(100 * S("opp_pts"), oPoss),
    pace: div(sum(lines, (x) => x.pace), n),
    efg: div(S("fgm") + 0.5 * S("fg3m"), S("fga")), ts: div(S("pts"), 2 * (S("fga") + 0.44 * S("fta"))),
    fg3_pct: div(S("fg3m"), S("fg3a")), rate3: div(S("fg3a"), S("fga")), ft_rate: div(S("fta"), S("fga")),
    tov_pct: div(S("tov"), poss), oreb_pct: div(S("oreb"), S("oreb") + S("o_dreb")), ast_pct: div(S("ast"), S("fgm")),
    paint: div(S("paint"), S("pts")), fb: div(S("fb"), S("pts")), sc_ppg: div(S("sc"), n), pot_ppg: div(S("pot"), n),
    bench_share: div(S("bench_pts"), S("pts")),
    // defense
    opp_efg: div(S("o_fgm") + 0.5 * S("o_fg3m"), S("o_fga")), opp_ts: div(S("opp_pts"), 2 * (S("o_fga") + 0.44 * S("o_fta"))),
    opp_fg3_pct: div(S("o_fg3m"), S("o_fg3a")), opp_rate3: div(S("o_fg3a"), S("o_fga")), opp_ft_rate: div(S("o_fta"), S("o_fga")),
    forced_tov: div(S("o_tov"), oPoss), dreb_pct: div(S("dreb"), S("dreb") + S("o_oreb")),
    opp_paint: div(S("o_paint"), S("opp_pts")), opp_paint_ppg: div(S("o_paint"), n), opp_fb_ppg: div(S("o_fb"), n), opp_sc_ppg: div(S("o_sc"), n),
    blk_rate: div(S("blk"), S("o_fga") - S("o_fg3a")), stl_pg: div(S("stl"), n), blk_pg: div(S("blk"), n),
    deflections_pg: div(S("deflections"), n), contests_pg: div(S("contests"), n), opp_ast_pct: div(S("o_ast"), S("o_fgm")),
  };
}

// Starters / bench unit line (one side), from the stored player rows.
function unitOf(players) {
  const S = (k) => sum(players, (p) => p[k]);
  const min = S("min");
  const wAdv = (k) => div(sum(players, (p) => (p.adv?.[k] ?? 0) * p.min), sum(players, (p) => (p.adv?.[k] != null ? p.min : 0)));
  return {
    min, pts: S("pts"), reb: S("reb"), ast: S("ast"), stl: S("stl"), blk: S("blk"), tov: S("tov"),
    fgm: S("fgm"), fga: S("fga"), fg3m: S("fg3m"), fg3a: S("fg3a"), fta: S("fta"), pm: S("pm"),
    on_ortg: wAdv("ortg"), on_drtg: wAdv("drtg"),
    m_poss: sum(players, (p) => p.matchup?.m_poss), m_pts: sum(players, (p) => p.matchup?.m_pts),
    m_fgm: sum(players, (p) => p.matchup?.m_fgm), m_fga: sum(players, (p) => p.matchup?.m_fga),
  };
}
function unitRates(units) {
  const S = (k) => sum(units, (u) => u[k]);
  const n = units.length;
  return {
    games: n, mpg: div(S("min"), n), ppg: div(S("pts"), n), rpg: div(S("reb"), n), apg: div(S("ast"), n),
    ts: div(S("pts"), 2 * (S("fga") + 0.44 * S("fta"))), efg: div(S("fgm") + 0.5 * S("fg3m"), S("fga")),
    pts_per36: div(36 * S("pts"), S("min")), pm_pg: div(S("pm"), n),
    on_ortg: div(sum(units, (u) => (u.on_ortg ?? 0) * u.min), sum(units, (u) => (u.on_ortg != null ? u.min : 0))),
    on_drtg: div(sum(units, (u) => (u.on_drtg ?? 0) * u.min), sum(units, (u) => (u.on_drtg != null ? u.min : 0))),
    matchup_fg_pct: div(S("m_fgm"), S("m_fga")), matchup_pts_per100: div(100 * S("m_pts"), S("m_poss")),
  };
}

function tercileTags(teams, key, spec, getter) {
  const vals = teams.map((t) => [t, getter(t)]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
  const n = vals.length, k = Math.max(1, Math.round(n / 3));
  const out = {};
  vals.forEach(([t, v], i) => {
    out[t] = { key, value: v, rank: i + 1, of: n, tag: i < k ? spec.label[0] : i >= n - k ? spec.label[1] : null };
  });
  return out;
}

/**
 * @param {{ season, games: { id: game } }} store  data/basketball/box/nba-<season>.json
 * @returns tracker artifact (see header)
 */
export function buildTracker(store, { minPlayerMpg = 20, minPlayerGames = 2 } = {}) {
  const games = Object.values(store.games).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  const byTeam = {};
  for (const g of games) {
    for (const [tri, t] of Object.entries(g.teams)) {
      const o = g.teams[t.opp];
      const players = g.players.filter((p) => p.team === tri);
      const oppPlayers = g.players.filter((p) => p.team === t.opp);
      (byTeam[tri] ??= []).push({
        game_id: g.game_id, date: g.date, opp: t.opp, home: t.home, win: t.totals.pts > o.totals.pts,
        line: lineOf(t, o),
        starters: unitOf(players.filter((p) => p.starter)), bench: unitOf(players.filter((p) => !p.starter)),
        opp_starters: unitOf(oppPlayers.filter((p) => p.starter)), opp_bench: unitOf(oppPlayers.filter((p) => !p.starter)),
      });
    }
  }
  const tris = Object.keys(byTeam).sort();
  const season = Object.fromEntries(tris.map((t) => [t, ratesOf(byTeam[t].map((x) => x.line))]));
  const league = ratesOf(tris.flatMap((t) => byTeam[t].map((x) => x.line)));

  // Playstyle tags (league-relative terciles).
  const offTags = {}, defTags = {};
  for (const [k, spec] of Object.entries(OFF_TAGS)) {
    const tg = tercileTags(tris, k, spec, (t) => season[t][k]);
    for (const t of tris) (offTags[t] ??= []).push(tg[t]);
  }
  for (const [k, spec] of Object.entries(DEF_TAGS)) {
    const tg = tercileTags(tris, k, spec, (t) => season[t][k]);
    for (const t of tris) (defTags[t] ??= []).push(tg[t]);
  }
  const tagsOf = (list) => list.filter((x) => x?.tag).map((x) => x.tag);

  // Leave-one-out season ratings for the opponent-adjusted residuals.
  const loo = (tri, gameId) => ratesOf(byTeam[tri].filter((x) => x.game_id !== gameId).map((x) => x.line));
  const lgOrtg = league.ortg;
  const vsStyle = {};
  for (const tri of tris) {
    const off = {}, def = {}, startersOff = {}, startersDef = {};
    for (const x of byTeam[tri]) {
      const me = loo(tri, x.game_id), op = loo(x.opp, x.game_id);
      if (me.ortg == null || op.drtg == null) continue; // no other games yet
      const gr = ratesOf([x.line]);
      const offRes = gr.ortg - (me.ortg + op.drtg - lgOrtg);
      const defRes = gr.drtg - (me.drtg + op.ortg - lgOrtg);
      for (const tag of tagsOf(defTags[x.opp])) {
        const a = (off[tag] ??= { games: 0, res: 0, ortg: 0, efg: 0, rate3: 0, paint: 0, opps: [] });
        a.games++; a.res += offRes; a.ortg += gr.ortg; a.efg += gr.efg; a.rate3 += gr.rate3; a.paint += gr.paint ?? 0; a.opps.push(x.opp);
        const s = (startersOff[tag] ??= []); s.push(x.starters);
      }
      for (const tag of tagsOf(offTags[x.opp])) {
        const a = (def[tag] ??= { games: 0, res: 0, drtg: 0, opp_efg: 0, opp_rate3: 0, opp_paint: 0, opps: [] });
        a.games++; a.res += defRes; a.drtg += gr.drtg; a.opp_efg += gr.opp_efg; a.opp_rate3 += gr.opp_rate3; a.opp_paint += gr.opp_paint ?? 0; a.opps.push(x.opp);
        const s = (startersDef[tag] ??= []); s.push(x.opp_starters);
      }
    }
    const fin = (o, keys) => Object.fromEntries(Object.entries(o).map(([tag, a]) => [tag, {
      games: a.games, opps: a.opps, adj: r(a.res / a.games),
      ...Object.fromEntries(keys.map((k) => [k, r(a[k] / a.games, k === "ortg" || k === "drtg" ? 1 : 3)])),
    }]));
    vsStyle[tri] = {
      offense_vs_defense_style: fin(off, ["ortg", "efg", "rate3", "paint"]),
      defense_vs_offense_style: fin(def, ["drtg", "opp_efg", "opp_rate3", "opp_paint"]),
      starters_vs_defense_style: Object.fromEntries(Object.entries(startersOff).map(([tag, us]) => [tag, unitRates(us)])),
      opp_starters_vs_this_defense_by_offense_style: Object.fromEntries(Object.entries(startersDef).map(([tag, us]) => [tag, unitRates(us)])),
    };
  }

  const teams = Object.fromEntries(tris.map((tri) => {
    const xs = byTeam[tri];
    return [tri, {
      record: { w: xs.filter((x) => x.win).length, l: xs.filter((x) => !x.win).length },
      games: xs.map((x) => ({ date: x.date, opp: x.opp, home: x.home, win: x.win, pts: x.line.pts, opp_pts: x.line.opp_pts, ortg: r(ratesOf([x.line]).ortg), drtg: r(ratesOf([x.line]).drtg) })),
      offense: season[tri], defense: season[tri],
      offense_style: offTags[tri], defense_style: defTags[tri],
      offense_tags: tagsOf(offTags[tri]), defense_tags: tagsOf(defTags[tri]),
      starters: unitRates(xs.map((x) => x.starters)), bench: unitRates(xs.map((x) => x.bench)),
      opp_starters: unitRates(xs.map((x) => x.opp_starters)), opp_bench: unitRates(xs.map((x) => x.opp_bench)),
      vs_style: vsStyle[tri],
    }];
  }));

  return { season: store.season, games: games.length, through: games.at(-1)?.date ?? null, league, teams, players: playerBoards(games, league, { minPlayerMpg, minPlayerGames }) };
}

// ---- players --------------------------------------------------------------

function z(rows, key, sign = 1) {
  const v = rows.map((x) => x[key]).filter((x) => x != null);
  const m = sum(v) / v.length, sd = Math.sqrt(sum(v, (x) => (x - m) ** 2) / v.length) || 1;
  for (const x of rows) x[`z_${key}`] = x[key] == null ? 0 : (sign * (x[key] - m)) / sd;
}

export function playerBoards(games, league, { minPlayerMpg = 20, minPlayerGames = 2 } = {}) {
  const acc = new Map();
  for (const g of games) for (const p of g.players) {
    const a = acc.get(p.id) ?? { id: p.id, name: p.name, team: p.team, games: 0, starts: 0, rows: [] };
    a.games++; a.starts += p.starter ? 1 : 0; a.team = p.team; a.rows.push(p);
    acc.set(p.id, a);
  }
  const lgTs = league.ts, lgOrtg = league.ortg;
  const lgMatchFg = (() => { const all = games.flatMap((g) => g.players.map((p) => p.matchup).filter(Boolean)); return div(sum(all, (m) => m.m_fgm), sum(all, (m) => m.m_fga)); })();
  const out = [];
  for (const a of acc.values()) {
    const R = a.rows, S = (k) => sum(R, (p) => p[k]), H = (k) => sum(R, (p) => p.hustle?.[k]), M = (k) => sum(R, (p) => p.matchup?.[k]);
    const min = S("min"), n = a.games;
    const wAdv = (k) => div(sum(R, (p) => (p.adv?.[k] ?? 0) * p.min), sum(R, (p) => (p.adv?.[k] != null ? p.min : 0)));
    const tsa = S("fga") + 0.44 * S("fta");
    out.push({
      id: a.id, name: a.name, team: a.team, games: n, starts: a.starts, mpg: r(min / n),
      ppg: r(S("pts") / n), rpg: r(S("reb") / n), apg: r(S("ast") / n), spg: r(S("stl") / n), bpg: r(S("blk") / n), tov_pg: r(S("tov") / n),
      fg3m_pg: r(S("fg3m") / n), ts: r(div(S("pts"), 2 * tsa), 3), usg: r(wAdv("usg"), 3),
      on_ortg: r(wAdv("ortg")), on_drtg: r(wAdv("drtg")), pm_pg: r(S("pm") / n),
      // points above league-average shooting efficiency, per game
      eff_added: r((S("pts") - 2 * tsa * lgTs) / n, 2),
      dreb_36: r(36 * S("dreb") / min), stocks_36: r(36 * (S("stl") + S("blk")) / min),
      deflections_36: r(36 * H("deflections") / min), contests_36: r(36 * H("contests") / min), charges: H("charges"),
      loose_balls_pg: r(H("loose_balls") / n), box_outs_pg: r(H("box_outs") / n),
      m_poss: r(M("m_poss")), m_fga: M("m_fga"), m_fg_pct: r(div(M("m_fgm"), M("m_fga")), 3),
      m_pts_per100: r(div(100 * M("m_pts"), M("m_poss"))),
      // shots made against him below what a league-average defender allows on the same volume, per game
      makes_saved_pg: M("m_fga") ? r(((lgMatchFg * M("m_fga")) - M("m_fgm")) / n, 2) : null,
      _min: min,
    });
  }
  const q = out.filter((p) => p.games >= minPlayerGames && p.mpg >= minPlayerMpg);
  z(q, "ppg"); z(q, "eff_added"); z(q, "apg"); z(q, "on_ortg"); z(q, "tov_pg", -1);
  for (const p of q) p.off_score = r(p.z_ppg + p.z_eff_added + 0.75 * p.z_apg + 0.5 * p.z_on_ortg + 0.25 * p.z_tov_pg, 2);
  const qd = q.filter((p) => (p.m_poss ?? 0) >= 60);
  z(qd, "stocks_36"); z(qd, "deflections_36"); z(qd, "contests_36"); z(qd, "makes_saved_pg"); z(qd, "on_drtg", -1); z(qd, "dreb_36");
  for (const p of qd) p.def_score = r(p.z_stocks_36 + 0.75 * p.z_deflections_36 + 0.5 * p.z_contests_36 + p.z_makes_saved_pg + 0.75 * p.z_on_drtg + 0.25 * p.z_dreb_36, 2);
  const clean = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("z_") && k !== "_min"));
  return {
    league_ts: r(lgTs, 3), league_ortg: r(lgOrtg), league_matchup_fg: r(lgMatchFg, 3),
    qualify: { min_games: minPlayerGames, min_mpg: minPlayerMpg, def_min_matchup_poss: 60 },
    offense_top: [...q].sort((a, b) => b.off_score - a.off_score).slice(0, 25).map(clean),
    defense_top: [...qd].sort((a, b) => b.def_score - a.def_score).slice(0, 25).map(clean),
    all: out.map(clean),
  };
}
