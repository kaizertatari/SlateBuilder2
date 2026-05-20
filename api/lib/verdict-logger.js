// Fire-and-forget structured event sink for analyze verdicts.
//
// Emits one JSON event per (player, prop, line) decision — enough fields
// to answer "show me all SKIPs with R9 flag on non-assist props" without
// shipping full ground truth. Targets Axiom's direct ingest API so we
// don't grow the dependency tree (no SDK).
//
// No-ops when AXIOM_TOKEN is unset, so local dev and unconfigured prod
// keep working. Errors are caught and surfaced via console.warn — they
// never propagate as unhandled rejections or affect the response.
//
// On Vercel Fluid Compute the dangling promise is typically completed
// because instances stay warm across requests. Cold-instance shutdown can
// drop the occasional event; this is telemetry, not a write-once audit
// log, and that trade-off is intentional.

import { getReqId } from "./request-context.js";
import { PROP_TO_FIELD } from "./prop-types.js";

const INGEST_URL_BASE = "https://api.axiom.co/v1/datasets";
const TIMEOUT_MS = 2000;

/**
 * Emit a structured verdict event. Pass whatever you have — missing pieces
 * become null, the event still ships.
 *
 * @param {Object} args
 * @param {Object} [args.input]        { player, propType, line }
 * @param {Object} [args.result]       { verdict, tier, confidence, flags, overridden, override_reasons, pre_filtered }
 * @param {Object} [args.groundTruth]  raw groundTruth from gatherGroundTruth
 * @param {Object} [args.errorInfo]    { message, name, status } when an error path emitted instead of a verdict
 * @param {string} [args.source]       "analyze" | "analyze-all" — discriminator for cross-endpoint queries
 */
export function logVerdict({ input, result, groundTruth, errorInfo, source } = {}) {
  const token = process.env.AXIOM_TOKEN;
  if (!token) return;
  const dataset = process.env.AXIOM_DATASET || "props-verdicts";

  const event = {
    _time: new Date().toISOString(),
    req_id: getReqId(),
    source: source ?? null,
    // Input
    player: input?.player ?? null,
    prop_type: input?.propType ?? null,
    line: input?.line ?? null,
    // Result
    verdict: result?.verdict ?? null,
    tier: result?.tier ?? null,
    confidence: result?.confidence ?? null,
    flags: result?.flags ?? null,
    overridden: !!result?.overridden,
    override_reasons: result?.override_reasons ?? null,
    pre_filtered: !!result?.pre_filtered,
    // Error path (mutually exclusive with verdict)
    error: errorInfo?.message ?? null,
    error_name: errorInfo?.name ?? null,
    error_status: errorInfo?.status ?? null,
    // Slim ground truth — enough to filter by context without exporting the
    // whole blob. Add fields here as queries demand; resist the urge to ship
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

function pickAvg(averages, propType) {
  if (!averages || !propType) return null;
  const stat = String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
  const field = PROP_TO_FIELD[stat];
  return field ? (averages[field] ?? null) : null;
}
