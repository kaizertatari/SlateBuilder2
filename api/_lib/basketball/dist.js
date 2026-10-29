// Basketball probability pipeline, step 1: the predictive distribution of a
// player's stat in his next game. Pure. Replaces the engine's
// Normal(mean, one fixed σ per stat) — which gives a 2-rebound guard and a
// 12-rebound center the same σ (3.81) and uses a placeholder σ = 8 for
// Blocks+Steals / 3PA / FGA / Fantasy — with a count distribution whose
// spread scales with the player's own mean and minutes.
//
//   minutes   recency-weighted mean of his last MIN_WINDOW games played
//             (weights MIN_DECAY^k), plus the empirical spread of those
//             minutes for the mixture
//   mean      opponent.js projection at those minutes (rate × min × pace ×
//             defense), or any caller-supplied per-minute rate
//   shape     negative binomial with a per-stat dispersion r (var = μ + μ²/r)
//             fitted on last season's residuals; optionally mixed over his
//             recent minutes (bench/foul-trouble volatility)
//
// Combos and Fantasy Score are priced as one NB on the summed mean with
// their own fitted dispersion (simple, and the backtest is the judge).

import { lineProbs, mixtureLineProbs } from "../distributions.js";
import { statOf } from "./gamelogs.js";
import { projectOpp, fitOpponentModel, PROP_WEIGHTS } from "./opponent.js";

export const MIN_WINDOW = 10;
export const MIN_DECAY = 0.85;

// PrizePicks basketball prop → internal key used for dispersion + value.
export const PROP_KEY = {
  "Points": "pts", "Rebounds": "reb", "Assists": "ast", "PRA": "pra", "PR": "pr", "PA": "pa", "RA": "ra",
  "3-Pointers Made": "fg3m", "3-Pointers Attempted": "fg3a", "FG Attempted": "fga",
  "Blocks+Steals": "bs", "Fantasy Score": "fs",
};
const KEY_PROP = Object.fromEntries(Object.entries(PROP_KEY).map(([p, k]) => [k, p]));
export const DIST_KEYS = Object.values(PROP_KEY);

/** Actual value of a prop key from a game-log row. */
export function valueOf(row, key) {
  const w = PROP_WEIGHTS[KEY_PROP[key]];
  return w ? Object.entries(w).reduce((a, [s, k]) => a + k * statOf(row, s), 0) : 0;
}

/**
 * Minutes profile from a player's prior games (newest last).
 * @returns {{ mean:number, samples:number[], n:number }|null}
 */
export function minutesProfile(priorMinutes, { window = MIN_WINDOW, decay = MIN_DECAY } = {}) {
  const recent = priorMinutes.filter((m) => m > 0).slice(-window);
  if (!recent.length) return null;
  let sw = 0, s = 0;
  recent.forEach((m, i) => { const w = decay ** (recent.length - 1 - i); sw += w; s += w * m; });
  return { mean: s / sw, samples: recent, n: recent.length };
}

/** Expected value of a prop key at given minutes from the opponent model. */
export function meanAt(model, ctx, key, minutes, layers = "team") {
  const p = projectOpp(model, { ...ctx, minutes }, layers);
  if (!p) return null;
  const w = PROP_WEIGHTS[KEY_PROP[key]];
  return Object.entries(w).reduce((a, [s, k]) => a + k * (p[s] ?? 0), 0);
}

/**
 * P(over line) under the chosen shape.
 *   shape "nb"     NB(μ at mean minutes, r)
 *   shape "nbmix"  equal-weight mixture over the recent minutes samples,
 *                  each NB(μ at that minute count, r)
 */
export function probOver({ model, ctx, key, line, minutes, r, shape = "nbmix", layers = "team" }) {
  if (!minutes || !(r > 0)) return null;
  if (shape === "nb") {
    const mu = meanAt(model, ctx, key, minutes.mean, layers);
    return mu == null ? null : lineProbs(line, Math.max(1e-3, mu), r).over;
  }
  // Rescale the samples so their mean matches the recency-weighted mean.
  const sMean = minutes.samples.reduce((a, b) => a + b, 0) / minutes.samples.length;
  const scale = sMean > 0 ? minutes.mean / sMean : 1;
  const scen = [];
  for (const m of minutes.samples) {
    const mu = meanAt(model, ctx, key, m * scale, layers);
    if (mu == null) return null;
    scen.push({ p: 1 / minutes.samples.length, mu: Math.max(1e-3, mu), r });
  }
  return mixtureLineProbs(line, scen).over;
}

/**
 * Method-of-moments NB dispersion per key from (μ, y) pairs:
 * r = Σμ² / Σ((y − μ)² − μ). Large r → Poisson-like.
 */
export function fitDispersion(pairs) {
  let num = 0, den = 0;
  for (const { mu, y } of pairs) { num += mu * mu; den += (y - mu) ** 2 - mu; }
  return den > 0 ? Math.max(0.5, num / den) : 1e6;
}

// ── Fitting (shared by scripts/backtest-basketball-dist.mjs and the daily
// artifact build) ────────────────────────────────────────────────────────

export const MIN_PRIOR_GAMES = 5;
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

/**
 * Walk a season: yield every eligible player-game (played, ≥ MIN_PRIOR_GAMES
 * earlier games this season) with the inputs a live prediction would have —
 * opponent model refit every `step` days on games before the window, the
 * player's earlier games and his minutes profile. History updates only after
 * a whole window is predicted (no same-window leakage).
 */
export function* walkSeason(snap, { priorModel = null, step = 7, fit = fitOpponentModel } = {}) {
  const tg = new Map(snap.team_games.map((t) => [`${t.game_id}|${t.team}`, t]));
  const rows = snap.rows.filter((r) => tg.has(`${r.game_id}|${r.team}`)).map((r) => ({ r, t: tg.get(`${r.game_id}|${r.team}`) }))
    .sort((a, b) => a.t.date.localeCompare(b.t.date));
  const hist = new Map();
  const dates = [...new Set(rows.map((x) => x.t.date))];
  let i = 0;
  for (let d0 = dates[0]; d0 <= dates.at(-1); d0 = addDays(d0, step)) {
    const d1 = addDays(d0, step);
    const model = fit(snap, { before: d0, prior: priorModel });
    const batch = [];
    while (i < rows.length && rows[i].t.date < d1) batch.push(rows[i++]);
    for (const { r, t } of batch) {
      const h = hist.get(r.player_id) ?? [];
      if (statOf(r, "min") > 0 && h.length >= MIN_PRIOR_GAMES) {
        yield { r, t, model, h, minutes: minutesProfile(h.map((g) => g.min)), ctx: { playerId: r.player_id, team: t.team, opponent: t.opponent } };
      }
    }
    for (const { r } of batch) if (statOf(r, "min") > 0) { const h = hist.get(r.player_id) ?? []; h.push({ min: r.min, row: r }); hist.set(r.player_id, h); }
  }
}

/** Engine-style recency mean: ½ last-5 average + ½ season-to-date average. */
export function engineMean(history, key) {
  const vals = history.map((g) => valueOf(g.row, key));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return 0.5 * avg(vals.slice(-5)) + 0.5 * avg(vals);
}

/** Opponent + pace multiplier for a prop key (ratio, so minutes cancel). */
export function matchupRatio(model, ctx, key, minutes) {
  const b = meanAt(model, ctx, key, minutes, "base"), t = meanAt(model, ctx, key, minutes, "team");
  return b > 0 && t != null ? t / b : 1;
}

/**
 * Fit the calibrated distribution on a finished season (walk-forward):
 *   r_eng  NB dispersion around the engine-style mean alone
 *   c      per-key mean multiplier Σy / Σ(engine mean × matchup)
 *   r      NB dispersion around the calibrated mean (engine × matchup × c)
 * Backtest 2026-10-19 (fit on the prior season, scored on the next):
 * synthetic-line log loss NBA main 0.6902 → 0.6852, WNBA 0.6900 → 0.6828;
 * real graded WNBA lines (engine's logged mean) 0.8236 → 0.7510.
 */
export function fitDistParams(snap, { priorModel = null, step = 7, fit = fitOpponentModel } = {}) {
  const eng = {}, cal = {};
  for (const x of walkSeason(snap, { priorModel, step, fit })) {
    for (const key of DIST_KEYS) {
      const y = valueOf(x.r, key), em = Math.max(1e-3, engineMean(x.h, key));
      (eng[key] ??= []).push({ mu: em, y });
      (cal[key] ??= []).push({ mu: Math.max(1e-3, em * matchupRatio(x.model, x.ctx, key, x.minutes.mean)), y });
    }
  }
  const out = { r_eng: {}, c: {}, r: {}, n: {} };
  for (const key of DIST_KEYS) {
    const p = cal[key] ?? [];
    out.r_eng[key] = +fitDispersion(eng[key] ?? []).toFixed(3);
    out.c[key] = +(p.reduce((a, x) => a + x.y, 0) / Math.max(1e-9, p.reduce((a, x) => a + x.mu, 0))).toFixed(4);
    out.r[key] = +fitDispersion(p.map((x) => ({ mu: x.mu * out.c[key], y: x.y }))).toFixed(3);
    out.n[key] = p.length;
  }
  return out;
}

/**
 * Early-season shrink (SHADOW, 2026-10-28). The calibrated mean leans on the
 * player's few games this season; shrink it toward the opponent model's
 * prior-carrying mean (per-minute rate that keeps last season × projected
 * minutes × pace × team): μ = w·calibrated + (1−w)·opponent-model, w = n/(n+k),
 * n = player's games this season.
 * NBA evidence: walk-forward 2025-26 incl. games 1–4 (scripts that skip <5
 * prior games never tested this) — calibrated mean worse than a coin flip
 * through game 4 (log loss 1.71 / 1.12 / 0.79 / 0.74), shrunk ≈0.69 / 0.66 /
 * 0.64 / 0.64, small gain all season. On REAL graded NBA PrizePicks lines
 * (6,589 lines, games 1–4, 6 days; history cut at the ET game date): model
 * alone 0.980 → 0.689, and the shrunk pipeline is well calibrated (Platt
 * slope 1.09 vs 0.28 as logged) — but blended 50/50 it only TIES the market
 * alone (0.643 vs 0.636, CI spans 0) and its would-be picks hit 52.9% vs
 * 57.7% break-even. (An earlier "beats the market" read sliced the UTC date,
 * which leaked late games into their own history.) See eval-opp-factor §5–6.
 */
export const EARLY_SEASON_K = 8;

export function shrinkMean({ mean, oppMean, n, k = EARLY_SEASON_K }) {
  if (typeof mean !== "number" || typeof oppMean !== "number" || !(n >= 0)) return null;
  const w = n / (n + k);
  return { mean: Math.max(1e-3, w * mean + (1 - w) * oppMean), w };
}

// ── Known-lineup minutes (SHADOW, 2026-10-28) ─────────────────────────────
// Who plays moves minutes: a regular sitting frees ~30 minutes for the rest.
// Backtest (NBA 2025-26 walk-forward, the players who actually played
// rescaled to the team's 240): minutes MAE 4.86 → 4.63 at 20+ games and lower
// in every slice; prop log score best in every slice; on 6,401 real graded
// NBA lines the 50/50 pipeline moved from a tie with the market to just
// under it (0.6345 vs 0.6367, CI spans 0). That used the ACTUAL lineup — an
// upper bound. Live, the lineup = the recent rotation minus teammates the
// injury report lists Out/Doubtful, so it is logged to be measured first.
//
// Damped variant (2026-10-29, logged side by side as lineup_damped_*): only
// β of an out player's minutes reach the rotation (the rest go to the deep
// bench), α of that shared within his position group (G/W/B). NBA 2025-26
// walk-forward with an injury-report proxy (regulars who sat): β 0.4–0.5
// best in every slice (20+ games log score 2.5240 → 2.5084, minutes MAE
// 5.378 → 4.890); α 0.5 adds ~0.001, α 1 hurts. Real 2026-27 lines (6 early
// days) lean undamped, within noise — eval-opp-factor §7 decides.

export const ROTATION_RECENT_GAMES = 5;   // in the rotation = played one of the team's last 5 games
export const LINEUP_SCALE = { min: 0.75, max: 1.35 };
export const LINEUP_MAX_MINUTES = 44;
export const LINEUP_TEAM_MINUTES = 240;
export const LINEUP_DAMPED = { alpha: 0.5, beta: 0.5 };

/** Name key for matching ESPN injury names to game-log names. */
export function normName(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[.'’-]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Current rotation per team from a season snapshot: every player whose latest
 * game (with minutes) is among his team's last ROTATION_RECENT_GAMES games,
 * with his recency-weighted minutes (minutesProfile) and games played.
 * @returns {Object<string, Array<{id:string,name:string,m0:number,n:number,last:string}>>}
 */
export function buildRotation(snap, { recentGames = ROTATION_RECENT_GAMES } = {}) {
  const tg = new Map((snap?.team_games ?? []).map((t) => [`${t.game_id}|${t.team}`, t]));
  const teamDates = new Map(), byPlayer = new Map();
  for (const r of snap?.rows ?? []) {
    const t = tg.get(`${r.game_id}|${r.team}`);
    if (!t) continue;
    if (!teamDates.has(t.team)) teamDates.set(t.team, new Set());
    teamDates.get(t.team).add(t.date);
    if (!(r.min > 0)) continue;
    const id = String(r.player_id);
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push({ date: t.date, team: t.team, min: r.min });
  }
  const recent = new Map([...teamDates].map(([team, ds]) => [team, new Set([...ds].sort().slice(-recentGames))]));
  const out = {};
  for (const [id, games] of byPlayer) {
    games.sort((a, b) => a.date.localeCompare(b.date));
    const last = games.at(-1);
    if (!recent.get(last.team)?.has(last.date)) continue;
    const prof = minutesProfile(games.map((g) => g.min));
    if (!prof) continue;
    // p = share of the team's recent games he actually played (a deep-bench
    // or often-resting player counts for part of his minutes).
    const rs = recent.get(last.team);
    const p = games.filter((g) => g.team === last.team && rs.has(g.date)).length / rs.size;
    (out[last.team] ??= []).push({ id, name: snap.players?.[id]?.name ?? null, group: snap.players?.[id]?.group ?? null, m0: +prof.mean.toFixed(2), n: games.length, last: last.date, p: +p.toFixed(3) });
  }
  return out;
}

/**
 * Lineup-adjusted minutes for one player: drop rotation teammates listed
 * Out/Doubtful, rescale the rest so the team sums to 240 (clamped), cap.
 * alpha/beta (default 0/1 = plain proportional rescale): the player gets his
 * usual minutes scaled to the full rotation's 240, plus β of each out
 * teammate's (equally scaled) minutes — α of it shared within the out
 * player's position group, 1−α across everyone available, by usual minutes.
 * @param {{ rotation: Array, playerId: string|number, injuries?: Array<{player:string,status:string}>, alpha?: number, beta?: number }} a
 * @returns {null | { m0:number, minutes:number, scale:number, out:string[] }}
 */
export function lineupMinutes({ rotation, playerId, injuries = [], alpha = 0, beta = 1 }) {
  if (!Array.isArray(rotation) || !rotation.length) return null;
  const isMe = (p) => String(p.id) === String(playerId);
  const me = rotation.find(isMe);
  if (!me) return null;
  const outKeys = new Set((injuries ?? []).filter((i) => /^(out|doubtful)/i.test(String(i.status ?? ""))).map((i) => normName(i.player)));
  const out = rotation.filter((p) => !isMe(p) && outKeys.has(normName(p.name)));
  // Expected team minutes: teammates weighted by how often they've played
  // (p, default 1); the player being priced counts fully (PrizePicks voids a
  // line when he doesn't play, so prices are conditional on him playing).
  const w = (p) => p.m0 * (isMe(p) ? 1 : (p.p ?? 1));
  const avail = rotation.filter((p) => !out.includes(p));
  const tot = avail.reduce((a, p) => a + w(p), 0);
  let raw;
  if (alpha === 0 && beta === 1) raw = tot > 0 ? LINEUP_TEAM_MINUTES / tot : 1;
  else {
    const totAll = tot + out.reduce((a, p) => a + w(p), 0);
    const s0 = totAll > 0 ? LINEUP_TEAM_MINUTES / totAll : 1;
    let add = 0;
    for (const o of out) {
      const freed = beta * s0 * w(o);
      const sameTot = o.group ? avail.filter((p) => p.group === o.group).reduce((a, p) => a + w(p), 0) : 0;
      const a = sameTot > 0 ? alpha : 0;
      if (a > 0 && me.group === o.group) add += a * freed * me.m0 / sameTot;
      if (tot > 0) add += (1 - a) * freed * me.m0 / tot;
    }
    raw = me.m0 > 0 ? (me.m0 * s0 + add) / me.m0 : 1;
  }
  const scale = Math.min(LINEUP_SCALE.max, Math.max(LINEUP_SCALE.min, raw));
  return { m0: me.m0, minutes: Math.min(LINEUP_MAX_MINUTES, me.m0 * scale), scale, out: out.map((p) => p.name) };
}

/** Calibrated P(over) for a prop given an engine mean and its matchup factor. */
export function calibratedProbOver({ params, key, mean, factor = 1, line }) {
  const r = params?.r?.[key], c = params?.c?.[key];
  if (!(r > 0) || !(c > 0) || typeof mean !== "number" || typeof line !== "number") return null;
  const mu = Math.max(1e-3, mean * factor * c);
  return { p_over: lineProbs(line, mu, r).over, mean: mu };
}

/**
 * Move a book's fair P(over) at its own line to another line through the
 * fitted negative binomial: find μ with NB(μ, r).over(bookLine) = pOver
 * (monotone in μ — bisection), then read P(over) at targetLine. Replaces the
 * fixed-σ normal shift in odds.js for the SHADOW pipeline, so goblin/demon
 * lines (typically 2–7 points from the book line) get a skewed, mean-scaled
 * tail. Returns pOver unchanged when the lines match. Clamped [0.01, 0.99].
 */
export function nbShiftOver({ pOver, bookLine, targetLine, r }) {
  if (typeof pOver !== "number" || typeof bookLine !== "number" || typeof targetLine !== "number" || !(r > 0)) return null;
  const p = Math.min(0.99, Math.max(0.01, pOver));
  if (targetLine === bookLine) return p;
  const over = (mu) => lineProbs(bookLine, mu, r).over;
  let lo = 1e-3, hi = Math.max(5, 4 * bookLine + 10);
  while (over(hi) < p && hi < 1e4) hi *= 2;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (over(mid) < p) lo = mid; else hi = mid; }
  return Math.min(0.99, Math.max(0.01, lineProbs(targetLine, (lo + hi) / 2, r).over));
}
