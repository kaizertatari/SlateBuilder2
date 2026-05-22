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
 * @param {string} [args.llmProvider]  "groq" | "gemini" | null (null for pre-filtered SKIPs)
 * @param {string} [args.llmModel]     concrete model id (e.g. "llama-3.3-70b-versatile") | null
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
  const dataset = process.env.AXIOM_DATASET || "props-verdicts";
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
