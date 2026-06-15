// World Cup (soccer) ground-truth composer — WC_FRAMEWORK_SPEC.md §4, §10.
//
// The basketball gatherer (api/analyze.js) leans on ESPN/NBA-stats gamelogs;
// none of that exists for national teams. Soccer ground truth is composed
// from what the pipeline already has on hand:
//
//   • the PrizePicks prop row (team country, opponent, position, kickoff)
//   • data/soccer-rates.json — club per-90 priors (FBref snapshot)
//   • data/soccer-accrual.json — tournament-to-date actuals (grader-written)
//   • the runtime odds store — DK team totals = market expected goals
//
// λ_model = r_p90 × (E[min]/90) × A, per stat — where A is now a PER-STAT
// environment driver (spec §10.1): shooters scale with their OWN team's
// goal environment, but saves/clearances/tackles scale with the OPPONENT's
// (a keeper behind a heavy underdog faces more shots), and passes scale
// with own dominance. All parameters initial values per spec §7/§10 —
// recalibrate from graded group-stage outcomes.
//
// Pure-ish: reads local JSON snapshots + the in-process odds store. No
// network calls (ESPN starter confirmation is a planned enrichment).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "./string-utils.js";
import { lookupVegas, lookupMarket, loadOdds } from "./odds.js";
import { fantasyMoments } from "./poisson.js";
import { WC_STAT_MODEL } from "./prop-types.js";

// Per-90 position priors (PrizePicks position vocabulary), per stat field —
// spec §10.4. Initial values from public per-90 distributions.
const POSITION_PRIORS = {
  Attacker: { shots: 2.4, sot: 0.86, tackles: 0.8, clearances: 0.5, passes_att: 25, saves: 0, goals: 0.35, assists: 0.15, key_passes: 1.2, crosses: 1.5, dribbles_att: 2.2, fouls: 1.2, yellow: 0.12, red: 0.01 },
  Midfielder: { shots: 1.2, sot: 0.43, tackles: 1.8, clearances: 1.2, passes_att: 45, saves: 0, goals: 0.10, assists: 0.12, key_passes: 1.1, crosses: 1.8, dribbles_att: 1.2, fouls: 1.2, yellow: 0.18, red: 0.01 },
  Defender: { shots: 0.5, sot: 0.18, tackles: 1.6, clearances: 4.0, passes_att: 50, saves: 0, goals: 0.04, assists: 0.05, key_passes: 0.5, crosses: 2.0, dribbles_att: 0.6, fouls: 1.0, yellow: 0.20, red: 0.015 },
  Goalkeeper: { shots: 0.05, sot: 0.02, tackles: 0.1, clearances: 1.0, passes_att: 25, saves: 3.0, goals: 0, assists: 0, key_passes: 0, crosses: 0, dribbles_att: 0, fouls: 0.1, yellow: 0.05, red: 0.005 },
};
POSITION_PRIORS.Forward = POSITION_PRIORS.Attacker; // alias, in case PP varies the label

const PRIOR_WEIGHT_MATCHES = 5; // n₀ — shrinkage weight of the position prior
const CLUB_N_CAP = 25; // club sample influence cap (≈ a half season)
const ACCRUAL_MATCH_WEIGHT = 3; // a WC match counts 3× a club match (spec §4.4)

// Expected minutes model (spec §4.2, §10.3). Confirmed-starter enrichment
// (ESPN rosters ~1h pre-kickoff) is a follow-up; v1 works off club minutes
// share. Keepers don't rotate within a match: a starter GK plays 90, and an
// unknown/backup GK defaults LOW so OVERs gate out rather than ride a backup.
const EXP_MIN = { starter: 78, rotation: 55, bench: 25, unknown: 55, gk_starter: 90, gk_unknown: 45 };

// Minutes DISTRIBUTION per minutes_source — the predictive spread the
// projection tail integrates over (spec §4.2: minutes are the dominant
// variance source). Conditional on the player APPEARING: DNPs settle as
// `void` not `miss` (grade-outcomes.mjs), so no 0-minute scenario. Each
// distribution's mean is ≈ the matching EXP_MIN point, so the mean λ and the
// rule-wc-minutes gate (which keys on expected_minutes) are unchanged — the
// mixture adds only variance, and that variance scales with minutes
// uncertainty (wide for rotation outfielders, ~0 for confirmed-90 keepers).
// Masses are tunable calibration constants (like POSITION_PRIORS / ENV_DRIVERS).
const MINUTES_DIST = {
  club_share_starter:    [{ minutes: 90, p: 0.45 }, { minutes: 78, p: 0.30 }, { minutes: 62, p: 0.18 }, { minutes: 45, p: 0.07 }], // mean ≈ 78
  club_share_rotation:   [{ minutes: 75, p: 0.25 }, { minutes: 62, p: 0.30 }, { minutes: 45, p: 0.30 }, { minutes: 28, p: 0.15 }], // mean ≈ 55
  unknown:               [{ minutes: 75, p: 0.25 }, { minutes: 62, p: 0.30 }, { minutes: 45, p: 0.30 }, { minutes: 28, p: 0.15 }], // mean ≈ 55
  club_share_bench:      [{ minutes: 45, p: 0.15 }, { minutes: 30, p: 0.30 }, { minutes: 20, p: 0.40 }, { minutes: 10, p: 0.15 }], // mean ≈ 25
  club_share_starter_gk: [{ minutes: 90, p: 0.92 }, { minutes: 78, p: 0.08 }],                                                     // keepers ~always 90
  gk_rotation:           [{ minutes: 70, p: 0.20 }, { minutes: 48, p: 0.35 }, { minutes: 35, p: 0.30 }, { minutes: 20, p: 0.15 }], // mean ≈ 45
  gk_unknown:            [{ minutes: 70, p: 0.20 }, { minutes: 48, p: 0.35 }, { minutes: 35, p: 0.30 }, { minutes: 20, p: 0.15 }], // mean ≈ 45
};

// 2026 format: group stage ends 2026-06-27; from the Round of 32 on,
// PrizePicks settles on 90' + stoppage ONLY (extra time excluded).
const KNOCKOUT_FROM_MS = Date.parse("2026-06-28T00:00:00Z");

// Per-stat environment drivers (spec §10.1). basis: which team total feeds
// the ratio; exp damps the goals→stat elasticity; clamp bounds the
// multiplier. Stats absent here are environment-neutral (A = 1).
const ENV_DRIVERS = {
  shots: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  sot: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  goals: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  assists: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  key_passes: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  crosses: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  dribbles_att: { basis: "team_total", exp: 0.6, clamp: [0.75, 1.3] },
  saves: { basis: "opp_total", exp: 0.8, clamp: [0.6, 1.5] },
  clearances: { basis: "opp_total", exp: 0.6, clamp: [0.7, 1.4] },
  tackles: { basis: "opp_total", exp: 0.3, clamp: [0.85, 1.2] },
  passes_att: { basis: "team_total", exp: 0.45, clamp: [0.8, 1.25] },
};

// All λ fields composed per player. rates-snapshot key is `${field}_p90`;
// accrual key is the raw field name.
const LAMBDA_FIELDS = Object.keys(POSITION_PRIORS.Midfielder);

// Fantasy components whose λ can be upgraded to the DK ladder's
// margin-corrected λ_fair when a ladder covers the player (spec §10.5) —
// λ_fair is an all-in match estimate, so no minutes rescaling applies.
const MARKET_ANCHORED_COMPONENTS = { shots: "Shots", sot: "Shots On Target", tackles: "Tackles" };

const FALLBACK_MEAN_TEAM_TOTAL = 1.3; // ~avg WC team total when odds are thin

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RATES_PATH = path.join(ROOT, "data/soccer-rates.json");
const ACCRUAL_PATH = path.join(ROOT, "data/soccer-accrual.json");

let _rates;
let _accrual;

function loadJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** Test hook: inject a rates snapshot (mirrors setOdds). Pass null to reset. */
export function setSoccerRates(data) { _rates = data === null ? undefined : data; }
export function setSoccerAccrual(data) { _accrual = data === null ? undefined : data; }

function ratesFor(player) {
  if (_rates === undefined) _rates = loadJsonSafe(RATES_PATH);
  return _rates?.players?.[normalizeName(player)] ?? null;
}

function accrualFor(player) {
  if (_accrual === undefined) _accrual = loadJsonSafe(ACCRUAL_PATH);
  return _accrual?.players?.[normalizeName(player)] ?? null;
}

// Slate mean TEAM total from the odds store's games block (μ_tt in spec §4.3).
function meanTeamTotal() {
  const odds = loadOdds();
  const totals = Object.values(odds?.games || {})
    .filter((g) => typeof g?.game_total === "number" && g.home_spread != null) // WC games carry these; basketball totals are 150+ and excluded below
    .map((g) => g.game_total / 2)
    .filter((t) => t > 0 && t < 4); // soccer-plausible team totals only
  if (!totals.length) return FALLBACK_MEAN_TEAM_TOTAL;
  return totals.reduce((a, b) => a + b, 0) / totals.length;
}

// Per-stat environment multiplier (spec §10.1) from the match's DK totals.
function envFactor(field, vegas, mu) {
  const drv = ENV_DRIVERS[field];
  if (!drv || !vegas) return 1;
  const basis = vegas[drv.basis];
  if (typeof basis !== "number" || basis <= 0 || !(mu > 0)) return 1;
  const a = Math.pow(basis / mu, drv.exp);
  return Math.max(drv.clamp[0], Math.min(drv.clamp[1], a));
}

/**
 * Compose WC ground truth for one PrizePicks prop row.
 *
 * @param {{ player:string, prop:Object }} args — prop is the scraped PP row
 *   (player_team, opponent, start_time, player_position, league:"WC").
 * @returns {{ groundTruth:Object, trace:Object, playerInfo:Object }}
 *   Same contract as gatherGroundTruth; soccer never player-wide-skips here —
 *   missing data degrades to position priors + a data warning (the engine's
 *   WC rules tier-cap on weak provenance instead).
 */
export function gatherSoccerGroundTruth({ player, prop }) {
  const warnings = [];
  const position = prop?.player_position || null;
  const prior = POSITION_PRIORS[position] ?? POSITION_PRIORS.Midfielder;
  if (!POSITION_PRIORS[position]) warnings.push(`unknown position "${position}" — midfielder prior used`);
  const isGk = position === "Goalkeeper";

  // ── Rate prior per stat: club per-90 shrunk toward the position prior
  // (spec §4.1), generalized over every λ field (§10). A rates row that
  // predates the v2 snapshot fields degrades per-stat to the prior, tracked
  // in prior_only_fields so wc-projection can refuse a prior-only spine.
  const row = ratesFor(player);
  const nClub = row ? Math.min((row.minutes ?? 0) / 90, CLUB_N_CAP) : 0;
  const per90 = {};
  const priorOnlyFields = [];
  for (const f of LAMBDA_FIELDS) {
    const clubRate = row?.[`${f}_p90`];
    if (typeof clubRate === "number" && nClub > 0) {
      per90[f] = (nClub * clubRate + PRIOR_WEIGHT_MATCHES * prior[f]) / (nClub + PRIOR_WEIGHT_MATCHES);
    } else if (f === "sot" && typeof row?.shots_p90 === "number" && nClub > 0) {
      // Legacy fallback kept from v1: missing SOT estimates as 36% of shots.
      per90.sot = (nClub * row.shots_p90 * 0.36 + PRIOR_WEIGHT_MATCHES * prior.sot) / (nClub + PRIOR_WEIGHT_MATCHES);
    } else {
      per90[f] = prior[f];
      priorOnlyFields.push(f);
    }
  }
  const ratesSource = row && priorOnlyFields.length < LAMBDA_FIELDS.length ? "fbref_blend" : "position_prior";
  if (ratesSource === "position_prior") {
    warnings.push("no club rates row — position prior only (provenance tier cap applies)");
  } else if (priorOnlyFields.length) {
    warnings.push(`rates row missing per-stat fields (${priorOnlyFields.join(", ")}) — position prior for those`);
  }

  // ── Tournament accrual: WC matches at 3× club weight (spec §4.4), per
  // stat — the grader only writes fields it could grade, so blend sparsely.
  const acc = accrualFor(player);
  if (acc && acc.minutes > 0) {
    const nAcc = ACCRUAL_MATCH_WEIGHT * (acc.minutes / 90);
    const nBase = nClub + PRIOR_WEIGHT_MATCHES;
    for (const f of LAMBDA_FIELDS) {
      if (typeof acc[f] !== "number") continue;
      const accP90 = (acc[f] / acc.minutes) * 90;
      per90[f] = (nBase * per90[f] + nAcc * accP90) / (nBase + nAcc);
    }
  }
  const accrualTag = acc && acc.minutes > 0 ? "+wc_accrual" : "";

  // ── Expected minutes (spec §4.2; GK branch §10.3)
  let expectedMinutes = isGk ? EXP_MIN.gk_unknown : EXP_MIN.unknown;
  let minutesSource = isGk ? "gk_unknown" : "unknown";
  if (row && row.minutes > 0 && row.matches > 0) {
    const share = row.minutes / (row.matches * 90);
    if (isGk) {
      if (share >= 0.75) { expectedMinutes = EXP_MIN.gk_starter; minutesSource = "club_share_starter_gk"; }
      else { expectedMinutes = EXP_MIN.gk_unknown; minutesSource = "gk_rotation"; }
    } else if (share >= 0.75) { expectedMinutes = EXP_MIN.starter; minutesSource = "club_share_starter"; }
    else if (share >= 0.5) { expectedMinutes = EXP_MIN.rotation; minutesSource = "club_share_rotation"; }
    else { expectedMinutes = EXP_MIN.bench; minutesSource = "club_share_bench"; }
  } else {
    warnings.push(`no club minutes — expected minutes defaulted (${expectedMinutes})`);
  }

  // ── Per-stat environment multipliers from DK team totals (spec §10.1)
  let vegas = null;
  try { vegas = lookupVegas({ player, league: "WC" }); } catch { vegas = null; }
  const mu = meanTeamTotal();
  const hasVegas = vegas && typeof vegas.team_total === "number" && vegas.team_total > 0
    && typeof vegas.opp_total === "number" && vegas.opp_total > 0;
  if (!hasVegas) {
    vegas = null;
    warnings.push("no DK team total for player's match — environment factors = 1");
  }

  const minutesFactor = expectedMinutes / 90;
  // Minutes mixture for the projection tail (spec §4.2). Degenerate fallback
  // (unknown source) is a single scenario at the point → mixture == point.
  const minutesDist = MINUTES_DIST[minutesSource] ?? [{ minutes: expectedMinutes, p: 1 }];
  const lambda = {};
  const lambdaScenarios = {};
  const aOppByField = {};
  for (const f of LAMBDA_FIELDS) {
    const a = envFactor(f, vegas, mu);
    aOppByField[f] = Number(a.toFixed(4));
    lambda[f] = Number((per90[f] * minutesFactor * a).toFixed(4));
    // Per-field λ across the minutes scenarios — what projection.js mixes the
    // Poisson tail over. lambda[f] above stays the point/mean read (gate +
    // back-compat for fantasy components and telemetry).
    lambdaScenarios[f] = minutesDist.map((s) => ({
      lambda: Number((per90[f] * (s.minutes / 90) * a).toFixed(4)),
      p: s.p,
    }));
  }

  // ── Outfield Fantasy Score composite (spec §10.5): moment-match the
  // weighted component sum, upgrading market-anchored components to the DK
  // ladder's λ_fair when one covers the player.
  const fantasyLambda = { ...lambda };
  const anchored = [];
  for (const [f, statName] of Object.entries(MARKET_ANCHORED_COMPONENTS)) {
    let m = null;
    try { m = lookupMarket({ player, stat: statName, league: "WC" }); } catch { m = null; }
    if (m && typeof m.lambda_fair === "number" && m.lambda_fair > 0) {
      fantasyLambda[f] = m.lambda_fair;
      anchored.push(f);
    }
  }
  const phiPasses = WC_STAT_MODEL["Passes Attempted"]?.phi ?? 3.5;
  const fm = fantasyMoments(fantasyLambda, { phiPasses });
  if (fm) {
    lambda.fantasy = fm.mean;
  }

  const startMs = Date.parse(prop?.start_time ?? "");
  const knockout = Number.isFinite(startMs) ? startMs >= KNOCKOUT_FROM_MS : false;

  const groundTruth = {
    league: "WC",
    player,
    prop_type: null, // overwritten per-task by the analyze loop
    line: null,
    info: { full_name: player, position, team: prop?.player_team ?? null },
    game: {
      opponent: prop?.opponent ?? null,
      start_time: prop?.start_time ?? null,
      game_key: prop?.player_team && prop?.opponent ? `WC:${prop.opponent}@${prop.player_team}` : null,
      knockout,
      // Dead-rubber detection (group match 3 with nothing at stake) is a
      // planned enrichment via ESPN group standings — spec §6.3. Until then
      // the wc-context rule sees null and flags nothing.
      dead_rubber: null,
    },
    soccer: {
      rates: {
        // Kept by name for back-compat consumers/smokes; per90 carries all.
        shots_p90: Number(per90.shots.toFixed(4)),
        sot_p90: Number(per90.sot.toFixed(4)),
        per90: Object.fromEntries(LAMBDA_FIELDS.map((f) => [f, Number(per90[f].toFixed(4))])),
        source: ratesSource + accrualTag,
        prior_only_fields: priorOnlyFields,
        club_minutes: row?.minutes ?? null,
        club_matches: row?.matches ?? null,
        n_eff: Number((nClub + PRIOR_WEIGHT_MATCHES).toFixed(2)),
      },
      expected_minutes: expectedMinutes,
      minutes_source: minutesSource,
      starter_confirmed: null, // ESPN roster enrichment — follow-up
      lambda,
      // Per-field minutes mixture (spec §4.2) — projection.js integrates the
      // Poisson tail over these to get an overdispersed, minutes-aware P(over).
      lambda_scenarios: lambdaScenarios,
      minutes_dist: minutesDist,
      // Back-compat scalar: the shots-family multiplier (v1 consumers/
      // telemetry); a_opp_by_field carries the per-stat drivers (§10.1).
      a_opp: aOppByField.shots,
      a_opp_by_field: aOppByField,
      fantasy: fm
        ? { mean: fm.mean, sd: fm.sd, variance: fm.variance, anchored_components: anchored }
        : null,
      vegas: vegas ? { team_total: vegas.team_total, opp_total: vegas.opp_total, game_total: vegas.game_total, team_spread: vegas.team_spread } : null,
      accrual: acc ? { ...acc } : null,
    },
    data_warnings: warnings,
  };

  return {
    groundTruth,
    trace: { soccer_rates: groundTruth.soccer.rates.source, minutes: minutesSource, a_opp: aOppByField.shots },
    playerInfo: { league: "WC", team: prop?.player_team ?? null, position },
  };
}
