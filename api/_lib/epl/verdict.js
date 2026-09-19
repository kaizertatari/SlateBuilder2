// EPL verdict engine — one PrizePicks line in, one verdict out. Pure (no
// I/O): the caller supplies the fitted model, registry, market snapshot and
// any fetched lineups (api/_lib/epl/store.js does that at runtime).
//
// Pipeline per line:
//   1. resolve stat / teams / fixture / player            → else SKIP (gate)
//   2. minutes: FPL availability + FotMob lineup (confirmed sheet decisive,
//      predicted XI a nudge, unavailable → cannot play)
//   3. model  P(side | plays) with the MARKET team goals as game script
//   4. market P(side) from the books' one-sided ladders, level-matched by the
//      per-stat shading factor (ladders run ×1.06–1.72 above reality)
//   5. blend  in log-odds: book-priced stats pool model + market; model-only
//      stats are shrunk toward the line (PrizePicks posts near its median)
//   6. tier   from blended P − per-leg break-even, then caps (model-only,
//      rotation risk, thin sample, doubtful) — no S until calibrated
//
// EPL_POLICY holds every tunable number; they are PRIORS until the graded
// EPL outcomes calibrate them (step 5).

import { projectPlayer, priceLine, simulateFantasy } from "./model.js";
import { lineProbs } from "./distributions.js";
import { buildTeamResolver, buildPlayerResolver } from "./names.js";
import { POWER_MULTIPLIER, LINE_TYPE_FACTOR } from "../prizepicks-payouts.js";
import { lineupOverride } from "./fotmob.js";

export const EPL_POLICY = {
  version: 1,
  // Log-odds pooling weights when a book ladder prices the stat.
  blend: { model: 0.5, market: 0.5 },
  // Model-only stats: logit(p) is multiplied by this (0.5 halves the model's
  // distance from 50/50 — i.e. from the PrizePicks line).
  modelOnlyShrink: 0.5,
  // Tier thresholds on blended P − break-even.
  tierEdge: { A: 0.05, B: 0.015 },
  // Hard ceilings: no S-tier until EPL is calibrated; model-only ≤ B.
  maxTier: "A",
  modelOnlyMaxTier: "B",
  // Goblin/demon break-evens come from the app's approximate LINE_TYPE_FACTOR
  // (the slate builder keeps them opt-in for the same reason).
  approxPayoutMaxTier: "B",
  minPlay: 0.5, // below: SKIP (void/DNP risk dominates)
  rotationStart: 0.7, // unconfirmed lineup + P(start) below → cap B
  minApps: 2, // fewer appearances → cap B
  // Fallback shading when the odds snapshot has none (2026-09-19 board read).
  defaultShading: { shots: 1.3, sot: 1.45, tackles: 1.54, goal_assist: 1.25, fouls: 1.34, goals: 1.06, assists: 1.72, saves: 1.27, key_passes: 1.3, fouled: 1.34 },
};

// PrizePicks stat_type → model prop. Goalie Fantasy Score is deliberately
// absent (PrizePicks' keeper scoring isn't modelled).
export const PP_TO_STAT = {
  "Shots": "shots", "Shots On Target": "sot", "Shots Assisted": "key_passes",
  "Passes Attempted": "passes_att", "Crosses": "crosses_att", "Attempted Dribbles": "dribbles_att",
  "Tackles": "tackles", "Clearances": "clearances", "Fouls": "fouls",
  "Goals": "goals", "Assists": "assists", "Goal + Assist": "goal_assist",
  "Goalie Saves": "saves", "Goals Allowed": "goals_conceded",
  "Outfield Fantasy Score": "fantasy",
};
// Stats the books price with a player ladder (DK and/or FD).
const MARKET_STATS = new Set(["shots", "sot", "key_passes", "goals", "assists", "goal_assist", "tackles", "saves", "fouls", "fouled"]);

const TIER_RANK = { SKIP: 0, B: 1, A: 2, S: 3 };
const capTier = (tier, cap) => (TIER_RANK[tier] > TIER_RANK[cap] ? cap : tier);
const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clampP = (p) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const r3 = (x) => (x == null ? null : Number(x.toFixed(3)));

// Per-leg break-even: 2-pick power (3×) reference × the app's line-type
// factor. Exact for standard (57.7%); goblin/demon are approximate.
export function breakEven(oddsType = "standard") {
  return 1 / (Math.sqrt(POWER_MULTIPLIER[2]) * (LINE_TYPE_FACTOR[oddsType] ?? 1));
}

/**
 * Build the reusable context (resolvers, indexes) once per request batch.
 * @param {Object} a
 * @param {Object} a.model     data/epl-model.json (includes upcoming fixtures)
 * @param {Object} a.registry  data/epl-players.json
 * @param {Object} [a.odds]    data/epl-odds.json
 * @param {Map<string,Object>} [a.lineups]  match_id → parseLineup()
 */
export function buildEplContext({ model, registry, odds = null, lineups = new Map() }) {
  const tidByAbbr = Object.fromEntries(Object.entries(model.teams || {}).map(([tid, t]) => [t.abbr, tid]));
  return {
    model, registry, odds, lineups,
    team: buildTeamResolver(registry),
    player: buildPlayerResolver(model, registry),
    tidByAbbr,
    abbrOf: (tid) => model.teams?.[tid]?.abbr ?? null,
    projections: new Map(),
  };
}

// The fixture nearest the PrizePicks start time (both meetings of a pair are
// "upcoming" early in the season).
export function findFixture(ctx, teamAbbr, oppAbbr, startTime) {
  const t = Date.parse(startTime);
  const cands = (ctx.model.fixtures || []).filter((f) => {
    const h = ctx.abbrOf(f.home_id), a = ctx.abbrOf(f.away_id);
    return (h === teamAbbr && a === oppAbbr) || (h === oppAbbr && a === teamAbbr);
  });
  if (!cands.length) return null;
  const f = cands.sort((x, y) => Math.abs(Date.parse(x.kickoff) - t) - Math.abs(Date.parse(y.kickoff) - t))[0];
  const home = ctx.abbrOf(f.home_id);
  return { ...f, home_abbr: home, away_abbr: ctx.abbrOf(f.away_id), venue: home === teamAbbr ? "home" : "away" };
}

function skip(base, reason, detail = null) {
  return {
    ...base, verdict: "SKIP", tier: "SKIP", confidence: 0, prob: null, pre_filtered: true,
    skip_reason: reason, justification: detail ?? reason, flags: [], rules_fired: [`gate:${reason}`],
  };
}

/**
 * Price one PrizePicks EPL line in one direction.
 * @param {Object} prop       lines-snapshot prop { player, stat_type, line,
 *   odds_type, player_team, opponent, start_time }
 * @param {"OVER"|"UNDER"} direction
 * @param {Object} ctx        buildEplContext()
 * @param {Object} [policy]   EPL_POLICY override (backtests/calibration)
 */
export function eplVerdict(prop, direction, ctx, policy = EPL_POLICY) {
  const oddsType = (prop.odds_type || "standard").toLowerCase();
  const base = {
    league: "EPL", player: prop.player, prop_type: prop.stat_type, direction, line: prop.line,
    odds_type: oddsType, game_start_time: prop.start_time ?? null,
    game: `${prop.player_team ?? "?"} vs ${prop.opponent ?? "?"}`,
  };
  if ((oddsType === "goblin" || oddsType === "demon") && direction !== "OVER") return skip(base, "over_only_line", "goblin/demon lines are OVER-only");
  const stat = PP_TO_STAT[prop.stat_type];
  if (!stat) return skip(base, "unsupported_stat", `${prop.stat_type} is not modelled`);
  const teamAbbr = ctx.team(prop.player_team);
  const oppAbbr = ctx.team(prop.opponent);
  if (!teamAbbr || !oppAbbr) return skip(base, "unresolved_team", `team "${prop.player_team}" / "${prop.opponent}" not recognised`);
  const fx = findFixture(ctx, teamAbbr, oppAbbr, prop.start_time);
  if (!fx) return skip(base, "no_fixture", `no upcoming ${teamAbbr}–${oppAbbr} fixture`);
  base.game = `${fx.home_abbr} v ${fx.away_abbr}`;
  base.match_id = fx.match_id;
  const who = ctx.player(prop.player, teamAbbr);
  if (!who) return skip(base, "unresolved_player", `${prop.player} not in this season's data`);
  const mp = ctx.model.players[who.id];
  base.player_id = who.id;
  if (mp.prior_only) return skip(base, "no_minutes_this_season", `${mp.name} has no minutes this season (prior only)`);

  // Market game script.
  const mkt = ctx.odds?.matches?.[`${fx.home_abbr}-${fx.away_abbr}`];
  const lam = mkt?.lambda ?? null;
  const teamContext = lam ? { xg_for: fx.venue === "home" ? lam.home : lam.away, xg_against: fx.venue === "home" ? lam.away : lam.home } : null;

  // Minutes: lineup (confirmed / predicted / unavailable) over FPL status.
  const lineup = ctx.lineups?.get(fx.match_id) ?? null;
  const override = lineupOverride(lineup, who.id);
  const projKey = `${who.id}|${fx.match_id}|${JSON.stringify(override)}`;
  if (!ctx.projections.has(projKey)) {
    ctx.projections.set(projKey, {
      play: projectPlayer(ctx.model, { playerId: who.id, opponentTeamId: ctx.tidByAbbr[oppAbbr], venue: fx.venue, teamContext, minutes: override }),
      start: projectPlayer(ctx.model, { playerId: who.id, opponentTeamId: ctx.tidByAbbr[oppAbbr], venue: fx.venue, teamContext, minutes: { started: true } }),
    });
  }
  const { play, start } = ctx.projections.get(projKey);
  const pPlay = play.scenarios.filter((s) => s.m > 0).reduce((a, s) => a + s.p, 0);
  const pStart = play.scenarios.filter((s) => s.kind === "full" || s.kind === "early").reduce((a, s) => a + s.p, 0);
  const lineupState = lineup?.type ?? "none";
  if (override?.unavailable) return skip(base, "unavailable", `${mp.name} is listed injured/suspended`);
  if (lineupState === "confirmed" && override && override.started === false && !override.bench) return skip(base, "not_in_squad", `${mp.name} is not in the confirmed squad`);
  if (pPlay < policy.minPlay) return skip(base, "dnp_risk", `${mp.name} ${Math.round(pPlay * 100)}% to play`);

  // Model probability for the side (conditional on no push — PrizePicks
  // re-grades ties).
  let mOver, mUnder, mean;
  if (stat === "fantasy") {
    const sim = simulateFantasy(play);
    if (!sim) return skip(base, "unsupported_stat", "fantasy is outfield-only");
    const lp = sim.probOver(prop.line);
    mOver = lp.over; mUnder = lp.under; mean = sim.mean;
  } else {
    const pl = priceLine(play, stat, prop.line);
    if (!pl || pl.p_over == null) return skip(base, "wrong_position_stat", `${prop.stat_type} doesn't apply to ${mp.name} (${mp.role})`);
    mOver = pl.p_over; mUnder = pl.p_under; mean = pl.mean;
  }
  const decided = mOver + mUnder;
  const pModel = clampP((direction === "OVER" ? mOver : mUnder) / (decided || 1));

  // Market probability (level-matched ladder), same conditioning.
  let pMarket = null, lambdaMarket = null;
  const lamHat = MARKET_STATS.has(stat) ? ctx.odds?.players?.[who.id]?.props?.[stat]?.lambda_hat ?? null : null;
  if (lamHat) {
    const shading = ctx.odds?.shading?.[stat] ?? policy.defaultShading[stat] ?? 1;
    const startMean = priceLine(start, stat, 0.5)?.mean ?? null;
    const playScale = startMean > 0 ? mean / startMean : 1;
    lambdaMarket = (lamHat / shading) * playScale;
    const lp = lineProbs(prop.line, lambdaMarket, Infinity);
    const d = lp.over + lp.under;
    pMarket = clampP((direction === "OVER" ? lp.over : lp.under) / (d || 1));
  }

  // Blend.
  const modelOnly = pMarket == null;
  const prob = modelOnly
    ? sigmoid(policy.modelOnlyShrink * logit(pModel))
    : sigmoid(policy.blend.model * logit(pModel) + policy.blend.market * logit(pMarket));

  // Tier + caps.
  const be = breakEven(oddsType);
  const edge = prob - be;
  let tier = edge >= policy.tierEdge.A ? "A" : edge >= policy.tierEdge.B ? "B" : "SKIP";
  const flags = [];
  const rules = [modelOnly ? "epl-model-only" : "epl-blend"];
  tier = capTier(tier, policy.maxTier);
  if (tier !== "SKIP") {
    if (oddsType !== "standard") { tier = capTier(tier, policy.approxPayoutMaxTier); rules.push("cap:approx-payout"); flags.push(`⚠️ ${oddsType} payout is approximate — capped at B`); }
    if (modelOnly) { tier = capTier(tier, policy.modelOnlyMaxTier); rules.push("cap:model-only"); flags.push("⚠️ No sportsbook market for this stat — model only, capped at B"); }
    if (lineupState !== "confirmed" && pStart < policy.rotationStart) { tier = capTier(tier, "B"); rules.push("cap:rotation"); flags.push(`⚠️ ${Math.round(pStart * 100)}% to start — re-run after lineups (~1h before kickoff)`); }
    if (mp.apps < policy.minApps) { tier = capTier(tier, "B"); rules.push("cap:thin-sample"); flags.push(`⚠️ Only ${mp.apps} appearance(s) this season`); }
    if (mp.status?.fpl === "d") { tier = capTier(tier, "B"); rules.push("cap:doubtful"); flags.push(`⚠️ FPL: doubtful${mp.status.chance_next != null ? ` (${mp.status.chance_next}%)` : ""}${mp.status.news ? ` — ${mp.status.news}` : ""}`); }
    if (!modelOnly && (pModel - be) * (pMarket - be) < 0) { rules.push("flag:model-market-split"); flags.push("⚠️ Model and books disagree on this side"); }
  }
  if (lineupState === "confirmed") rules.push("lineup:confirmed");
  else if (lineupState === "predicted") rules.push("lineup:predicted");

  const side = direction.toLowerCase();
  const unit = stat === "fantasy" ? "pts" : prop.stat_type.toLowerCase();
  const justification = [
    `Model ${Math.round(pModel * 100)}% ${side} (expects ${mean.toFixed(1)} ${unit} vs ${prop.line}; ${Math.round(pStart * 100)}% to start, lineup ${lineupState})`,
    modelOnly ? "no book ladder — shrunk toward the line" : `books ${Math.round(pMarket * 100)}% (ladder λ ${lambdaMarket.toFixed(2)} level-matched)`,
    `${modelOnly ? "adjusted" : "blend"} ${(prob * 100).toFixed(1)}% vs break-even ${(be * 100).toFixed(1)}% → ${tier}`,
  ].join(" · ");

  return {
    ...base,
    stat,
    team: teamAbbr,
    opponent: oppAbbr,
    venue: fx.venue,
    verdict: tier === "SKIP" ? "SKIP" : direction,
    tier,
    confidence: Math.round(prob * 100),
    prob: r3(prob),
    break_even: r3(be),
    edge: r3(edge),
    justification,
    flags,
    rules_fired: rules,
    detail: {
      p_model: r3(pModel), p_market: r3(pMarket), lambda_market: r3(lambdaMarket), mean: r3(mean),
      p_play: r3(pPlay), p_start: r3(pStart), lineup: lineupState, model_only: modelOnly,
      team_xg: teamContext ? { for: r3(teamContext.xg_for), against: r3(teamContext.xg_against) } : null,
      policy_version: policy.version,
    },
  };
}
