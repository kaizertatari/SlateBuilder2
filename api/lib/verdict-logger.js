// Fire-and-forget structured event sink. Three event shapes share one
// Axiom dataset, discriminated by `event_type`:
//   • "verdict" — every (player, prop, line) decision from analyze /
//     analyze-all (this is the main emit; logVerdict below).
//   • "outcome" — written by scripts/grade-outcomes.mjs after games
//     complete; carries the same join keys as the matching verdict plus
//     hit/miss/push/void.
//   • "log"    — non-verdict structured logs from the external-API libs
//     (logEvent below) so swallowed failures are queryable instead of
//     vanishing into Vercel Runtime Logs' 1-hour Hobby retention.
//
// No SDK — direct Axiom ingest API. No-ops when AXIOM_TOKEN is unset so
// local dev / unconfigured prod keep working. Network errors are caught;
// non-2xx responses (bad token, missing dataset) surface via console.warn
// so misconfiguration doesn't silently drop events.
//
// On Vercel Fluid Compute the dangling promise typically completes —
// instances stay warm across requests. Cold-instance shutdown can drop
// the occasional event; this is telemetry, not a write-once audit log.

import { getReqId } from "./request-context.js";
import { PROP_TO_FIELD } from "./prop-types.js";

const INGEST_URL_BASE = "https://api.axiom.co/v1/datasets";
const TIMEOUT_MS = 5000;

/**
 * Emit a structured verdict event. Pass whatever you have — missing pieces
 * become null, the event still ships.
 *
 * @param {Object} args
 * @param {Object} [args.input]        { player, propType, line }
 * @param {string} [args.oddsType]     "goblin" | "standard" | "demon" | null — the PrizePicks pricing tier the analyzed line came from
 * @param {Object} [args.result]       { verdict, tier, confidence, flags, overridden, override_reasons, pre_filtered }
 * @param {Object} [args.groundTruth]  raw groundTruth from gatherGroundTruth
 * @param {Object} [args.playerInfo]   resolved player identity { nba, espn, league, ... } from resolvePlayer
 * @param {Object} [args.trace]        the per-source provenance object built inside gatherGroundTruth (scoreboard/l5/splits/...)
 * @param {Object} [args.errorInfo]    { message, name, status } when an error path emitted instead of a verdict
 * @param {string} [args.source]       "analyze" | "analyze-all" — discriminator for cross-endpoint queries
 * @param {number} [args.durationMs]   wall-clock ms from request start to emit
 */
export function logVerdict({
  input,
  oddsType,
  result,
  groundTruth,
  playerInfo,
  trace,
  errorInfo,
  source,
  durationMs,
} = {}) {
  const token = process.env.AXIOM_TOKEN;
  if (!token) return;

  const stat = canonicalStat(input?.propType);
  const direction = directionOf(input?.propType);

  const event = {
    _time: new Date().toISOString(),
    event_type: "verdict",
    req_id: getReqId(),
    source: source ?? null,
    // Input + join keys (used by grade-outcomes to match verdicts ↔ outcomes)
    player: input?.player ?? null,
    prop_type: input?.propType ?? null,
    line: input?.line ?? null,
    // PrizePicks pricing tier: "goblin" | "standard" | "demon" | null.
    // Lowercased so Axiom dashboards can group cleanly; null for the
    // single-prop /api/analyze path where the caller doesn't supply one.
    odds_type: oddsType ? String(oddsType).toLowerCase() : null,
    direction,
    stat_field: stat ? (PROP_TO_FIELD[stat] ?? null) : null,
    // composeGroundTruth stores ESPN's full ISO timestamp under `game.date`
    // (see api/lib/ground-truth.js:64). Fall back to `start_time` for any
    // future change in the upstream field name.
    game_start_time: groundTruth?.game?.date ?? groundTruth?.game?.start_time ?? null,
    nba_id: playerInfo?.nba ?? groundTruth?.info?.player_id ?? null,
    espn_id: playerInfo?.espn ?? null,
    // Latency. No LLM provider/model fields on the engine-only branch.
    duration_ms: durationMs ?? null,
    // Identifies this branch's verdicts in cross-branch Axiom joins
    // (Testing/main still log llm_provider/llm_model; this branch logs
    // engine_mode="rules" instead).
    engine_mode: "rules",
    // Result
    verdict: result?.verdict ?? null,
    tier: result?.tier ?? null,
    confidence: result?.confidence ?? null,
    // Raw pre-snap engine score — null on pre-filtered SKIPs and on the
    // LLM branches (which don't compute it). Calibration uses it for a
    // finer reliability curve than the three post-snap tier bands.
    raw_score: result?.raw_score ?? null,
    // SHADOW (temporary) — the would-be tier under the score-driven
    // demote/SKIP fix; lets calibration-report size that change pre-ship.
    shadow_tier: result?.shadow_tier ?? null,
    // Stage-1 sharp-market signal (rule-market-edge). Null when odds didn't
    // cover this pick. Lets calibration slice hit rate by market agreement and
    // prove the standard-line lift. no_vig_prob is at the book line;
    // market_fair_at_line is shifted to the PrizePicks line for the bet side.
    no_vig_prob: result?.market?.no_vig_prob ?? null,
    market_fair_at_line: result?.market?.fair_at_line ?? null,
    market_line_delta: result?.market?.line_delta ?? null,
    market_edge: result?.market?.edge ?? null,
    // Stage-2 game-script context (rule-game-script). Null when odds didn't
    // cover the player's game. Lets calibration slice by scoring environment /
    // blowout. Log-only — do NOT add these to the _axiom.mjs query projection
    // until they've been ingested (Axiom's data-driven schema rejects unseen
    // fields), same caveat as the market_* fields above.
    game_total: result?.vegas?.game_total ?? null,
    team_total: result?.vegas?.team_total ?? null,
    team_spread: result?.vegas?.team_spread ?? null,
    vegas_blowout: result?.vegas?.blowout ?? null,
    // Stage-3 native model probability (rule-projection). Null without a
    // baseline. Lets calibration test the model standalone and whether
    // model+market agreement beats the market alone. Log-only — keep out of
    // the _axiom.mjs query projection until ingested.
    model_prob: result?.projection?.model_prob ?? null,
    model_dir_prob: result?.projection?.dir_prob ?? null,
    model_mean: result?.projection?.mean ?? null,
    model_sigma: result?.projection?.sigma ?? null,
    model_market_agree: result?.projection?.market_agree ?? null,
    // Stage-4 rest / schedule density (rule-rest). Null without gamelog dates.
    rest_days: result?.rest?.rest_days ?? null,
    back_to_back: result?.rest?.back_to_back ?? null,
    three_in_four: result?.rest?.three_in_four ?? null,
    flags: result?.flags ?? null,
    pre_filtered: !!result?.pre_filtered,
    // Engine: which rule modules contributed to the verdict. Empty array
    // when only the pre-filter fast-path ran (those use pre-filter:<reason>
    // form). Lets grade-outcomes attribute hit rate per rule.
    rules_fired: result?.rules_fired ?? null,
    // Error path (mutually exclusive with verdict)
    error: errorInfo?.message ?? null,
    error_name: errorInfo?.name ?? null,
    error_status: errorInfo?.status ?? null,
    // Source provenance — pass-through of gatherGroundTruth's `trace`.
    // Lets queries distinguish "framework SKIP'd correctly" from "infra
    // dropped a source so we couldn't apply a rule."
    trace: trace ?? null,
    // Slim ground truth — enough to filter by context without exporting
    // the whole blob. Add fields here as queries demand; resist shipping
    // everything (volume + token cost on Axiom's free tier).
    league: groundTruth?.league ?? null,
    season_avg: pickAvg(groundTruth?.season?.averages, input?.propType),
    l5_avg: pickAvg(groundTruth?.l5?.averages, input?.propType),
    l5_type: groundTruth?.l5?.type ?? null,
    l5_n: groundTruth?.l5?.n ?? null,
    // Move 2 — current-series mini-baseline (playoff_series mode only).
    // Lets grade-outcomes correlate hit rate against the blend ratio
    // (BLEND_CURRENT_SERIES_RATIO in weighted-l5.js) so we can recalibrate
    // from real outcomes per series-game-number.
    current_series_n: groundTruth?.l5?.weighted?.current_series_n ?? 0,
    current_series_avg: pickAvg(groundTruth?.l5?.weighted?.current_series_averages, input?.propType),
    l5_mode: groundTruth?.l5?.weighted?.mode ?? null,
    // Outlier-dampener provenance. `outlier_present` was previously only
    // consulted internally to widen the OVER buffer (and now to demote
    // UNDER tiers); surfacing it + the reference type lets calibration
    // queries correlate hit rate against L5 volatility and verify the
    // playoff-reference fix didn't over-trigger.
    outlier_present: !!groundTruth?.l5?.weighted?.outlier_present,
    outlier_ref_type: groundTruth?.l5?.weighted?.outlier_ref_type ?? null,
    // Drop-max trimmed baseline for the target field. Lets calibration
    // queries correlate hit rate against single-game-dependent picks
    // (where the trimmed mean diverges from the full weighted mean).
    trimmed_l5_avg: pickAvg(groundTruth?.l5?.weighted?.trimmed_averages, input?.propType),
    // Move 3 — regular-season H2H baseline. n=0 when playoff path or no
    // matchup history; non-zero only when current-season gamelog had
    // games against tonight's opponent. h2h_avg is null when the gate
    // (H2H_MIN_GAMES) isn't met OR the field doesn't apply to this stat.
    h2h_n: groundTruth?.h2h?.n ?? 0,
    h2h_avg: pickAvg(groundTruth?.h2h?.averages, input?.propType),
    season_ft_pct: groundTruth?.season?.averages?.ft_pct ?? null,
    home_away: groundTruth?.home_away ?? null,
    win_prob: groundTruth?.win_prob?.player_team_pct ?? null,
    opponent: groundTruth?.opponent_team?.abbr ?? null,
    def_rank: groundTruth?.opponent_defense?.def_rank ?? null,
    primary_defender: groundTruth?.opponent_defense?.primary_defender?.player ?? null,
    is_playoff: !!groundTruth?.series,
    series_round: groundTruth?.series?.round ?? null,
    game_number: groundTruth?.series?.next_game_number ?? null,
    days_out: groundTruth?.game?.days_out ?? null,
    is_listed_injured: !!groundTruth?.player_recent?.is_listed_injured,
    prior_season_baseline: !!(groundTruth?.season?.is_prior_season || groundTruth?.l5?.is_prior_season),
  };

  ingest(token, event);
}

/**
 * Emit a structured non-verdict event (external API failure, scrape
 * error, etc.). Same Axiom dataset, `event_type: "log"`. Fire-and-forget.
 *
 * @param {Object} args
 * @param {"warn"|"error"} args.level
 * @param {string} args.source  short identifier of the emitting subsystem (e.g., "nba-http", "espn", "balldontlie")
 * @param {string} args.message human-readable message
 * @param {string} [args.errorName]    e.g., "AbortError", "TypeError"
 * @param {number|string} [args.errorStatus] HTTP status or numeric error code, if known
 * @param {Object} [args.context]      arbitrary JSON-safe extras (url, player, season, ...)
 */
export function logEvent({ level, source, message, errorName, errorStatus, context } = {}) {
  const token = process.env.AXIOM_TOKEN;
  if (!token) return;

  const event = {
    _time: new Date().toISOString(),
    event_type: "log",
    req_id: getReqId(),
    level: level ?? "warn",
    source: source ?? null,
    message: message ?? null,
    error_name: errorName ?? null,
    error_status: errorStatus ?? null,
    context: context ?? null,
  };

  ingest(token, event);
}

// --- internals ------------------------------------------------------------

function ingest(token, event) {
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  // Dangling promise on purpose — do NOT await. Catch network errors so
  // they never escape as unhandled rejections; surface non-2xx responses
  // (bad token, missing dataset) as warnings so misconfiguration doesn't
  // silently drop events.
  fetch(`${INGEST_URL_BASE}/${encodeURIComponent(dataset)}/ingest`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([event]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[verdict-logger] axiom ingest HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    })
    .catch((err) => {
      console.warn(`[verdict-logger] axiom ingest failed: ${err.message}`);
    });
}

function canonicalStat(propType) {
  if (!propType) return null;
  return String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
}

function directionOf(propType) {
  if (!propType) return null;
  if (/\sUNDER\s*$/i.test(propType)) return "UNDER";
  if (/\sOVER\s*$/i.test(propType)) return "OVER";
  return null;
}

function pickAvg(averages, propType) {
  if (!averages || !propType) return null;
  const field = PROP_TO_FIELD[canonicalStat(propType)];
  return field ? (averages[field] ?? null) : null;
}
