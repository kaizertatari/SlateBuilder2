import { resolvePlayer } from "./_lib/player-ids.js";
import {
  currentSeason,
  priorSeasonLabel,
  getCommonPlayerInfo,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
} from "./_lib/nba-stats.js";
import * as bdl from "./_lib/balldontlie.js";
import * as espnStats from "./_lib/espn-stats.js";
import { getOpponentDefense, getDefRankByAbbr } from "./_lib/team-defense.js";
import { getPrimaryDefender } from "./_lib/matchup-defender.js";
import {
  getTodaysGames,
  findGameForTeamAbbr,
  findNextGameForTeamAbbr,
  getWinProbability,
  getAllInjuries,
  opponentFor,
} from "./_lib/espn.js";
import { composeGroundTruth } from "./_lib/ground-truth.js";
import { computeH2HAverages } from "./_lib/weighted-l5.js";
import { rateLimit } from "./_lib/rate-limit.js";
import { runWithRequestContext } from "./_lib/request-context.js";
import { PROP_TO_FIELD } from "./_lib/prop-types.js";
import { preFilterMechanical } from "./_lib/verdict-verifier.js";
import { applyEngine } from "./_lib/engine.js";
import { setOdds } from "./_lib/odds.js";
import { readOdds } from "./_lib/odds-store.js";
import { logVerdict } from "./_lib/verdict-logger.js";
import { randomUUID } from "node:crypto";
import * as bbref from "./_lib/bbref.js";
import {
  RateLimitError,
  createErrorResponse,
  isRetryableError,
  calculateBackoffDelay,
  sleep,
} from "./_lib/errors.js";

export const runtime = "nodejs";

/**
 * Gathers ground truth data for a player prop analysis.
 * Fetches data from multiple sources with fallback mechanisms.
 * @param {Object} params - The parameters for data gathering
 * @param {string} params.player - Player name
 * @param {string} params.propType - Prop type (e.g., "Points OVER")
 * @param {number} params.line - Prop line value
 * @returns {Promise<Object>} Ground truth data or skip reason
 */
// Exported for smoke testing — fetches real data and composes groundTruth
// without calling the LLM.
//
// teamAbbrHint: optional team abbreviation supplied by the caller. Used as
// the last-resort identity source when both balldontlie + stats edge fail
// (parallel 6-player UI fan-outs occasionally see both 8s-timeout out at
// once). analyze-all passes the player_team from the PrizePicks scrape,
// which is the same data we already have on hand and never times out.
// Stage 4b — enrich own-team OUT/DOUBTFUL injuries with the injured player's
// season ppg so mechanism 2 (teammate role compression / usage redistribution)
// can fire. ESPN's injury feed carries no scoring data, so mech2 never
// triggered in production. Best-effort, capped, parallel; mutates entries in
// place (composeGroundTruth slices the same objects). A failed/unknown lookup
// leaves season_ppg unset → that teammate just isn't counted, as before.
async function enrichInjuriesWithPpg(injuries, league, season) {
  if (!Array.isArray(injuries) || !injuries.length) return;
  const targets = injuries.filter((e) => {
    if (!e?.player || e.season_ppg != null || e.ppg != null) return false;
    const s = String(e.status || "").toUpperCase();
    return s.includes("OUT") || s.includes("DOUBTFUL");
  }).slice(0, 6);
  await Promise.all(targets.map(async (e) => {
    try {
      const espnId = resolvePlayer(e.player)?.espn;
      if (!espnId) return;
      const avg = await espnStats.getSeasonAverages(espnId, { season, league });
      if (avg?.ppg != null) e.season_ppg = avg.ppg;
    } catch { /* best-effort enrichment */ }
  }));
}

export async function gatherGroundTruth({ player, propType, line, teamAbbrHint = null }) {
  const playerInfo = resolvePlayer(player);
  if (!playerInfo) {
    return { skipReason: "player_not_configured", message: `No player entry for ${player}` };
  }
  // NBA requires a stats.nba.com PERSON_ID (the BR/ESPN paths alone don't
  // cover defender matchups). WNBA can run on ESPN alone — stats.wnba.com is
  // best-effort enrichment, not a hard dependency.
  const league = playerInfo.league;
  if (league === "NBA" && !playerInfo.nba) {
    return { skipReason: "player_not_configured", message: `No PlayerID configured for ${player}` };
  }
  if (league === "WNBA" && !playerInfo.espn) {
    return { skipReason: "player_not_configured", message: `No ESPN ID configured for WNBA player ${player}` };
  }
  const playerId = playerInfo.nba;
  const espnId = playerInfo.espn;

  const season = currentSeason(new Date(), league);

  // Identity: balldontlie is NBA-only, so the bdl branch is gated on league.
  // For WNBA we go straight to stats.wnba.com commonplayerinfo — WNBA traffic
  // is lower and the Vercel-IP throttling pattern is less severe.
  const [bdlPlayer, games, allInjuries] = await Promise.all([
    league === "NBA" ? bdl.findPlayer(player) : Promise.resolve(null),
    getTodaysGames(undefined, { league }),
    getAllInjuries({ league }),
  ]);

  if (!games) return { skipReason: "schedule_unavailable", message: "Could not fetch ESPN scoreboard" };

  let info = null;
  let infoSource = null;
  if (bdlPlayer?.team_abbr) {
    info = {
      player_id: playerId,
      full_name: bdlPlayer.full_name,
      team_id: null,
      team_name: bdlPlayer.team_name,
      team_abbr: bdlPlayer.team_abbr,
    };
    infoSource = "balldontlie";
  } else {
    const nbaInfo = playerId ? await getCommonPlayerInfo(playerId, { league }) : null;
    if (nbaInfo) {
      info = nbaInfo;
      infoSource = league === "NBA" ? "nba_stats" : "wnba_stats";
    } else if (league === "WNBA" && playerInfo.team_abbr) {
      // WNBA fallback: refresh-wnba-players embeds team_abbr from the most
      // recent box score. stats.wnba.com is best-effort, so without this
      // every WNBA pick would SKIP when that edge throttles.
      info = {
        player_id: null,
        full_name: player,
        team_id: null,
        team_name: null,
        team_abbr: playerInfo.team_abbr,
      };
      infoSource = "players_json";
    } else if (teamAbbrHint) {
      // Caller-supplied team abbr — typically the PrizePicks scrape's
      // player_team. Used when bdl + stats edge both timed out under
      // parallel load. Trusts the scrape because it published the prop
      // with this team in the same request flow.
      info = {
        player_id: playerId,
        full_name: player,
        team_id: null,
        team_name: null,
        team_abbr: teamAbbrHint,
      };
      infoSource = "prizepicks_hint";
    } else {
      return { skipReason: "player_lookup_failed", message: `Could not resolve ${player} via balldontlie, stats edge, or players.json` };
    }
  }

  const trace = {
    scoreboard: "espn",
    injuries: allInjuries ? "espn" : "missing",
    info: infoSource,
  };

  let game = findGameForTeamAbbr(games, info.team_abbr, { league });
  let daysOut = 0;
  if (!game) {
    const next = await findNextGameForTeamAbbr(info.team_abbr, 7, { league });
    if (!next) return { skipReason: "no_upcoming_game", message: `${info.team_name ?? info.team_abbr} has no game in the next 7 days` };
    game = next.game;
    daysOut = next.days_out;
  }
  trace.game = daysOut === 0 ? "espn_today" : "espn_lookahead";

  // Season type is decided by the ESPN scoreboard event, not by which gamelog
  // tier returned data. Otherwise a transient playoff-tier failure would
  // silently mislabel a playoff game as regular season. Require an explicit
  // playoff series.type — game.round alone (a competition-type abbreviation)
  // misfires on regular-season events that carry a non-null round string.
  const isPlayoff = game.series?.type === "playoff";
  const seasonType = isPlayoff ? "Playoffs" : "Regular Season";
  // ESPN primary, stats.nba.com fallback. Vercel egress IPs are throttled by
  // stats.nba.com, so the NBA path is unreliable — try ESPN first when an
  // espnId is configured.
  let l5 = espnId
    ? await espnStats.getLastNGames(espnId, 5, { season, postseason: isPlayoff, league })
    : null;
  trace.l5 = l5?.games?.length ? "espn_gamelog" : null;
  // WNBA early-playoff: if the playoff gamelog is empty (G1 not yet logged),
  // retry against current-season regular-season games before falling through
  // to stats edge. Stays in 2026 — no prior-season carry-over.
  if (!trace.l5 && league === "WNBA" && isPlayoff && espnId) {
    const reg = await espnStats.getLastNGames(espnId, 5, { season, postseason: false, league });
    if (reg?.games?.length) {
      l5 = reg;
      trace.l5 = "espn_gamelog_regular_fallback";
    }
  }
  if (!trace.l5) {
    l5 = await getLastNGames(playerId, 5, { seasonType, league });
    trace.l5 = l5?.games?.length ? "stats_edge" : null;
  }
  // Opening-day cliff: NBA early October only. WNBA intentionally skips the
  // prior-season carry-over so a 2-game 2026 sample stays a 2-game sample —
  // computeWeightedL5 renormalizes the recency ramp over however many games
  // exist. For NBA, pull the prior season's most-recent regular-season games
  // and tag the result so composeGroundTruth surfaces a data_warnings entry.
  if (!l5?.games?.length && league !== "WNBA") {
    const priorSeason = priorSeasonLabel(season, league);
    if (priorSeason && espnId) {
      const fb = await espnStats.getLastNGames(espnId, 5, { season: priorSeason, postseason: false, league });
      if (fb?.games?.length) {
        l5 = { ...fb, is_prior_season: true };
        trace.l5 = "espn_gamelog_prior";
      }
    }
  }
  if (!l5?.games?.length) {
    trace.l5 = "missing";
    if (league === "WNBA") {
      return { skipReason: "no_current_season_games", message: `${player} has no games in the current WNBA season` };
    }
  }

  // Splits and opponent defense use regular season — playoff samples are too
  // small to be a stable baseline. Same logic as Rule 5a road deduction.
  const opponentSide = opponentFor(game, info.team_abbr, { league });
  // Stage 4b — the player's own game side (whichever isn't the opponent), used
  // to locate own-team injuries for ppg enrichment (revives mechanism 2).
  const playerSide = (opponentSide && game.home && game.away)
    ? (String(game.home.team_id) === String(opponentSide.team_id) ? game.away : game.home)
    : null;
  const ownInjuryList = playerSide?.team_id != null
    ? (allInjuries?.find((g) => String(g.team_id) === String(playerSide.team_id))?.injuries ?? [])
    : [];
  // BR snapshot primary for splits (Vercel egress is throttled by stats edge,
  // and the BR file is on disk so it never times out). Stats edge stays on
  // the critical path only when the player isn't in the snapshot.
  const bbrefSplits = bbref.getHomeAwaySplits(player, { season, league });
  // ESPN primary for season averages; stats-edge fallback below. Defender
  // and matchup data have no ESPN equivalent and stay on stats edge.
  //
  // h2hGamelog: Move-3 input. Fetched only for regular-season games when
  // both espnId and opponent are known. Pulls last 50 reg-season games
  // (enough to cover the full season for an active player) so the H2H
  // filter has the deepest sample possible. Skipped on playoff games —
  // that path uses the current-series blend instead.
  const needsH2H = !isPlayoff && espnId && opponentSide;
  const [espnSeasonAvg, statsSplits, winProb, opponentDefense, primaryDefender, defRankByAbbr, h2hGamelog, playoffExtended] = await Promise.all([
    espnId ? espnStats.getSeasonAverages(espnId, { season, league }) : null,
    bbrefSplits ? null : getHomeAwaySplits(playerId, { seasonType: "Regular Season", league }),
    getWinProbability(game.game_id, game.competition_id, { league }),
    opponentSide ? getOpponentDefense(opponentSide.abbr, { seasonType: "Regular Season", league }) : null,
    opponentSide ? getPrimaryDefender(playerId, opponentSide.abbr, { seasonType, league }) : null,
    // v3.5 weighted-L5 reads per-game opponent quality from the
    // current-season def-rank snapshot (per-game historical lookup is a
    // deliberate spec limitation). Failures degrade gracefully — without
    // the map, weighted-L5 uses the 1.0 default multiplier.
    getDefRankByAbbr({ seasonType: "Regular Season", league }).catch(() => null),
    needsH2H
      ? espnStats.getLastNGames(espnId, 50, { season, postseason: false, league }).catch(() => null)
      : null,
    // Stage 4 — extended postseason window for the variance block (real σ).
    // Regular-season picks reuse the 50-game H2H pull above; playoff games
    // fetch their own postseason window (H2H isn't fetched there).
    (isPlayoff && espnId)
      ? espnStats.getLastNGames(espnId, 20, { season, postseason: true, league }).catch(() => null)
      : null,
    // Stage 4b — enrich own-team injuries with season ppg in parallel (mutates
    // ownInjuryList entries in place; result slot intentionally unused).
    enrichInjuriesWithPpg(ownInjuryList, league, season),
  ]);
  const splits = bbrefSplits ?? statsSplits;
  trace.splits = bbrefSplits ? "bbref_snapshot" : (statsSplits ? "stats_edge" : "missing");
  trace.win_prob = winProb ? `espn_${winProb.source}` : "missing";
  trace.opponent_defense = opponentDefense ? `team_defense_${opponentDefense.source}` : "missing";
  trace.primary_defender = primaryDefender ? primaryDefender.source : "missing";

  let seasonAvg = espnSeasonAvg ?? await getSeasonAverages(playerId, { seasonType: "Regular Season", league });
  trace.season_avg = espnSeasonAvg ? "espn_gamelog" : (seasonAvg ? "stats_edge" : null);
  // Same opening-day fallback as L5: NBA-only. WNBA short-circuits earlier
  // when L5 is empty, and falling back to 2025 averages here would
  // contradict the no-carry-over policy for any WNBA player who has L5
  // games but a missing aggregate.
  if (!seasonAvg && league !== "WNBA") {
    const priorSeason = priorSeasonLabel(season, league);
    if (priorSeason && espnId) {
      const fb = await espnStats.getSeasonAverages(espnId, { season: priorSeason, league });
      if (fb) {
        seasonAvg = { ...fb, is_prior_season: true };
        trace.season_avg = "espn_gamelog_prior";
      }
    }
  }
  if (!seasonAvg) trace.season_avg = "missing";

  // Move 3 — derive H2H baseline from the season gamelog. Null when:
  //   • Playoff path (needsH2H was false)
  //   • Gamelog fetch failed or returned empty
  //   • No games match the current opponent
  //   • Opponent abbr unknown
  // computeH2HAverages does NOT enforce the min-games gate — that's
  // applied in computeOverBufferCheck so the telemetry sees n=1 events
  // (informative even when the blend doesn't fire).
  const h2h = h2hGamelog?.games?.length
    ? computeH2HAverages({
        games: h2hGamelog.games,
        ownAbbr: info?.team_abbr,
        opponentAbbr: opponentSide?.abbr,
      })
    : null;
  trace.h2h = (h2h && h2h.n > 0) ? `espn_gamelog(n=${h2h.n})` : (needsH2H ? "no_matches" : "n/a_playoff");

  // Stage 4 — longest gamelog available for this pick: the 50-game H2H pull
  // (regular season) or the 20-game postseason pull. Feeds the variance block
  // (real σ → projection + Rule 5a) and the rest/B2B block in composeGroundTruth.
  const extendedGames = h2hGamelog?.games?.length ? h2hGamelog.games
    : playoffExtended?.games?.length ? playoffExtended.games
    : null;
  trace.extended_games = extendedGames?.length ?? 0;

  const { groundTruth, missing } = composeGroundTruth({
    player, propType, line, league,
    info, game, daysOut, seasonType,
    seasonAvg, l5, splits, winProb, allInjuries, opponentDefense, primaryDefender,
    defRankByAbbr,
    h2h,
    extendedGames,
  });

   return { groundTruth, missing, trace, playerInfo };
 }

/**
 * Gathers ground truth data with retry logic for transient failures.
 * Wraps gatherGroundTruth with retry mechanism for external API calls.
 * @param {Object} params - The parameters for data gathering
 * @param {string} params.player - Player name
 * @param {string} params.propType - Prop type (e.g., "Points OVER")
 * @param {number} params.line - Prop line value
 * @returns {Promise<Object>} Ground truth data or skip reason
 */
// skipReasons that indicate a transient upstream blip — typically an
// upstream fetch (ESPN scoreboard, ESPN gamelog, balldontlie, stats edge)
// that crossed an 8s timeout under parallel load. gatherGroundTruth
// catches its own errors and returns these instead of throwing, so the
// exception-only retry loop alone never recovers them.
//
// - schedule_unavailable: ESPN scoreboard fetch returned null.
// - player_lookup_failed: balldontlie + stats edge BOTH returned no
//   team_abbr (NBA path). At least one is a transient class.
// - no_current_season_games: WNBA gamelog returned empty. Genuinely
//   persistent in early WNBA season, but the same skipReason also fires
//   when ESPN gamelog times out — worth one retry.
//
// Persistent skips (player_not_configured, no_upcoming_game) stay in the
// no-retry path so we don't waste time on definitive misses.
const RETRIABLE_SKIP_REASONS = new Set([
  "schedule_unavailable",
  "player_lookup_failed",
  "no_current_season_games",
]);

export async function gatherGroundTruthWithRetry(
  { player, propType, line, teamAbbrHint = null },
  { maxRetries = 3, baseDelayMs = 1000 } = {}
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await gatherGroundTruth({ player, propType, line, teamAbbrHint });

      if (result.skipReason) {
        // Retry transient skips while attempts remain; otherwise return.
        const isTransient = RETRIABLE_SKIP_REASONS.has(result.skipReason);
        if (isTransient && attempt < maxRetries) {
          await sleep(calculateBackoffDelay(attempt, baseDelayMs));
          continue;
        }
        return result;
      }

      return result;
    } catch (error) {
      // If this is the last attempt, don't retry
      if (attempt === maxRetries) {
        throw error;
      }

      // Check if the error is retryable
      if (!isRetryableError(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await sleep(calculateBackoffDelay(attempt, baseDelayMs));
    }
  }
}

 export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req));
}

/**
 * Handles POST requests to the analyze endpoint.
 * Validates input, applies rate limiting, gathers ground truth data,
 * and applies the deterministic v3.5 engine for prop analysis.
 * @param {Request} req - The HTTP request object
 * @returns {Promise<Response>} JSON response with analysis results or error
 */
async function handlePost(req) {
  // duration_ms in verdict events is measured from here so it covers
  // ground-truth fetch + pre-filter + engine — i.e., what the user
  // actually waited for.
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    // Extract and sanitize client IP for rate limiting
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    // Apply rate limiting: configurable requests per window per IP
    const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
    const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10', 10);
    const limit = rateLimit(`analyze:${ip}`, { windowMs: rateLimitWindowMs, max: rateLimitMaxRequests });
    if (!limit.ok) {
      const retryAfterMs = limit.retryAfterMs || rateLimitWindowMs;
      return createErrorResponse(new RateLimitError(
        "Rate limit exceeded. Try again shortly.",
        retryAfterMs
      ));
    }

    // Parse and validate request
    const validationResult = await parseAndValidateRequest(req);
    if (validationResult.isError) {
      return validationResult.response;
    }
    const { player, propType, line } = validationResult.data;

    // Warm the sharp-odds store from the blob (falls back to the bundled
    // data/odds.json) so the Stage 1–3 market rules price against the
    // freshest snapshot instead of the deploy-time bundle. Mirrors
    // build-slate / analyze-all.
    setOdds(await readOdds());

    // Gather ground truth data from various sources with retry logic
    const gathered = await gatherGroundTruthWithRetry({ player, propType, line });

    // Handle SKIP conditions from data gathering
    if (gathered.skipReason) {
      const skip = skipResult(gathered.skipReason, gathered.message);
      logVerdict({
        source: "analyze",
        input: { player, propType, line },
        result: skip,
        durationMs: elapsed(),
      });
      return Response.json(skip);
    }

    const { groundTruth, missing, trace, playerInfo } = gathered;

    // Check for missing required data
    if (missing.length > 0) {
      logVerdict({
        source: "analyze",
        input: { player, propType, line },
        result: { verdict: "SKIP", tier: "SKIP", flags: missing.map((f) => `missing: ${f}`) },
        groundTruth,
        playerInfo,
        trace,
        durationMs: elapsed(),
      });
      return createMissingDataResponse(missing, trace);
    }

    // Pre-engine mechanical filter. Short-circuits to SKIP when the
    // framework's arithmetic hard-gates already force it — saves engine
    // setup. Shares the same helpers as the engine, so the fast-path and
    // the engine can never disagree.
    const direction = /OVER/i.test(propType) ? "OVER" : "UNDER";
    const statType = String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
    const preSkip = preFilterMechanical({
      groundTruth,
      statType,
      direction,
      line,
    });
    if (preSkip) {
      logVerdict({
        source: "analyze",
        input: { player, propType, line },
        result: preSkip,
        groundTruth,
        playerInfo,
        trace,
        durationMs: elapsed(),
      });
      return createSuccessResponse(preSkip, groundTruth);
    }

    // Engine-only mode (experiment branch): apply the v3.5 framework
    // deterministically. The LLM path is intentionally removed on this
    // branch — see `experiment/no-llm-engine` plan + verdict-logger's
    // engine_mode field.
    const engineResult = applyEngine({ groundTruth, statType, direction, line });

    logVerdict({
      source: "analyze",
      input: { player, propType, line },
      result: engineResult,
      groundTruth,
      playerInfo,
      trace,
      durationMs: elapsed(),
    });
    return createSuccessResponse(engineResult, groundTruth);
  } catch (error) {
    // Handle unexpected errors with proper error categorization
    logVerdict({
      source: "analyze",
      errorInfo: { message: error.message, name: error.name, status: error.status ?? 500 },
      durationMs: elapsed(),
    });
    return createErrorResponse(error);
  }
}

/**
 * Creates a successful response with the engine's verdict object plus
 * the ground truth used to derive it. The frontend renders verdict /
 * tier / confidence / flags / justification; ground_truth is included
 * for inspection and debugging.
 *
 * @param {Object} verdictData - { verdict, tier, confidence, flags, justification, rules_fired }
 * @param {Object} groundTruth - composed ground truth
 * @returns {Response}
 */
function createSuccessResponse(verdictData, groundTruth) {
  return Response.json({ ...verdictData, ground_truth: groundTruth });
}



/**
 * Parses and validates the request body.
 * @param {Request} req - The HTTP request object
 * @returns {{isError: boolean, response?: Response, data?: {player: string, propType: string, line: number}}}
 */
async function parseAndValidateRequest(req) {
  // Parse request body
  const body = await req.json();
  const { player, propType, line } = body;

  // Validate required fields. `line` must be a finite number (or numeric
  // string) — a bare truthiness check would reject a legitimate 0 and let
  // non-numeric strings flow into the engine's comparisons.
  const numericLine = Number(line);
  if (!player || !propType || line == null || line === "" || !Number.isFinite(numericLine)) {
    return {
      isError: true,
      response: Response.json({ error: "Missing required fields" }, { status: 400 })
    };
  }

  // Validate prop type format (must end with OVER or UNDER)
  if (!/\s+(OVER|UNDER)\s*$/i.test(propType) || propTypeToField(propType) == null) {
    return {
      isError: true,
      response: Response.json(
        {
          error: `Unknown prop type: "${propType}". Supported: ${Object.keys(PROP_TO_FIELD).map((k) => `${k} OVER/UNDER`).join(", ")}`,
        },
        { status: 400 }
      )
    };
  }

  return {
    isError: false,
    data: { player, propType, line: numericLine }
  };
}

/**
 * Creates a missing data response.
 * @param {Array<string>} missing - Array of missing data fields
 * @param {Object} trace - Trace object showing data sources
 * @returns {Response} JSON response with missing data error
 */
function createMissingDataResponse(missing, trace) {
  const traceFlags = Object.entries(trace || {})
    .filter(([, v]) => v === "missing")
    .map(([k]) => `📡 source: ${k} → all tiers null`);
  return Response.json({
    verdict: "SKIP",
    tier: "SKIP",
    confidence: 0,
    justification: `Missing required data: ${missing.join(", ")}. Cannot apply framework.`,
    flags: [...missing.map((f) => `⚠️ missing: ${f}`), ...traceFlags],
    data_used: null,
    ground_truth: null, // We don't have ground truth when data is missing
  });
}

/**
 * Creates a standardized SKIP response for when analysis cannot proceed.
 * @param {string} code - The skip reason code
 * @param {string} message - Human-readable explanation for the skip
 * @returns {Object} Standardized skip response object
 */
function skipResult(code, message) {
  return {
    verdict: "SKIP",
    tier: "SKIP",
    confidence: 0,
    justification: message,
    flags: [`⚠️ ${code}`],
    data_used: null,
  };
}

/**
 * Converts a prop type string to its corresponding field name.
 * Extracts the stat name from prop types like "Points OVER" or "Rebounds UNDER".
 * @param {string} propType - Prop type string (e.g., "Points OVER")
 * @returns {string|null} Field name or null if invalid prop type
 */
export function propTypeToField(propType) {
  // propType examples: "Points OVER", "Rebounds UNDER", "3-Pointers Made OVER"
  const stat = String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
  return PROP_TO_FIELD[stat] ?? null;
}
