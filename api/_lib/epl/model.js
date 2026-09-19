// Premier League player-prop model (step 2 of the EPL plan). Pure: fit on a
// data/epl-matches.json snapshot, price with the fitted artifact.
//
// Structure — a player's count for stat s in an upcoming match:
//
//   X ~ NB( μ, r_s )   μ = share_i,s × T_s(team, opp, venue) × minutes/90
//
//   T_s      expected TEAM total of s in this fixture. Two-way multiplicative
//            model fitted on this season's team-matches:
//              T = μ_s × att_team × def_opp × η_s^(±1)
//            att = what the team produces, def = what the opponent concedes
//            (for tackles/clearances: how much defending the opponent forces),
//            η = home effect. Both factors are shrunk toward 1 with an
//            empirical-Bayes weight n/(n + k) — with 4–5 matches per team the
//            data decides how much to trust each team's sample.
//   share    player's share of his team's total per 90 on the pitch, measured
//            against ACTUAL team totals (so it is opponent-neutral — the
//            opponent enters once, via T). Gamma–Poisson empirical Bayes:
//            posterior = (α + y) / (β + e), prior centred on the role average.
//   minutes  mixture over playing-time scenarios (full 90 / subbed off / off
//            the bench), recency-weighted from this season. Prices are
//            conditioned on the player playing (a DNP voids the pick).
//   r_s      NB size per stat from leave-one-out residuals (Infinity =
//            Poisson).
//
// Keepers: saves = expected shots on target faced × keeper save rate (beta-
// binomial shrink to league); goals conceded = the complement. Goals and
// assists ride on xG / xA shares (far steadier than raw goals), Poisson.
// Fantasy Score is simulated from its components with a seeded generator.

import {
  mixtureLineProbs, mixtureMean, mulberry32, seedFrom, sampleCount, sampleBinomial,
} from "./distributions.js";

export const MODEL_VERSION = 1;

// ─── Roles ───────────────────────────────────────────────────────────────────

export const ROLES = ["GK", "CB", "FB", "CM", "AM", "W", "ST"];

// FotMob positionId = pitch line (leading digits) + lateral slot (last digit),
// mapped from 2026-27 lineup coordinates and per-90 profiles:
//   11 GK | 3x back line: slots 2/8 FB, 3–7 CB | 5x wing-backs → FB
//   6x/7x midfield lines: wide slots (1/2/8/9) FB-like, central CM
//   8x attacking line: wide (2/3/7/8) W, central (4–6) AM
//   10x front line: wide (≤3, ≥7) W, central ST | 11x lone striker ST
export function roleFromPositionId(pid) {
  const id = Number(pid);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (id === 11) return "GK";
  const line = Math.floor(id / 10);
  const slot = id % 10;
  if (line === 3) return slot === 2 || slot === 8 ? "FB" : "CB";
  if (line === 5) return "FB";
  if (line === 6 || line === 7) return slot <= 2 || slot >= 8 ? "FB" : "CM";
  if (line === 8) return slot <= 3 || slot >= 7 ? "W" : "AM";
  if (line === 10) return slot <= 3 || slot >= 7 ? "W" : "ST";
  if (line === 11) return "ST";
  return null;
}

// FotMob usualPlayingPositionId / FPL element type fallback for players who
// never started (no positionId on bench appearances).
const USUAL_ROLE = { 0: "GK", 1: "CB", 2: "CM", 3: "ST" };
const FPL_ROLE = { GK: "GK", DEF: "CB", MID: "CM", FWD: "ST" };

// ─── Stats ───────────────────────────────────────────────────────────────────

// Team-share stats: player count = share × team total × minutes/90.
export const SHARE_STATS = [
  "shots", "sot", "key_passes", "passes_att", "crosses_att", "dribbles_att",
  "tackles", "clearances", "fouls", "fouled", "xg", "xa",
];

// Priced props → the share stat that drives the mean. goals/assists use the
// xG/xA share and are always Poisson.
export const PROP_STATS = {
  shots: { base: "shots" },
  sot: { base: "sot" },
  key_passes: { base: "key_passes" }, // PrizePicks "Shots Assisted"
  passes_att: { base: "passes_att" },
  crosses_att: { base: "crosses_att" },
  dribbles_att: { base: "dribbles_att" },
  tackles: { base: "tackles" },
  clearances: { base: "clearances" },
  fouls: { base: "fouls" },
  fouled: { base: "fouled" },
  goals: { base: "xg", poisson: true },
  assists: { base: "xa", poisson: true },
  saves: { gk: true },
  goals_conceded: { gk: true, poisson: true },
};

// PrizePicks soccer Fantasy Score (outfield), in-app chart transcribed
// 2026-06-11 for the World Cup board — re-verify against the EPL board.
export const FANTASY_WEIGHTS = {
  goals: 10, assists: 5, shots: 1, sot: 1, passes_att: 0.05, key_passes: 0.5,
  clearances: 1, tackles: 1, dribbles_att: 1, crosses_att: 0.5,
  yellow: -1, red: -2, fouls: -0.5,
};

// Market game-script elasticities (step 3 feeds bookmaker team goal
// expectations). T_s *= (market / model)^e on the named driver:
//   for      = own expected goals, against = opponent's expected goals,
//   ratio    = own / opponent (possession proxy).
// Initial priors (the WC build used 0.8/0.6/0.45/0.3 for similar drivers) —
// recalibrate once graded EPL outcomes exist.
export const MARKET_ELASTICITY = {
  shots: { for: 0.8 }, sot: { for: 0.9 }, key_passes: { for: 0.7 },
  xg: { for: 1 }, xa: { for: 1 }, crosses_att: { for: 0.5 },
  dribbles_att: { ratio: 0.3 }, passes_att: { ratio: 0.3 },
  tackles: { against: 0.4 }, clearances: { against: 0.5 },
  fouls: {}, fouled: {}, sot_against: { against: 0.9 },
};

const FULL_MATCH_MIN = 88; // a start with ≥88' counts as a full 90

// Minimum empirical-Bayes prior strength for the team factors, in matches.
// The EB estimate of k is itself noisy with 1–4 matches per team; the floor
// keeps an early-season team from being trusted on one or two results.
// Chosen by the walk-forward backtest (scripts/backtest-epl-model.mjs,
// 2026-09-18, rounds 2–5): log loss at the line was best for floors 5–8
// (0.5563 vs 0.5582 at 1); higher floors trade away the real passing-style
// signal (passes CRPS 6.20 at 1 → 6.40 at 5 → 6.57 at 12).
export const TEAM_SHRINK_FLOOR = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? x : Number(x.toFixed(d)));

function weightedVar(values, weights) {
  const W = sum(weights);
  if (!(W > 0)) return 0;
  const m = sum(values.map((v, i) => v * weights[i])) / W;
  return sum(values.map((v, i) => weights[i] * (v - m) ** 2)) / W;
}

// ─── Team-match table ────────────────────────────────────────────────────────

function buildTeamMatches(matches, rows) {
  const byMatch = new Map(matches.map((m) => [m.match_id, m]));
  const tm = new Map(); // `${match}|${team}` → record
  for (const m of matches) {
    for (const [side, other] of [["home", "away"], ["away", "home"]]) {
      tm.set(`${m.match_id}|${m[side].team_id}`, {
        match_id: m.match_id, round: m.round, kickoff: m.kickoff_utc,
        team: m[side].team_id, opp: m[other].team_id, home: side === "home",
        goals_for: m[side].score ?? 0, goals_against: m[other].score ?? 0,
        tot: Object.fromEntries([...SHARE_STATS, "saves", "goals"].map((s) => [s, 0])),
      });
    }
  }
  for (const r of rows) {
    if (!byMatch.has(r.match_id)) continue;
    const rec = tm.get(`${r.match_id}|${r.team_id}`);
    if (!rec) continue;
    for (const s of [...SHARE_STATS, "saves", "goals"]) rec.tot[s] += r[s] ?? 0;
  }
  const list = [...tm.values()];
  const idx = new Map(list.map((x) => [`${x.match_id}|${x.team}`, x]));
  for (const x of list) x.oppRec = idx.get(`${x.match_id}|${x.opp}`);
  return list;
}

// ─── Two-way team factors ────────────────────────────────────────────────────

function fitTwoWay(teamMatches, value, { iters = 40, kFloor = 1 } = {}) {
  const obs = teamMatches.map((x) => ({ team: x.team, opp: x.opp, home: x.home, y: value(x) })).filter((o) => o.y != null);
  const teams = [...new Set(obs.flatMap((o) => [o.team, o.opp]))];
  const mu0 = mean(obs.map((o) => o.y)) || 0;
  if (!(mu0 > 0)) return { mu: 0, eta: 1, att: {}, def: {}, k_att: null, k_def: null };

  const homeMean = mean(obs.filter((o) => o.home).map((o) => o.y)) ?? mu0;
  const awayMean = mean(obs.filter((o) => !o.home).map((o) => o.y)) ?? mu0;
  const nMatch = obs.length / 2;
  let eta = Math.sqrt(homeMean / awayMean);
  eta = 1 + (eta - 1) * (nMatch / (nMatch + 20)); // light shrink on few matches
  if (!Number.isFinite(eta) || eta <= 0) eta = 1;

  const run = (kAtt, kDef) => {
    const att = Object.fromEntries(teams.map((t) => [t, 1]));
    const def = Object.fromEntries(teams.map((t) => [t, 1]));
    let mu = mu0;
    for (let it = 0; it < iters; it++) {
      for (const t of teams) {
        const mine = obs.filter((o) => o.team === t);
        if (!mine.length) continue;
        const ratio = sum(mine.map((o) => o.y)) / sum(mine.map((o) => mu * def[o.opp] * (o.home ? eta : 1 / eta)));
        const w = kAtt == null ? 1 : mine.length / (mine.length + kAtt);
        att[t] = 1 + w * (ratio - 1);
      }
      for (const t of teams) {
        const vs = obs.filter((o) => o.opp === t);
        if (!vs.length) continue;
        const ratio = sum(vs.map((o) => o.y)) / sum(vs.map((o) => mu * att[o.team] * (o.home ? eta : 1 / eta)));
        const w = kDef == null ? 1 : vs.length / (vs.length + kDef);
        def[t] = 1 + w * (ratio - 1);
      }
      mu = sum(obs.map((o) => o.y)) / sum(obs.map((o) => att[o.team] * def[o.opp] * (o.home ? eta : 1 / eta)));
    }
    return { att, def, mu };
  };

  // Empirical Bayes prior strength k = σ²_within / τ²_between (in matches),
  // from an unshrunk fit: per-match ratios scatter around each team's factor.
  const raw = run(null, null);
  const kFor = (side) => {
    const factor = side === "att" ? raw.att : raw.def;
    const groupKey = side === "att" ? "team" : "opp";
    const groups = new Map();
    for (const o of obs) {
      const base = raw.mu * raw.att[o.team] * raw.def[o.opp] * (o.home ? eta : 1 / eta);
      if (!(base > 0)) continue;
      const g = o[groupKey];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push((o.y / base) * factor[g]); // per-match estimate of the factor
    }
    const within = [];
    const means = [];
    const ns = [];
    for (const vals of groups.values()) {
      if (vals.length < 2) continue;
      const m = mean(vals);
      within.push(sum(vals.map((v) => (v - m) ** 2)) / (vals.length - 1));
      means.push(m);
      ns.push(vals.length);
    }
    if (means.length < 4) return Math.max(10, kFloor);
    const sigma2 = mean(within);
    const tau2 = Math.max(weightedVar(means, ns.map(() => 1)) - mean(ns.map((n) => sigma2 / n)), 0.0025);
    return Math.min(30, Math.max(kFloor, sigma2 / tau2));
  };
  const kAtt = kFor("att");
  const kDef = kFor("def");
  const fit = run(kAtt, kDef);
  const r4 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
  return { mu: round(fit.mu), eta: round(eta), att: r4(fit.att), def: r4(fit.def), k_att: round(kAtt, 2), k_def: round(kDef, 2) };
}

export function teamTotal(tf, team, opp, home) {
  if (!tf || !(tf.mu > 0)) return 0;
  return tf.mu * (tf.att?.[team] ?? 1) * (tf.def?.[opp] ?? 1) * (home ? tf.eta : 1 / tf.eta);
}

// ─── Fit ─────────────────────────────────────────────────────────────────────

/**
 * Fit the model on a snapshot.
 * @param {Object} snapshot  data/epl-matches.json
 * @param {Object} [opts]
 * @param {number} [opts.beforeRound]  train only on rounds < this (backtests)
 * @param {Object} [opts.registry]     data/epl-players.json — adds FPL
 *   status/news and prior-only entries for players with no minutes yet
 */
export function fitModel(snapshot, { beforeRound = null, registry = null, teamShrinkFloor = TEAM_SHRINK_FLOOR } = {}) {
  const matches = (snapshot.matches || [])
    .filter((m) => beforeRound == null || m.round < beforeRound)
    .sort((a, b) => String(a.kickoff_utc).localeCompare(String(b.kickoff_utc)));
  const matchIds = new Set(matches.map((m) => m.match_id));
  const rows = (snapshot.player_matches || []).filter((r) => matchIds.has(r.match_id));
  const teamMatches = buildTeamMatches(matches, rows);
  const tmIdx = new Map(teamMatches.map((x) => [`${x.match_id}|${x.team}`, x]));

  // Team factors: every share stat, plus shots on target conceded (keepers).
  const team_factors = {};
  for (const s of SHARE_STATS) team_factors[s] = fitTwoWay(teamMatches, (x) => x.tot[s], { kFloor: teamShrinkFloor });

  // Player roles: minutes-weighted mode over starts, else usual/FPL position.
  const roleVotes = new Map();
  const usual = new Map();
  for (const r of rows) {
    if (r.usual_position_id != null) usual.set(r.player_id, r.usual_position_id);
    const role = r.started ? roleFromPositionId(r.position_id) : null;
    if (!role) continue;
    const v = roleVotes.get(r.player_id) ?? {};
    v[role] = (v[role] || 0) + (r.minutes || 0);
    roleVotes.set(r.player_id, v);
  }
  const regPlayers = registry?.players ?? {};
  const roleOf = (pid, gkFlag) => {
    const v = roleVotes.get(pid);
    if (v) return Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    if (gkFlag) return "GK";
    const u = usual.get(pid);
    if (u != null && USUAL_ROLE[u]) return USUAL_ROLE[u];
    return FPL_ROLE[regPlayers[pid]?.fpl_position] ?? "CM";
  };

  // Per-player aggregates.
  const players = {};
  for (const r of rows) {
    const p = (players[r.player_id] ??= {
      name: r.name, team_id: r.team_id, gk: !!r.gk, rows: [],
    });
    p.name = r.name;
    p.team_id = r.team_id;
    p.gk = p.gk || !!r.gk;
    p.rows.push(r);
  }
  for (const [pid, p] of Object.entries(players)) p.role = roleOf(pid, p.gk);

  // Shares: exposure e = team actual total × minutes/90.
  const role_priors = {};
  const shares = {}; // stat → pid → { y, e, share }
  for (const s of SHARE_STATS) {
    const agg = {};
    for (const [pid, p] of Object.entries(players)) {
      let y = 0, e = 0;
      for (const r of p.rows) {
        if (!(r.minutes > 0)) continue;
        const tot = tmIdx.get(`${r.match_id}|${r.team_id}`)?.tot[s] ?? 0;
        y += r[s] ?? 0;
        e += (tot * r.minutes) / 90;
      }
      agg[pid] = { y, e, role: p.role };
    }
    role_priors[s] = {};
    for (const role of ROLES) {
      const members = Object.values(agg).filter((a) => a.role === role && a.e > 0);
      const Y = sum(members.map((a) => a.y));
      const E = sum(members.map((a) => a.e));
      if (!(E > 0)) {
        role_priors[s][role] = { mean: 0, alpha: 0, beta: 1 };
        continue;
      }
      const mu = Y / E;
      // Between-player variance of true shares: observed variance minus
      // Poisson noise, floored at a 15% coefficient of variation.
      const big = members.filter((a) => a.e >= 0.5 * (E / members.length));
      const obsVar = weightedVar(big.map((a) => a.y / a.e), big.map((a) => a.e));
      const noise = mean(big.map((a) => mu / a.e)) ?? 0;
      const tau2 = Math.max(obsVar - noise, (0.15 * mu) ** 2, 1e-12);
      const alpha = mu > 0 ? (mu * mu) / tau2 : 0;
      const beta = mu > 0 ? mu / tau2 : 1;
      role_priors[s][role] = { mean: round(mu, 6), alpha: round(alpha, 4), beta: round(beta, 4) };
    }
    shares[s] = {};
    for (const [pid, a] of Object.entries(agg)) {
      const pr = role_priors[s][a.role];
      const share = pr.beta + a.e > 0 ? (pr.alpha + a.y) / (pr.beta + a.e) : pr.mean;
      shares[s][pid] = { y: a.y, e: a.e, share };
    }
  }

  // Dispersion: NB size r per stat from leave-one-out predictive residuals
  // (share without the match × model team total × minutes/90).
  const dispersion = {};
  for (const s of SHARE_STATS) {
    if (s === "xg" || s === "xa") continue;
    let num = 0, den = 0;
    for (const [pid, p] of Object.entries(players)) {
      const pr = role_priors[s][p.role];
      const a = shares[s][pid];
      for (const r of p.rows) {
        if (!(r.minutes > 0)) continue;
        const rec = tmIdx.get(`${r.match_id}|${r.team_id}`);
        const tot = rec?.tot[s] ?? 0;
        const y = r[s] ?? 0;
        const eJ = (tot * r.minutes) / 90;
        const shareLoo = (pr.alpha + a.y - y) / (pr.beta + a.e - eJ);
        if (!Number.isFinite(shareLoo) || shareLoo <= 0) continue;
        const muHat = shareLoo * teamTotal(team_factors[s], r.team_id, rec.opp, rec.home) * (r.minutes / 90);
        num += muHat * muHat;
        den += (y - muHat) ** 2 - muHat;
      }
    }
    dispersion[s] = den > 0 && num > 0 ? round(Math.max(num / den, 0.5), 3) : null; // null = Poisson
  }

  // Keepers: save rate over shots on target faced while on the pitch.
  const sotFaced = (r) => (tmIdx.get(`${r.match_id}|${r.team_id}`)?.oppRec?.tot.sot ?? 0) * ((r.minutes || 0) / 90);
  const gkRows = rows.filter((r) => r.gk && r.minutes > 0);
  const leagueSaves = sum(gkRows.map((r) => r.saves ?? 0));
  const leagueFaced = sum(gkRows.map(sotFaced));
  const leagueSaveRate = leagueFaced > 0 ? leagueSaves / leagueFaced : 0.7;
  const SAVE_PRIOR_N = 30; // shots on target of prior weight
  const saveRate = {};
  for (const [pid, p] of Object.entries(players)) {
    if (!p.gk) continue;
    const kr = p.rows.filter((r) => r.minutes > 0);
    const sv = sum(kr.map((r) => r.saves ?? 0));
    const fc = sum(kr.map(sotFaced));
    saveRate[pid] = (sv + SAVE_PRIOR_N * leagueSaveRate) / (fc + SAVE_PRIOR_N);
  }
  let saveNum = 0, saveDen = 0;
  for (const r of gkRows) {
    const rec = tmIdx.get(`${r.match_id}|${r.team_id}`);
    const muHat = saveRate[r.player_id] * teamTotal(team_factors.sot, rec.opp, r.team_id, !rec.home) * (r.minutes / 90);
    saveNum += muHat * muHat;
    saveDen += ((r.saves ?? 0) - muHat) ** 2 - muHat;
  }
  dispersion.saves = saveDen > 0 ? round(Math.max(saveNum / saveDen, 0.5), 3) : null;

  // Cards per 90 (Poisson, role-pooled prior of 10 matches' weight).
  const cardRate = (field) => {
    const byRole = {};
    for (const role of ROLES) {
      const members = Object.values(players).filter((p) => p.role === role);
      const y = sum(members.flatMap((p) => p.rows.map((r) => r[field] ?? 0)));
      const e = sum(members.flatMap((p) => p.rows.map((r) => (r.minutes || 0) / 90)));
      byRole[role] = e > 0 ? y / e : 0;
    }
    return byRole;
  };
  const yellowRole = cardRate("yellow_cards");
  const redRole = cardRate("red_cards");

  // Minutes profiles.
  const teamSchedule = new Map(); // team → [match_id] chronological
  for (const m of matches) {
    for (const side of ["home", "away"]) {
      const t = m[side].team_id;
      if (!teamSchedule.has(t)) teamSchedule.set(t, []);
      teamSchedule.get(t).push(m.match_id);
    }
  }
  const roleMinutes = {};
  for (const role of ROLES) {
    const st = Object.values(players).filter((p) => p.role === role).flatMap((p) => p.rows.filter((r) => r.started));
    const early = st.filter((r) => r.minutes < FULL_MATCH_MIN);
    roleMinutes[role] = {
      q_full: st.length ? st.filter((r) => r.minutes >= FULL_MATCH_MIN).length / st.length : 0.6,
      m_early: mean(early.map((r) => r.minutes)) ?? 65,
    };
  }
  const allSubs = rows.filter((r) => !r.started && r.minutes > 0);
  const leagueSubMin = mean(allSubs.map((r) => r.minutes)) ?? 18;

  const out = {};
  for (const [pid, p] of Object.entries(players)) {
    const byMatch = new Map(p.rows.map((r) => [r.match_id, r]));
    const sched = teamSchedule.get(p.team_id) ?? [];
    const firstIdx = sched.findIndex((id) => byMatch.has(id));
    const window = firstIdx >= 0 ? sched.slice(firstIdx) : [];
    // Recency weights: half-life of 3 team matches.
    let wS = 0, wSub = 0, W = 0;
    window.forEach((id, i) => {
      const age = window.length - 1 - i;
      const w = Math.pow(0.5, age / 3);
      const r = byMatch.get(id);
      W += w;
      if (r?.started) wS += w;
      else if (r && r.minutes > 0) wSub += w;
    });
    const A = 0.5; // prior weight (matches)
    const pStart = (wS + A * 0.3) / (W + A);
    const pSub = Math.min(1 - pStart, (wSub + A * 0.2) / (W + A));
    const starts = p.rows.filter((r) => r.started);
    const rm = roleMinutes[p.role];
    const K = 3; // shrink per-player minutes toward role with 3 starts' weight
    const qFull = (starts.filter((r) => r.minutes >= FULL_MATCH_MIN).length + K * rm.q_full) / (starts.length + K);
    const early = starts.filter((r) => r.minutes < FULL_MATCH_MIN);
    const mEarly = (sum(early.map((r) => r.minutes)) + K * rm.m_early) / (early.length + K);
    const subs = p.rows.filter((r) => !r.started && r.minutes > 0);
    const mSub = (sum(subs.map((r) => r.minutes)) + K * leagueSubMin) / (subs.length + K);

    const exposure90 = sum(p.rows.map((r) => (r.minutes || 0) / 90));
    const yExp = sum(p.rows.map((r) => r.yellow_cards ?? 0));
    const reg = regPlayers[pid] ?? null;

    out[pid] = {
      name: p.name,
      team_id: p.team_id,
      role: p.role,
      gk: p.gk,
      apps: p.rows.filter((r) => r.minutes > 0).length,
      starts: starts.length,
      minutes_total: sum(p.rows.map((r) => r.minutes || 0)),
      shares: Object.fromEntries(SHARE_STATS.map((s) => [s, round(shares[s][pid].share, 6)])),
      exposure: Object.fromEntries(SHARE_STATS.map((s) => [s, round(shares[s][pid].e, 2)])),
      minutes: {
        p_start: round(pStart, 3), p_sub: round(pSub, 3),
        q_full: round(qFull, 3), m_early: round(mEarly, 1), m_sub: round(mSub, 1),
      },
      cards: {
        yellow_p90: round((yExp + 10 * yellowRole[p.role]) / (exposure90 + 10), 4),
        red_p90: round(redRole[p.role], 4),
      },
      save_rate: p.gk ? round(saveRate[pid], 4) : null,
      status: reg ? { fpl: reg.status ?? null, chance_next: reg.chance_next ?? null, news: reg.news ?? null } : null,
    };
  }

  // Prior-only entries (FPL players with no appearances yet) — priced from
  // role averages; step 4 gates these (no player data → SKIP by default).
  if (registry?.fpl_only) {
    const teamByAbbr = Object.fromEntries(Object.entries(registry.teams || {}).map(([tid, t]) => [t.abbr, tid]));
    for (const f of registry.fpl_only) {
      const tid = teamByAbbr[f.abbr];
      if (!tid || out[`fpl:${f.fpl_id}`]) continue;
      const role = FPL_ROLE[f.fpl_position] ?? "CM";
      out[`fpl:${f.fpl_id}`] = {
        name: f.name, team_id: tid, role, gk: role === "GK", apps: 0, starts: 0, minutes_total: 0, prior_only: true,
        shares: Object.fromEntries(SHARE_STATS.map((s) => [s, role_priors[s][role]?.mean ?? 0])),
        exposure: Object.fromEntries(SHARE_STATS.map((s) => [s, 0])),
        minutes: { p_start: 0.15, p_sub: 0.2, q_full: roleMinutes[role].q_full, m_early: roleMinutes[role].m_early, m_sub: leagueSubMin },
        cards: { yellow_p90: round(yellowRole[role], 4), red_p90: round(redRole[role], 4) },
        save_rate: role === "GK" ? round(leagueSaveRate, 4) : null,
        status: { fpl: f.status ?? null, chance_next: f.chance_next ?? null, news: f.news ?? null },
      };
    }
  }

  return {
    version: MODEL_VERSION,
    season: snapshot.season ?? null,
    trained_matches: matches.length,
    trained_through: matches.length ? matches[matches.length - 1].kickoff_utc : null,
    before_round: beforeRound,
    team_factors,
    role_priors,
    dispersion,
    league: { save_rate: round(leagueSaveRate, 4), sub_minutes: round(leagueSubMin, 1) },
    role_minutes: roleMinutes,
    players: out,
  };
}

// ─── Projection ──────────────────────────────────────────────────────────────

// Minutes scenarios. `override`:
//   { minutes: 73 }                  exact minutes (backtests)
//   { started: true }                confirmed in the XI (lineup re-run)
//   { started: false, bench: true }  confirmed on the bench
//   { started: false, bench: false } not in the squad → cannot play
// Without an override, FPL availability scales the start/sub chances:
// injured/suspended/unavailable → 0; doubtful → chance_next%.
export function minutesScenarios(player, override = null) {
  const m = player.minutes;
  const full = { kind: "full", m: 90 };
  const early = { kind: "early", m: m.m_early };
  const sub = { kind: "sub", m: m.m_sub };
  if (override?.minutes != null) return [{ kind: "exact", m: override.minutes, p: override.minutes > 0 ? 1 : 0 }];
  if (override?.started === true) {
    return [{ ...full, p: m.q_full }, { ...early, p: 1 - m.q_full }];
  }
  if (override?.started === false) {
    if (!override.bench) return [{ kind: "dnp", m: 0, p: 1 }];
    const pSubGivenBench = Math.min(1, m.p_sub / Math.max(1e-9, 1 - m.p_start));
    return [{ ...sub, p: pSubGivenBench }, { kind: "dnp", m: 0, p: 1 - pSubGivenBench }];
  }
  let scale = 1;
  const st = player.status;
  if (st?.fpl && ["i", "s", "u", "n"].includes(st.fpl)) scale = st.chance_next != null ? st.chance_next / 100 : 0;
  else if (st?.fpl === "d") scale = st.chance_next != null ? st.chance_next / 100 : 0.5;
  const pS = m.p_start * scale;
  const pB = m.p_sub * scale;
  return [
    { ...full, p: pS * m.q_full },
    { ...early, p: pS * (1 - m.q_full) },
    { ...sub, p: pB },
    { kind: "dnp", m: 0, p: Math.max(0, 1 - pS - pB) },
  ];
}

function marketAdjust(stat, base, ctx, modelXgFor, modelXgAgainst) {
  if (!ctx) return base;
  const e = MARKET_ELASTICITY[stat] ?? {};
  let f = 1;
  if (e.for && ctx.xg_for > 0 && modelXgFor > 0) f *= (ctx.xg_for / modelXgFor) ** e.for;
  if (e.against && ctx.xg_against > 0 && modelXgAgainst > 0) f *= (ctx.xg_against / modelXgAgainst) ** e.against;
  if (e.ratio && ctx.xg_for > 0 && ctx.xg_against > 0 && modelXgFor > 0 && modelXgAgainst > 0) {
    f *= ((ctx.xg_for / ctx.xg_against) / (modelXgFor / modelXgAgainst)) ** e.ratio;
  }
  return base * f;
}

/**
 * Project a player for one fixture.
 * @param {Object} model   fitModel() artifact
 * @param {Object} args
 * @param {string} args.playerId
 * @param {string} args.opponentTeamId
 * @param {"home"|"away"} args.venue
 * @param {Object} [args.minutes]      minutesScenarios override
 * @param {Object} [args.teamContext]  { xg_for, xg_against } from the market
 * @returns {Object|null} per-90 means, team totals, scenarios, dispersion
 */
export function projectPlayer(model, { playerId, opponentTeamId, venue, minutes = null, teamContext = null }) {
  const p = model.players?.[playerId];
  if (!p) return null;
  const home = venue === "home";
  const team = p.team_id;
  const opp = opponentTeamId;
  const tf = model.team_factors;
  const xgFor = teamTotal(tf.xg, team, opp, home);
  const xgAgainst = teamTotal(tf.xg, opp, team, !home);

  const teamTotals = {};
  const per90 = {};
  for (const s of SHARE_STATS) {
    const T = marketAdjust(s, teamTotal(tf[s], team, opp, home), teamContext, xgFor, xgAgainst);
    teamTotals[s] = T;
    per90[s] = (p.shares[s] ?? 0) * T;
  }
  const sotAgainst = marketAdjust("sot_against", teamTotal(tf.sot, opp, team, !home), teamContext, xgFor, xgAgainst);
  teamTotals.sot_against = sotAgainst;

  const props = {};
  for (const [stat, cfg] of Object.entries(PROP_STATS)) {
    if (cfg.gk) {
      if (!p.gk) continue;
      const sr = p.save_rate ?? model.league.save_rate;
      props[stat] = {
        per90: stat === "saves" ? sotAgainst * sr : sotAgainst * (1 - sr),
        r: stat === "saves" ? (model.dispersion.saves ?? Infinity) : Infinity,
      };
      continue;
    }
    if (p.gk) continue; // keepers only get keeper props
    props[stat] = {
      per90: per90[cfg.base],
      r: cfg.poisson ? Infinity : (model.dispersion[cfg.base] ?? Infinity),
    };
  }

  return {
    player_id: playerId,
    name: p.name,
    team_id: team,
    opponent_id: opp,
    venue,
    role: p.role,
    prior_only: !!p.prior_only,
    apps: p.apps,
    scenarios: minutesScenarios(p, minutes),
    team_totals: Object.fromEntries(Object.entries(teamTotals).map(([k, v]) => [k, round(v, 3)])),
    model_xg: { for: round(xgFor, 3), against: round(xgAgainst, 3) },
    props,
    cards: p.cards,
  };
}

/**
 * Price one line. Conditioned on the player playing (a DNP voids the pick)
 * unless conditionOnPlaying is false.
 */
export function priceLine(projection, stat, line, { conditionOnPlaying = true } = {}) {
  const pr = projection?.props?.[stat];
  if (!pr) return null;
  const all = projection.scenarios;
  const pPlay = sum(all.filter((s) => s.m > 0).map((s) => s.p));
  const use = conditionOnPlaying ? all.filter((s) => s.m > 0) : all;
  const scen = use.map((s) => ({ p: s.p, mu: (pr.per90 * s.m) / 90, r: pr.r }));
  if (!scen.some((s) => s.p > 0)) return { stat, line, p_play: pPlay, p_over: null, p_under: null, p_push: null, mean: null };
  const lp = mixtureLineProbs(line, scen);
  return {
    stat, line,
    p_play: round(pPlay, 4),
    p_over: round(lp.over, 4),
    p_under: round(lp.under, 4),
    p_push: round(lp.push, 4),
    mean: round(mixtureMean(scen), 3),
  };
}

/**
 * Fantasy Score distribution by simulation (outfield only). Nesting keeps
 * the joint structure: goals ⊂ shots on target ⊂ shots, assists ⊂ key passes.
 */
export function simulateFantasy(projection, { sims = 20000, seed = null, weights = FANTASY_WEIGHTS } = {}) {
  if (!projection || projection.props.saves) return null; // keepers: formula not modelled
  const scen = projection.scenarios.filter((s) => s.m > 0 && s.p > 0);
  const total = sum(scen.map((s) => s.p));
  if (!(total > 0)) return null;
  const rng = mulberry32(seed ?? seedFrom(`${projection.player_id}|${projection.opponent_id}|${projection.venue}`));
  const P = projection.props;
  const cdf = [];
  let acc = 0;
  for (const s of scen) cdf.push((acc += s.p / total));
  const draws = new Float64Array(sims);
  for (let i = 0; i < sims; i++) {
    const u = rng();
    const s = scen[cdf.findIndex((c) => u <= c)] ?? scen[scen.length - 1];
    const f = s.m / 90;
    const mu = (k) => P[k].per90 * f;
    const shots = sampleCount(mu("shots"), P.shots.r, rng);
    const sot = sampleBinomial(shots, mu("shots") > 0 ? Math.min(1, mu("sot") / mu("shots")) : 0, rng);
    const goals = sampleBinomial(sot, mu("sot") > 0 ? Math.min(1, mu("goals") / mu("sot")) : 0, rng);
    const kp = sampleCount(mu("key_passes"), P.key_passes.r, rng);
    const assists = sampleBinomial(kp, mu("key_passes") > 0 ? Math.min(1, mu("assists") / mu("key_passes")) : 0, rng);
    const passes = sampleCount(mu("passes_att"), P.passes_att.r, rng);
    const clr = sampleCount(mu("clearances"), P.clearances.r, rng);
    const tkl = sampleCount(mu("tackles"), P.tackles.r, rng);
    const drb = sampleCount(mu("dribbles_att"), P.dribbles_att.r, rng);
    const crs = sampleCount(mu("crosses_att"), P.crosses_att.r, rng);
    const fls = sampleCount(mu("fouls"), P.fouls.r, rng);
    const yellow = rng() < 1 - Math.exp(-projection.cards.yellow_p90 * f) ? 1 : 0;
    const red = rng() < 1 - Math.exp(-projection.cards.red_p90 * f) ? 1 : 0;
    draws[i] =
      weights.goals * goals + weights.assists * assists + weights.shots * shots + weights.sot * sot +
      weights.passes_att * passes + weights.key_passes * kp + weights.clearances * clr + weights.tackles * tkl +
      weights.dribbles_att * drb + weights.crosses_att * crs + weights.yellow * yellow + weights.red * red +
      weights.fouls * fls;
  }
  return {
    mean: round(sum(draws) / sims, 3),
    probOver(line) {
      let over = 0, push = 0;
      for (const d of draws) {
        if (d > line + 1e-9) over++;
        else if (Math.abs(d - line) <= 1e-9) push++;
      }
      return { over: round(over / sims, 4), under: round((sims - over - push) / sims, 4), push: round(push / sims, 4) };
    },
  };
}
