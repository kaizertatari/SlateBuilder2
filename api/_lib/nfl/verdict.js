// NFL verdict engine (step 4): one PrizePicks line in, one verdict out. Pure
// (no I/O): the caller supplies the model artifact (data/nfl-model.json —
// includes names, roster status, upcoming schedule, injury reports) and the
// books snapshot (data/nfl-odds.json); api/_lib/nfl/store.js does that at
// runtime.
//
// Pipeline per line:
//   1. resolve stat / teams / game / player                → else SKIP (gate)
//   2. availability: roster status (IR/PUP/suspended), this week's injury
//      report (Out/Doubtful → SKIP, Questionable → cap B), last week's Out
//      with no report yet → cap B; QB: the team's last starter unless the
//      books price someone else's passing
//   3. model  P(side | plays) from the seeded player simulation, game script
//      from the CURRENT book spread/total (closing-line fallback)
//   4. market P(side): the model's draws exponentially tilted so P(over the
//      book line) = the books' de-vigged price, then priced at the PrizePicks
//      line — the market sets the level, the model the shape (ranks agree
//      ρ 0.93–0.97, but the model's level ran low: P(over) 0.39–0.45 on
//      50/50 book lines, 2026-10-13 board)
//   5. blend  in log-odds (shared pick policy); stats with no book price are
//      priced + logged but never tiered (EPL v2 lesson)
//   6. tier   from blended P − per-leg break-even, then caps — no S until
//      NFL is calibrated on graded outcomes
//
// NFL_POLICY holds every tunable number; they are PRIORS until step 5's
// graded outcomes calibrate them.

import { simulatePlayer, gameContext, priceLine } from "./model.js";
import { tiltToMarket, tiltedLineProbs } from "../distributions.js";
import { blendProb, tierForEdge, capTier, clampP } from "../pick-policy.js";
import { buildPlayerResolver, nflTeam } from "./names.js";

export const NFL_POLICY = {
  version: 1,
  // The books are sharper than a week-6 model: market-heavy pooling.
  blend: { model: 0.3, market: 0.7 },
  modelOnlyShrink: 0.5,
  tierEdge: { A: 0.05, B: 0.015 },
  maxTier: "A",
  modelOnlyMaxTier: "SKIP",
  approxPayoutMaxTier: "B",
  // Anytime-TD prices are one-sided; divide the implied probability by this
  // overround (prior — DK/FD anytime boards carry roughly 10–15% hold).
  tdOverround: 1.12,
  // A tilt this large (|θ| in sd units) means model and books disagree on
  // the level by more than the model's shape can be trusted to bridge.
  maxTilt: 1.5,
  sims: 10000,
};

// PrizePicks stat_type (lowercased) → model stat. The first spelling of each
// is what the live board used on 2026-10-14 (league 9); the rest are aliases.
// Not modelled: Longest Rush/Reception/Completion (need play-by-play),
// Sacks Taken, per-quarter/half and ratio props, multi-player "(Combo)".
export const PP_TO_STAT = {
  "pass yards": "pass_yds", "passing yards": "pass_yds",
  "pass attempts": "pass_att", "passing attempts": "pass_att",
  "pass completions": "completions", "completions": "completions",
  "pass tds": "pass_td", "passing tds": "pass_td", "passing touchdowns": "pass_td",
  "int": "pass_int", "ints": "pass_int", "interceptions": "pass_int", "pass ints": "pass_int", "interceptions thrown": "pass_int",
  "rush yards": "rush_yds", "rushing yards": "rush_yds",
  "rush attempts": "rush_att", "rushing attempts": "rush_att",
  "receiving yards": "rec_yds", "rec yards": "rec_yds",
  "receptions": "rec",
  "rec targets": "targets", "targets": "targets",
  "rush+rec yds": "rush_rec_yds", "rush + rec yds": "rush_rec_yds", "rush+rec yards": "rush_rec_yds",
  "pass+rush yds": "pass_rush_yds", "pass + rush yds": "pass_rush_yds", "pass+rush yards": "pass_rush_yds",
  "anytime tds": "rush_rec_td", "anytime td": "rush_rec_td", "rush+rec tds": "rush_rec_td", "rush + rec tds": "rush_rec_td", "touchdowns": "rush_rec_td",
  "rush tds": "rush_td", "rushing tds": "rush_td", "rec tds": "rec_td", "receiving tds": "rec_td",
  "fantasy score": "fantasy",
  "tackles+ast": "tackles_ast", "tackles + ast": "tackles_ast",
  "sacks": "def_sacks",
  "fg made": "fg_made", "field goals made": "fg_made",
  "kicking points": "kicking_pts",
};
export const mapNflStat = (statType) => PP_TO_STAT[String(statType || "").trim().toLowerCase()] ?? null;

// Display name per model stat (UI stat picker / STATS_BY_LEAGUE.NFL).
export const NFL_STAT_LABEL = {
  pass_yds: "Pass Yards", pass_att: "Pass Attempts", completions: "Pass Completions", pass_td: "Pass TDs", pass_int: "INT",
  rush_yds: "Rush Yards", rush_att: "Rush Attempts", rec_yds: "Receiving Yards", rec: "Receptions", targets: "Rec Targets",
  rush_rec_yds: "Rush+Rec Yds", pass_rush_yds: "Pass+Rush Yds", rush_rec_td: "Anytime TDs", rush_td: "Rush TDs", rec_td: "Rec TDs", fantasy: "Fantasy Score",
  tackles_ast: "Tackles+Ast", def_sacks: "Sacks", fg_made: "FG Made", kicking_pts: "Kicking Points",
};

// Roster statuses that mean the player can't suit up this week.
const INACTIVE_STATUS = { RES: "on injured reserve", PUP: "on PUP", SUS: "suspended", CUT: "released", RSR: "on reserve", RSN: "on reserve (non-football)", NWT: "not with team", EXE: "on the exempt list" };
const PASSING = new Set(["pass_yds", "pass_att", "completions", "pass_td", "pass_int", "pass_rush_yds"]);

const r3 = (x) => (x == null ? null : Number(x.toFixed(3)));

// nflverse gametime is US Eastern; EDT through 2026-10-31, EST after
// (DST ends 2026-11-01), EDT again from 2027-03-14.
export function kickoffOf(g) {
  if (!g?.gameday) return NaN;
  const d = g.gameday;
  const est = d >= "2026-11-01" && d < "2027-03-14";
  return Date.parse(`${d}T${g.gametime || "13:00"}:00${est ? "-05:00" : "-04:00"}`);
}

/**
 * Build the reusable context (resolvers, indexes, simulation cache) once per
 * request batch.
 * @param {{ model:Object, odds?:Object|null, now?:number }} a
 */
export function buildNflContext({ model, odds = null, now = Date.now() }) {
  const player = buildPlayerResolver(model.players);
  // Book quotes keyed by gsis id.
  const props = new Map(), anytime = new Map();
  for (const [name, list] of Object.entries(odds?.by_player || {})) {
    const id = player(name, list[0]?.team ?? null);
    if (id) props.set(id, list);
  }
  for (const [name, list] of Object.entries(odds?.anytime_td || {})) {
    const id = player(name, list[0]?.team ?? null);
    if (id) anytime.set(id, list);
  }
  return { model, odds, player, props, anytime, sims: new Map(), tilts: new Map(), now };
}

/** The upcoming game between two teams nearest the PrizePicks start time. */
export function findGame(ctx, team, opp, startTime) {
  const t = Date.parse(startTime);
  const cands = (ctx.model.schedule || []).filter((g) => (g.home === team && g.away === opp) || (g.home === opp && g.away === team));
  if (!cands.length) return null;
  const g = Number.isFinite(t) ? cands.sort((a, b) => Math.abs(kickoffOf(a) - t) - Math.abs(kickoffOf(b) - t))[0] : cands[0];
  const live = ctx.odds?.games?.[`${g.away}@${g.home}`] ?? null;
  // Current book line first (home_spread is the home handicap, so the
  // expected home margin is its negative); nflverse's line as the floor.
  const homeMargin = live?.home_spread != null ? -live.home_spread : g.spread_line ?? 0;
  const total = live?.total ?? g.total_line;
  return { ...g, key: `${g.away}@${g.home}`, homeMargin, total, lineSource: live?.total != null ? "books" : "nflverse", kickoff: Number.isFinite(Date.parse(live?.start_time)) ? Date.parse(live.start_time) : kickoffOf(g) };
}

function skip(base, reason, detail = null) {
  return {
    ...base, verdict: "SKIP", tier: "SKIP", confidence: 0, prob: null, pre_filtered: true,
    skip_reason: reason, justification: detail ?? reason, flags: [], rules_fired: [`gate:${reason}`],
  };
}

// The books' de-vigged P(over) for this player/stat: { line, fair_over, books }.
function bookQuote(ctx, id, stat, policy) {
  if (stat === "rush_rec_td") {
    const list = ctx.anytime.get(id);
    if (!list?.length) return null;
    const imp = list.reduce((a, q) => a + q.implied, 0) / list.length;
    return { line: 0.5, fair_over: clampP(imp / policy.tdOverround), books: list.length, kind: "anytime" };
  }
  const list = (ctx.props.get(id) || []).filter((q) => q.stat === stat && q.fair_over != null);
  if (!list.length) return null;
  const q = list.sort((a, b) => (b.books ?? 1) - (a.books ?? 1))[0];
  return { line: q.line, fair_over: q.fair_over, books: q.books ?? 1, kind: "ou" };
}

/**
 * Price one PrizePicks NFL line in one direction.
 * @param {Object} prop  lines-snapshot prop { player, stat_type, line, odds_type, player_team, opponent, start_time }
 * @param {"OVER"|"UNDER"} direction
 * @param {Object} ctx   buildNflContext()
 * @param {Object} [policy]
 */
export function nflVerdict(prop, direction, ctx, policy = NFL_POLICY) {
  const oddsType = (prop.odds_type || "standard").toLowerCase();
  const base = {
    league: "NFL", player: prop.player, prop_type: prop.stat_type, direction, line: prop.line,
    odds_type: oddsType, game_start_time: prop.start_time ?? null,
    game: `${prop.player_team ?? "?"} vs ${prop.opponent ?? "?"}`,
  };
  if ((oddsType === "goblin" || oddsType === "demon") && direction !== "OVER") return skip(base, "over_only_line", "goblin/demon lines are OVER-only");
  const stat = mapNflStat(prop.stat_type);
  if (!stat) return skip(base, "unsupported_stat", `${prop.stat_type} is not modelled`);
  const team = nflTeam(prop.player_team), opp = nflTeam(prop.opponent);
  if (!team || !opp) return skip(base, "unresolved_team", `team "${prop.player_team}" / "${prop.opponent}" not recognised`);
  const g = findGame(ctx, team, opp, prop.start_time);
  if (!g) return skip(base, "no_game", `no upcoming ${team}–${opp} game`);
  base.game = g.key;
  base.game_id = g.game_id;
  base.game_start_time = prop.start_time ?? (Number.isFinite(g.kickoff) ? new Date(g.kickoff).toISOString() : null);
  const ko = Number.isFinite(Date.parse(prop.start_time)) ? Date.parse(prop.start_time) : g.kickoff;
  if (Number.isFinite(ko) && ko <= (ctx.now ?? Date.now())) return skip(base, "game_started", "kickoff has passed");
  const id = ctx.player(prop.player, team);
  if (!id) return skip(base, "unresolved_player", `${prop.player} not in the nflverse data`);
  const mp = ctx.model.players[id];
  base.player_id = id;
  const name = mp.name ?? prop.player;

  // Availability gates.
  if (INACTIVE_STATUS[mp.status]) return skip(base, "inactive_roster", `${name} is ${INACTIVE_STATUS[mp.status]}`);
  const weeks = ctx.model.injuries?.weeks ?? {};
  const inj = weeks[g.week]?.[id] ?? null;
  const prevInj = weeks[g.week - 1]?.[id] ?? null;
  const reportOut = Object.keys(weeks[g.week] ?? {}).length > 0;
  if (inj?.report_status === "Out") return skip(base, "injury_out", `${name} is OUT (${inj.injury ?? "injury"})`);
  if (inj?.report_status === "Doubtful") return skip(base, "injury_doubtful", `${name} is DOUBTFUL (${inj.injury ?? "injury"})`);

  // PrizePicks posts a kicker Fantasy Score scored on kicking (likely FG
  // distance-weighted); the model's Fantasy Score is the offensive formula.
  if (stat === "fantasy" && (mp.pos === "K" || mp.pos === "P")) return skip(base, "unsupported_stat", "Kicker Fantasy Score isn't modelled");

  const quote = bookQuote(ctx, id, stat, policy);
  if (mp.pos === "QB" && PASSING.has(stat)) {
    const starter = ctx.model.qbStarters?.[team]?.player_id;
    if (starter && starter !== id && !quote) return skip(base, "qb_not_starter", `${name} isn't ${team}'s last starter and no book prices his passing`);
  }

  // Simulation (cached per player + game).
  const gc = gameContext({ team, opp, spreadLineHome: g.homeMargin, total: g.total, home: g.home === team });
  const simKey = `${id}|${g.game_id}`;
  if (!ctx.sims.has(simKey)) ctx.sims.set(simKey, simulatePlayer(ctx.model, id, gc, { sims: policy.sims }));
  const sim = ctx.sims.get(simKey);
  const draws = sim?.draws?.[stat];
  // The simulator emits zeros for stats a player has no role in (a kicker's
  // pass yards) — that is "doesn't apply", not a 100% UNDER.
  if (!draws?.length || (PASSING.has(stat) && stat !== "pass_rush_yds" && !mp.qb) || !draws.some((x) => x !== 0)) {
    return skip(base, "wrong_position_stat", `${prop.stat_type} doesn't apply to ${name} (${mp.pos})`);
  }
  const pl = priceLine(sim, stat, prop.line);
  const decided = pl.over + pl.under;
  if (!decided) return skip(base, "no_distribution", `${name} never reaches either side of ${prop.line}`);
  const mean = sim.mean[stat];
  const pModel = clampP((direction === "OVER" ? pl.over : pl.under) / decided);

  // Market: tilt the model's draws to the books' price at the book line.
  let pMarket = null, tilt = null, marketMean = null;
  if (quote) {
    const tiltKey = `${simKey}|${stat}|${quote.line}|${quote.fair_over}`;
    if (!ctx.tilts.has(tiltKey)) ctx.tilts.set(tiltKey, tiltToMarket(draws, quote.line, quote.fair_over));
    const t = ctx.tilts.get(tiltKey);
    if (t) {
      const lp = tiltedLineProbs(prop.line, t);
      const d = lp.over + lp.under;
      if (d > 0) {
        pMarket = clampP((direction === "OVER" ? lp.over : lp.under) / d);
        tilt = t.theta;
        marketMean = t.mean;
      }
    }
  }

  const { prob, modelOnly } = blendProb({ pModel, pMarket, blend: policy.blend, modelOnlyShrink: policy.modelOnlyShrink });
  const tiered = tierForEdge(prob, oddsType, policy, { modelOnly });
  const be = tiered.break_even;
  let tier = tiered.tier;
  const flags = [...tiered.flags];
  const rules = [modelOnly ? "nfl-model-only" : "nfl-blend", ...tiered.rules];
  const cur = ctx.model.current;
  if (tier !== "SKIP") {
    if (inj?.report_status === "Questionable") { tier = capTier(tier, "B"); rules.push("cap:questionable"); flags.push(`⚠️ QUESTIONABLE (${inj.injury ?? "injury"}) — re-run after inactives (~90 min before kickoff)`); }
    else if (!reportOut && prevInj?.report_status === "Out") { tier = capTier(tier, "B"); rules.push("cap:was-out"); flags.push(`⚠️ Was OUT last week (${prevInj.injury ?? "injury"}); this week's report isn't out yet`); }
    if (mp.last?.season !== cur) { tier = capTier(tier, "B"); rules.push("cap:no-current-season"); flags.push("⚠️ No games this season — priced off last season"); }
    else if (mp.last.week < ctx.model.lastWeek - 1) { tier = capTier(tier, "B"); rules.push("cap:returning"); flags.push(`⚠️ Last played week ${mp.last.week} — role may have changed`); }
    if (mp.team && mp.team !== team) { tier = capTier(tier, "B"); rules.push("cap:new-team"); flags.push(`⚠️ Fitted on ${mp.team} usage`); }
    if (tilt != null && Math.abs(tilt) > policy.maxTilt) { tier = capTier(tier, "B"); rules.push("cap:large-tilt"); flags.push("⚠️ Model and books disagree sharply on this player's level"); }
    if (!modelOnly && (pModel - be) * (pMarket - be) < 0) { rules.push("flag:model-market-split"); flags.push("⚠️ Model and books disagree on this side"); }
  }
  if (Number.isFinite(ko) && ko - (ctx.now ?? Date.now()) > 90 * 60 * 1000) rules.push("pre-inactives");

  const side = direction.toLowerCase();
  const label = NFL_STAT_LABEL[stat] ?? prop.stat_type;
  const justification = [
    `Model ${Math.round(pModel * 100)}% ${side} (expects ${mean.toFixed(1)} ${label} vs ${prop.line})`,
    modelOnly
      ? "no book price — logged, not tiered"
      : `books ${Math.round(pMarket * 100)}% (${quote.kind === "anytime" ? "anytime TD" : `${quote.line}`} at ${Math.round(quote.fair_over * 100)}% over, ${quote.books} book${quote.books > 1 ? "s" : ""}; level-matched mean ${marketMean.toFixed(1)})`,
    `${modelOnly ? "adjusted" : "blend"} ${(prob * 100).toFixed(1)}% vs break-even ${(be * 100).toFixed(1)}% → ${tier}`,
  ].join(" · ");

  return {
    ...base,
    stat,
    team,
    opponent: opp,
    venue: g.home === team ? "home" : "away",
    verdict: tier === "SKIP" ? "SKIP" : direction,
    tier,
    confidence: Math.round(prob * 100),
    prob: r3(prob),
    break_even: r3(be),
    edge: r3(tiered.edge),
    justification,
    flags,
    rules_fired: rules,
    detail: {
      p_model: r3(pModel), p_market: r3(pMarket), mean: r3(mean), market_mean: r3(marketMean), tilt: r3(tilt),
      book_line: quote?.line ?? null, book_fair_over: quote ? r3(quote.fair_over) : null, books: quote?.books ?? 0,
      model_only: modelOnly, injury: inj?.report_status ?? null, pos: mp.pos,
      game_line: { home_margin: g.homeMargin, total: g.total, source: g.lineSource },
      policy_version: policy.version,
    },
  };
}
