// World Cup (soccer) ground-truth composer — WC_FRAMEWORK_SPEC.md §4.
//
// The basketball gatherer (api/analyze.js) leans on ESPN/NBA-stats gamelogs;
// none of that exists for national teams. Soccer ground truth is composed
// from what the pipeline already has on hand:
//
//   • the PrizePicks prop row (team country, opponent, position, kickoff)
//   • data/soccer-rates.json — club per-90 priors (FBref snapshot)
//   • data/soccer-accrual.json — tournament-to-date actuals (grader-written)
//   • the runtime odds store — DK team totals = market expected goals (A_opp)
//
// λ_model = r_p90 × (E[min]/90) × A_opp, per stat. All parameters initial
// values per spec §7 — recalibrate from graded group-stage outcomes.
//
// Pure-ish: reads local JSON snapshots + the in-process odds store. No
// network calls (ESPN starter confirmation is a planned enrichment).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "./string-utils.js";
import { lookupVegas, loadOdds } from "./odds.js";

// Per-90 position priors (PrizePicks position vocabulary). SOT ≈ 0.36×shots.
// Initial values from public per-90 distributions; spec §4.1.
const POSITION_PRIORS = {
  Attacker: { shots: 2.4, sot: 0.86 },
  Forward: { shots: 2.4, sot: 0.86 }, // alias, in case PP varies the label
  Midfielder: { shots: 1.2, sot: 0.43 },
  Defender: { shots: 0.5, sot: 0.18 },
  Goalkeeper: { shots: 0.05, sot: 0.02 },
};
const PRIOR_WEIGHT_MATCHES = 5; // n₀ — shrinkage weight of the position prior
const CLUB_N_CAP = 25; // club sample influence cap (≈ a half season)
const ACCRUAL_MATCH_WEIGHT = 3; // a WC match counts 3× a club match (spec §4.4)

// Expected minutes model (spec §4.2). Confirmed-starter enrichment (ESPN
// rosters ~1h pre-kickoff) is a follow-up; v1 works off club minutes share.
const EXP_MIN = { starter: 78, rotation: 55, bench: 25, unknown: 55 };

// 2026 format: group stage ends 2026-06-27; from the Round of 32 on,
// PrizePicks settles on 90' + stoppage ONLY (extra time excluded).
const KNOCKOUT_FROM_MS = Date.parse("2026-06-28T00:00:00Z");

// Opponent/environment adjustment (spec §4.3): goals→shots elasticity.
const A_OPP_EXPONENT = 0.6;
const A_OPP_CLAMP = [0.75, 1.3];
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

  // ── Rate prior: club per-90 shrunk toward the position prior (spec §4.1)
  const row = ratesFor(player);
  let nClub = 0;
  let shotsP90 = prior.shots;
  let sotP90 = prior.sot;
  let ratesSource = "position_prior";
  if (row && typeof row.shots_p90 === "number") {
    nClub = Math.min((row.minutes ?? 0) / 90, CLUB_N_CAP);
    shotsP90 = (nClub * row.shots_p90 + PRIOR_WEIGHT_MATCHES * prior.shots) / (nClub + PRIOR_WEIGHT_MATCHES);
    sotP90 = (nClub * (row.sot_p90 ?? row.shots_p90 * 0.36) + PRIOR_WEIGHT_MATCHES * prior.sot) / (nClub + PRIOR_WEIGHT_MATCHES);
    ratesSource = "fbref_blend";
  } else {
    warnings.push("no club rates row — position prior only (provenance tier cap applies)");
  }

  // ── Tournament accrual: WC matches at 3× club weight (spec §4.4)
  const acc = accrualFor(player);
  if (acc && acc.minutes > 0) {
    const nAcc = ACCRUAL_MATCH_WEIGHT * (acc.minutes / 90);
    const accShotsP90 = (acc.shots / acc.minutes) * 90;
    const accSotP90 = (acc.sot / acc.minutes) * 90;
    const nBase = nClub + PRIOR_WEIGHT_MATCHES;
    shotsP90 = (nBase * shotsP90 + nAcc * accShotsP90) / (nBase + nAcc);
    sotP90 = (nBase * sotP90 + nAcc * accSotP90) / (nBase + nAcc);
    ratesSource += "+wc_accrual";
  }

  // ── Expected minutes (spec §4.2)
  let expectedMinutes = EXP_MIN.unknown;
  let minutesSource = "unknown";
  if (row && row.minutes > 0 && row.matches > 0) {
    const share = row.minutes / (row.matches * 90);
    if (share >= 0.75) { expectedMinutes = EXP_MIN.starter; minutesSource = "club_share_starter"; }
    else if (share >= 0.5) { expectedMinutes = EXP_MIN.rotation; minutesSource = "club_share_rotation"; }
    else { expectedMinutes = EXP_MIN.bench; minutesSource = "club_share_bench"; }
  } else {
    warnings.push("no club minutes — expected minutes defaulted (55)");
  }

  // ── Opponent/environment multiplier from DK team totals (spec §4.3)
  let aOpp = 1;
  let vegas = null;
  try { vegas = lookupVegas({ player, league: "WC" }); } catch { vegas = null; }
  if (vegas && typeof vegas.team_total === "number" && vegas.team_total > 0) {
    const mu = meanTeamTotal();
    aOpp = Math.pow(vegas.team_total / mu, A_OPP_EXPONENT);
    aOpp = Math.max(A_OPP_CLAMP[0], Math.min(A_OPP_CLAMP[1], aOpp));
  } else {
    warnings.push("no DK team total for player's match — A_opp = 1");
  }

  const minutesFactor = expectedMinutes / 90;
  const lambda = {
    shots: Number((shotsP90 * minutesFactor * aOpp).toFixed(4)),
    sot: Number((sotP90 * minutesFactor * aOpp).toFixed(4)),
  };

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
        shots_p90: Number(shotsP90.toFixed(4)),
        sot_p90: Number(sotP90.toFixed(4)),
        source: ratesSource,
        club_minutes: row?.minutes ?? null,
        club_matches: row?.matches ?? null,
        n_eff: Number((nClub + PRIOR_WEIGHT_MATCHES).toFixed(2)),
      },
      expected_minutes: expectedMinutes,
      minutes_source: minutesSource,
      starter_confirmed: null, // ESPN roster enrichment — follow-up
      lambda,
      a_opp: Number(aOpp.toFixed(4)),
      vegas: vegas ? { team_total: vegas.team_total, opp_total: vegas.opp_total, game_total: vegas.game_total, team_spread: vegas.team_spread } : null,
      accrual: acc ? { matches: acc.matches ?? null, minutes: acc.minutes, shots: acc.shots, sot: acc.sot } : null,
    },
    data_warnings: warnings,
  };

  return {
    groundTruth,
    trace: { soccer_rates: ratesSource, minutes: minutesSource, a_opp: aOpp },
    playerInfo: { league: "WC", team: prop?.player_team ?? null, position },
  };
}
