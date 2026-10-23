// EPL matchup layers (feat/epl-matchup-layers, 2026-10-22). Three
// opponent-specific adjustments on top of model.js's two-way team totals.
// Each is switchable (projectPlayer `layers`) and must win the walk-forward
// backtest, then ~2 weeks of shadow logging, before it may affect a tier.
//
//   position  ρ[s][opp][role] — how the opponent's concession of stat s is
//             split across the attacker's ROLE, relative to what each
//             attacking team normally gives that role (leave-one-out team
//             profile, so a back-three side's own structure isn't charged to
//             the opponents it played). Zero-sum across roles: the overall
//             level stays in def_opp. Per-team EB shrink w = τ²/(τ² + φ/E).
//             Generic across stats: for tackles/clearances it is which of MY
//             roles end up defending against this opponent (a wing-heavy
//             opponent → my full-backs tackle more).
//   style     exp(γ_s · x) — pre-specified football interactions of named,
//             z-scored team styles: control clash (poss × opp poss), width
//             vs block (width × opp poss), press vs build-up (press × opp
//             directness), set pieces vs aerial weakness. Ridge quasi-Poisson
//             on team-match totals with the two-way total as the offset.
//   lineup    exp(β_s · x_u) — x_u = how far below its usual strength the
//             opponent's defending unit (CB / FB / MID) is in THIS match:
//             the team's mean "regular-ness" of that unit's starters minus
//             this XI's (regular-ness = season start share). Attacking stats
//             only, plus shots on target faced (keepers: their OWN unit).
//
// Pure: fitMatchup() runs inside fitModel(); the factor helpers run inside
// projectPlayer(). No imports from model.js (it imports this file).
//
// Backtest 2026-10-22 (scripts/backtest-epl-model.mjs, rounds 2–7, 20k
// player-stat predictions, log loss at the line; v1 model 0.5632, no-opp
// 0.5657): NONE of the layers beats v1 yet, so none is in shadow or live.
//   position 0.5661 (zone groups 0.5647, + family pooling 0.5659, half
//            shrink 0.5642 — approaches v1 only as it shrinks to nothing)
//   style    0.5636 (σ 0.03–0.15 all ≥ v1; keeper saves alone 0.700 → 0.685,
//            n = 120 — too few to act on)
//   lineup   0.5635 (σ 0.2 → 0.5632 = v1; fitted β signs mixed)
// Same picture from round 4 / 5 on. Seven rounds is too thin to split an
// opponent's concession by role; re-run monthly (`--pos-zone --pos-pool`,
// `--style-sigma`, `--lineup-sigma`) and promote a layer only on a win.

export const OUTFIELD_ROLES = ["CB", "FB", "CM", "AM", "W", "ST"];

// Defending units and which attacking roles they face.
export const DEF_UNITS = { CB: ["CB"], FB: ["FB"], MID: ["CM", "AM"] };
export const FACES_UNIT = { ST: ["CB"], AM: ["CB", "MID"], CM: ["MID"], W: ["FB"], FB: ["FB"] };

export const LINEUP_STATS = ["shots", "sot", "key_passes", "xg", "xa", "crosses_att", "dribbles_att", "fouled"];

export const ROLE_LABEL = { GK: "keepers", CB: "centre-backs", FB: "full-backs", CM: "central mids", AM: "attacking mids", W: "wingers", ST: "strikers" };
export const UNIT_LABEL = { CB: "centre-backs", FB: "full-backs", MID: "midfield" };

// Named team styles. num/den are summed over a team's matches (ratio of
// sums), then shrunk toward the league with STYLE_SHRINK matches of weight.
//   poss    possession share
//   direct  long balls / passes
//   width   crosses / passes
//   box     shots inside the box / shots (shot quality)
//   setp    set-play xG / xG
//   aerial  aerial duels won / contested (low = aerially weak)
//   press   (tackles + interceptions) / opponent passes (PPDA-like)
export const STYLE_DIMS = {
  poss: (o) => [o.possession, 100],
  direct: (o) => [o.long_balls_att, o.passes_att],
  width: (o) => [o.crosses_att, o.passes_att],
  box: (o) => [o.shots_in_box, o.shots],
  setp: (o) => [o.xg_set_play, o.xg],
  aerial: (o) => [o.aerials_won, o.aerials_att],
  press: (o, d) => [(o.tackles ?? 0) + (o.interceptions ?? 0), d.passes_att],
};
const STYLE_SHRINK = 3;

// Interactions per stat. "o." = the team whose total it is, "d." = its
// opponent. Main effects already live in att/def; these are the products.
const CLASH = ["o.poss", "d.poss"];
const WIDTH_V_BLOCK = ["o.width", "d.poss"];
const PRESS_V_BUILD = ["d.press", "o.direct"];
const SETP_V_AIR = ["o.setp", "d.aerial"];
export const STYLE_FEATURES = {
  passes_att: [CLASH, PRESS_V_BUILD],
  shots: [CLASH, WIDTH_V_BLOCK],
  sot: [CLASH, WIDTH_V_BLOCK],
  key_passes: [CLASH, WIDTH_V_BLOCK],
  crosses_att: [WIDTH_V_BLOCK, CLASH],
  dribbles_att: [CLASH, PRESS_V_BUILD],
  xg: [CLASH, SETP_V_AIR],
  xa: [CLASH, SETP_V_AIR],
  fouled: [PRESS_V_BUILD],
  // My defending, against this opponent's attacking:
  tackles: [CLASH, ["o.press", "d.direct"]],
  clearances: [["d.width", "o.poss"], ["d.setp", "o.aerial"]],
  fouls: [["o.press", "d.direct"], CLASH],
};
export const FEATURE_LABEL = {
  "o.poss*d.poss": "possession clash",
  "o.width*d.poss": "width vs block",
  "d.press*o.direct": "press vs build-up",
  "o.setp*d.aerial": "set pieces vs aerial",
  "o.press*d.direct": "press vs build-up",
  "d.width*o.poss": "crosses vs deep block",
  "d.setp*o.aerial": "set pieces vs aerial",
};

// Priors / tuning (backtest flags override): ridge σ on γ (per unit of a
// z × z product) and on β (per unit of x, which spans roughly ±0.5).
export const MATCHUP_DEFAULTS = { styleSigma: 0.08, lineupSigma: 0.5, xClip: 0.6, posScale: 1, posGroups: "role", posPool: false };

// Position-layer groupings (posGroups: "zone") and stat families (posPool).
const ZONE_OF = { CB: "CB", FB: "wide", W: "wide", CM: "central", AM: "central", ST: "central" };
const POS_FAMILIES = [
  ["shots", "sot", "xg"],
  ["key_passes", "xa"],
  ["crosses_att", "dribbles_att"],
];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? x : Number(x.toFixed(d)));
const variance = (xs) => {
  const m = mean(xs);
  return xs.length > 1 ? sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1) : 0;
};

// Ridge quasi-Poisson: y ~ μ0·exp(x·θ), θ ~ N(0, σ²). Newton on ≤3 params.
function ridgePoisson(obs, dim, sigma, iters = 25) {
  if (!obs.length || dim === 0) return { theta: new Array(dim).fill(0), phi: 1, n: obs.length };
  const pear = sum(obs.map((o) => (o.mu0 > 0 ? (o.y - o.mu0) ** 2 / o.mu0 : 0)));
  const phi = Math.max(1, pear / Math.max(1, obs.length - dim));
  const theta = new Array(dim).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = theta.map((t) => -t / (sigma * sigma));
    const H = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => (i === j ? -1 / (sigma * sigma) : 0)));
    for (const o of obs) {
      const eta = sum(o.x.map((x, i) => x * theta[i]));
      const mu = o.mu0 * Math.exp(eta);
      for (let i = 0; i < dim; i++) {
        g[i] += (o.x[i] * (o.y - mu)) / phi;
        for (let j = 0; j < dim; j++) H[i][j] -= (o.x[i] * o.x[j] * mu) / phi;
      }
    }
    const step = solve(H, g);
    if (!step) break;
    let max = 0;
    for (let i = 0; i < dim; i++) {
      theta[i] -= step[i];
      max = Math.max(max, Math.abs(step[i]));
    }
    if (max < 1e-8) break;
  }
  // Posterior SD from the curvature (for diagnostics).
  return { theta, phi, n: obs.length };
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// ─── Style ───────────────────────────────────────────────────────────────────

export function teamStyles(matches) {
  const acc = {}; // team → dim → { num, den, n }
  const league = {};
  for (const m of matches) {
    const ts = m.team_stats;
    if (!ts?.home || !ts?.away) continue;
    for (const [side, other] of [["home", "away"], ["away", "home"]]) {
      const t = m[side].team_id;
      for (const [dim, f] of Object.entries(STYLE_DIMS)) {
        const [num, den] = f(ts[side], ts[other]);
        if (!(den > 0) || num == null) continue;
        const a = ((acc[t] ??= {})[dim] ??= { num: 0, den: 0, n: 0 });
        a.num += num;
        a.den += den;
        a.n++;
        const l = (league[dim] ??= { num: 0, den: 0, n: 0 });
        l.num += num;
        l.den += den;
        l.n++;
      }
    }
  }
  const raw = {};
  for (const [t, dims] of Object.entries(acc)) {
    raw[t] = {};
    for (const [dim, a] of Object.entries(dims)) {
      const l = league[dim];
      const L = l.num / l.den;
      const kDen = STYLE_SHRINK * (l.den / l.n); // k matches' worth of denominator
      raw[t][dim] = (a.num + kDen * L) / (a.den + kDen);
    }
  }
  const z = {};
  for (const dim of Object.keys(STYLE_DIMS)) {
    const vals = Object.values(raw).map((r) => r[dim]).filter((v) => v != null);
    const m = mean(vals) ?? 0;
    const sd = Math.sqrt(variance(vals)) || 1;
    for (const t of Object.keys(raw)) (z[t] ??= {})[dim] = raw[t][dim] == null ? 0 : round((raw[t][dim] - m) / sd, 3);
  }
  const rawR = Object.fromEntries(Object.entries(raw).map(([t, r]) => [t, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v, 4)]))]));
  return { z, raw: rawR };
}

function featureValues(z, stat, own, opp) {
  const feats = STYLE_FEATURES[stat] ?? [];
  const zv = (key) => {
    const [who, dim] = key.split(".");
    return z?.[who === "o" ? own : opp]?.[dim] ?? 0;
  };
  return feats.map(([a, b]) => zv(a) * zv(b));
}

/** exp(γ·x) for `stat` produced by team `own` against `opp`, with parts. */
export function styleFactor(mx, stat, own, opp) {
  const st = mx?.style;
  const gamma = st?.gamma?.[stat];
  if (!gamma) return { f: 1, parts: [] };
  const x = featureValues(st.z, stat, own, opp);
  const parts = (STYLE_FEATURES[stat] ?? []).map(([a, b], i) => ({ key: `${a}*${b}`, f: Math.exp(gamma[i] * x[i]) }));
  return { f: Math.exp(sum(x.map((v, i) => v * gamma[i]))), parts };
}

// ─── Position (role tilt) ────────────────────────────────────────────────────

export function roleFactor(mx, stat, opp, role) {
  return mx?.role_tilt?.[stat]?.[opp]?.[role] ?? 1;
}

// ─── Lineup ──────────────────────────────────────────────────────────────────

// x per defending unit for team `team` fielding `starters` (model player
// ids): team's usual regular-ness minus this XI's. null = unknown.
export function lineupX(mx, team, starters, players) {
  const lu = mx?.lineup;
  if (!lu || !starters) return null;
  const ids = [...starters].filter((id) => players[id]?.team_id === team);
  if (ids.length < 8) return null; // not a usable XI for this team
  const out = {};
  for (const [u, roles] of Object.entries(DEF_UNITS)) {
    const inUnit = ids.filter((id) => roles.includes(players[id].role));
    const ref = lu.team_ref?.[team]?.[u];
    if (!inUnit.length || ref == null) {
      out[u] = 0;
      continue;
    }
    const reg = mean(inUnit.map((id) => lu.start_share[id] ?? 0));
    out[u] = Math.max(-lu.x_clip, Math.min(lu.x_clip, ref - reg));
  }
  return out;
}

export function unitXForRole(x, role) {
  if (!x) return 0;
  const units = FACES_UNIT[role];
  if (!units) return 0;
  return mean(units.map((u) => x[u] ?? 0)) ?? 0;
}

export function lineupFactor(mx, stat, x) {
  const b = mx?.lineup?.beta?.[stat];
  if (!b || !x) return 1;
  return Math.exp(b * x);
}

// ─── Fit ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} a
 * @param {Array}  a.matches       training matches (with team_stats)
 * @param {Array}  a.teamMatches   model.js buildTeamMatches() records
 * @param {Map}    a.rowsByTM      `${match}|${team}` → player rows
 * @param {Object} a.players       model artifact players (role, team_id, shares, starts)
 * @param {Object} a.team_factors
 * @param {Function} a.teamTotal
 * @param {string[]} a.stats       share stats
 */
export function fitMatchup({ matches, teamMatches, rowsByTM, players, team_factors, teamTotal, stats, opts = {} }) {
  const o = { ...MATCHUP_DEFAULTS, ...opts };
  const roleOf = (pid) => players[pid]?.role ?? null;

  // Position layer. Groups: "role" (the 6 outfield roles) or "zone" (centre-
  // backs / wide = FB+W / central = CM+AM+ST). posPool pools a stat family's
  // evidence (POS_FAMILIES) into one tilt per opponent × group.
  const groupOf = (role) => (o.posGroups === "zone" ? ZONE_OF[role] : role);
  const groups = [...new Set(OUTFIELD_ROLES.map(groupOf))];
  const per = {}; // stat → { agg: D → g → {Y,E}, pear: g → {s,n}, f: g → share }
  for (const s of stats) {
    const cells = [];
    const teamY = {};
    const teamTot = {};
    for (const rec of teamMatches) {
      const y = {};
      for (const r of rowsByTM.get(`${rec.match_id}|${rec.team}`) ?? []) {
        if (!(r.minutes > 0)) continue;
        const role = roleOf(r.player_id);
        if (!role || role === "GK") continue;
        const g = groupOf(role);
        y[g] = (y[g] || 0) + (r[s] ?? 0);
      }
      const tot = rec.tot[s] ?? 0;
      cells.push({ T: rec.team, D: rec.opp, y, tot });
      teamTot[rec.team] = (teamTot[rec.team] || 0) + tot;
      const ty = (teamY[rec.team] ??= {});
      for (const [k, v] of Object.entries(y)) ty[k] = (ty[k] || 0) + v;
    }
    const totAll = sum(Object.values(teamTot));
    if (!(totAll > 0)) continue;
    const f = {};
    for (const g of groups) f[g] = sum(Object.values(teamY).map((ty) => ty[g] || 0)) / totAll;
    const agg = {};
    const pear = {};
    for (const c of cells) {
      for (const g of groups) {
        const restTot = teamTot[c.T] - c.tot;
        const restY = (teamY[c.T]?.[g] || 0) - (c.y[g] || 0);
        const pi = restTot > 0 ? restY / restTot : f[g];
        const e = pi * c.tot;
        if (!(e > 0)) continue;
        const yy = c.y[g] || 0;
        const a = ((agg[c.D] ??= {})[g] ??= { Y: 0, E: 0 });
        a.Y += yy;
        a.E += e;
        const pr = (pear[g] ??= { s: 0, n: 0 });
        pr.s += (yy - e) ** 2 / e;
        pr.n++;
      }
    }
    per[s] = { agg, pear, f };
  }
  const role_tilt = {};
  const tilt_diag = {};
  for (const s of stats) {
    if (!per[s]) continue;
    const fam = o.posPool ? (POS_FAMILIES.find((x) => x.includes(s))?.filter((x) => per[x]) ?? [s]) : [s];
    const gt = {}; // D → g → tilt
    tilt_diag[s] = {};
    for (const g of groups) {
      const Ds = new Set(fam.flatMap((x) => Object.keys(per[x].agg)));
      const AD = {};
      for (const D of Ds) {
        let Y = 0, E = 0;
        for (const x of fam) {
          const a = per[x].agg[D]?.[g];
          if (a) { Y += a.Y; E += a.E; }
        }
        if (E > 0) AD[D] = { Y, E };
      }
      const ps = sum(fam.map((x) => per[x].pear[g]?.s ?? 0));
      const pn = sum(fam.map((x) => per[x].pear[g]?.n ?? 0));
      const phi = pn ? Math.max(1, ps / pn) : 1;
      const teams = Object.keys(AD);
      if (teams.length < 6) continue;
      const R = teams.map((D) => AD[D].Y / AD[D].E);
      const v = teams.map((D) => phi / AD[D].E);
      const tau2 = Math.max(variance(R) - mean(v), 1e-4);
      teams.forEach((D, i) => {
        const w = o.posScale * (tau2 / (tau2 + v[i]));
        (gt[D] ??= {})[g] = 1 + w * (R[i] - 1);
      });
      tilt_diag[s][g] = { tau: round(Math.sqrt(tau2), 3), phi: round(phi, 2), share: round(per[s].f[g], 3) };
    }
    // Zero-sum across groups (league weights of THIS stat), then per role.
    const f = per[s].f;
    const fSum = sum(groups.map((g) => f[g]));
    role_tilt[s] = {};
    for (const [D, t] of Object.entries(gt)) {
      const c = sum(groups.map((g) => f[g] * (t[g] ?? 1))) / (fSum || 1);
      role_tilt[s][D] = Object.fromEntries(OUTFIELD_ROLES.map((r) => [r, round((t[groupOf(r)] ?? 1) / c, 4)]));
    }
  }

  // Style layer (offset = two-way total).
  const styles = teamStyles(matches);
  const gamma = {};
  const style_diag = {};
  for (const s of stats) {
    const feats = STYLE_FEATURES[s];
    if (!feats?.length) continue;
    const obs = teamMatches
      .map((rec) => ({ y: rec.tot[s] ?? 0, mu0: teamTotal(team_factors[s], rec.team, rec.opp, rec.home), x: featureValues(styles.z, s, rec.team, rec.opp) }))
      .filter((x) => x.mu0 > 0);
    const fit = ridgePoisson(obs, feats.length, o.styleSigma);
    gamma[s] = fit.theta.map((t) => round(t, 4));
    style_diag[s] = { phi: round(fit.phi, 2), n: fit.n };
  }
  const style = { z: styles.z, raw: styles.raw, gamma, sigma: o.styleSigma, diag: style_diag };
  const styleF = (s, own, opp) => {
    const g = gamma[s];
    if (!g) return 1;
    const x = featureValues(styles.z, s, own, opp);
    return Math.exp(sum(x.map((v, i) => v * g[i])));
  };

  // Lineup layer.
  const teamN = {};
  for (const rec of teamMatches) teamN[rec.team] = (teamN[rec.team] || 0) + 1;
  const startsBy = {}; // pid → starts for its CURRENT team
  for (const rec of teamMatches) {
    for (const r of rowsByTM.get(`${rec.match_id}|${rec.team}`) ?? []) {
      if (r.started && players[r.player_id]?.team_id === rec.team) startsBy[r.player_id] = (startsBy[r.player_id] || 0) + 1;
    }
  }
  const start_share = {};
  for (const [pid, p] of Object.entries(players)) {
    if (p.prior_only) continue;
    const n = teamN[p.team_id];
    if (n > 0) start_share[pid] = round((startsBy[pid] || 0) / n, 3);
  }
  const regByTM = new Map(); // `${match}|${team}` → unit → reg
  const refAcc = {};
  for (const rec of teamMatches) {
    const st = (rowsByTM.get(`${rec.match_id}|${rec.team}`) ?? []).filter((r) => r.started && players[r.player_id]);
    const reg = {};
    for (const [u, roles] of Object.entries(DEF_UNITS)) {
      const inUnit = st.filter((r) => roles.includes(players[r.player_id].role));
      if (!inUnit.length) continue;
      reg[u] = mean(inUnit.map((r) => start_share[r.player_id] ?? 0));
      const a = ((refAcc[rec.team] ??= {})[u] ??= []);
      a.push(reg[u]);
    }
    regByTM.set(`${rec.match_id}|${rec.team}`, reg);
  }
  const team_ref = {};
  for (const [t, units] of Object.entries(refAcc)) {
    team_ref[t] = {};
    for (const [u, vals] of Object.entries(units)) team_ref[t][u] = round(mean(vals), 4);
  }
  const xOf = (team, matchId) => {
    const reg = regByTM.get(`${matchId}|${team}`);
    if (!reg) return null;
    const x = {};
    for (const u of Object.keys(DEF_UNITS)) {
      const ref = team_ref[team]?.[u];
      x[u] = reg[u] == null || ref == null ? 0 : Math.max(-o.xClip, Math.min(o.xClip, ref - reg[u]));
    }
    return x;
  };
  const beta = {};
  const lineup_diag = {};
  for (const s of LINEUP_STATS) {
    if (!stats.includes(s)) continue;
    const obs = [];
    for (const rec of teamMatches) {
      const x = xOf(rec.opp, rec.match_id);
      if (!x) continue;
      const T = teamTotal(team_factors[s], rec.team, rec.opp, rec.home) * styleF(s, rec.team, rec.opp);
      for (const r of rowsByTM.get(`${rec.match_id}|${rec.team}`) ?? []) {
        const p = players[r.player_id];
        if (!(r.minutes > 0) || !p || p.gk) continue;
        const xr = unitXForRole(x, p.role);
        const mu0 = (p.shares?.[s] ?? 0) * T * (role_tilt[s]?.[rec.opp]?.[p.role] ?? 1) * (r.minutes / 90);
        if (mu0 > 0) obs.push({ y: r[s] ?? 0, mu0, x: [xr] });
      }
    }
    const fit = ridgePoisson(obs, 1, o.lineupSigma);
    beta[s] = round(fit.theta[0], 4);
    lineup_diag[s] = { phi: round(fit.phi, 2), n: fit.n };
  }
  // Keepers: shots on target faced vs the keeper's OWN defending units.
  {
    const obs = [];
    for (const rec of teamMatches) {
      const x = xOf(rec.team, rec.match_id);
      if (!x || !rec.oppRec) continue;
      const mu0 = teamTotal(team_factors.sot, rec.opp, rec.team, !rec.home) * styleF("sot", rec.opp, rec.team);
      if (mu0 > 0) obs.push({ y: rec.oppRec.tot.sot ?? 0, mu0, x: [mean(Object.values(x))] });
    }
    const fit = ridgePoisson(obs, 1, o.lineupSigma);
    beta.sot_against = round(fit.theta[0], 4);
    lineup_diag.sot_against = { phi: round(fit.phi, 2), n: fit.n };
  }
  const lineup = { start_share, team_ref, beta, x_clip: o.xClip, sigma: o.lineupSigma, diag: lineup_diag };

  return { version: 1, role_tilt, tilt_diag, style, lineup };
}
