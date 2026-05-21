import { resolvePlayer } from "./lib/player-ids.js";
import {
  currentSeason,
  priorSeasonLabel,
  getCommonPlayerInfo,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
} from "./lib/nba-stats.js";
import * as bdl from "./lib/balldontlie.js";
import * as espnStats from "./lib/espn-stats.js";
import { getOpponentDefense, getDefRankByAbbr } from "./lib/team-defense.js";
import { getPrimaryDefender } from "./lib/matchup-defender.js";
import {
  getTodaysGames,
  findGameForTeamAbbr,
  findNextGameForTeamAbbr,
  getWinProbability,
  getAllInjuries,
  opponentFor,
} from "./lib/espn.js";
import { composeGroundTruth } from "./lib/ground-truth.js";
import { getFramework } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { PROP_TO_FIELD } from "./lib/prop-types.js";
import { verifyVerdict, preFilterMechanical } from "./lib/verdict-verifier.js";
import { logVerdict } from "./lib/verdict-logger.js";
import { randomUUID } from "node:crypto";
import * as bbref from "./lib/bbref.js";
import {
  ConfigurationError,
  RateLimitError,
  createErrorResponse,
  isRetryableError,
  calculateBackoffDelay,
} from "./lib/errors.js";

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
export async function gatherGroundTruth({ player, propType, line }) {
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
  // silently mislabel a playoff game as regular season.
  const isPlayoff = !!(game.series || game.round);
  const seasonType = isPlayoff ? "Playoffs" : "Regular Season";
  // ESPN primary, stats.nba.com fallback. Vercel egress IPs are throttled by
  // stats.nba.com, so the NBA path is unreliable — try ESPN first when an
  // espnId is configured.
  let l5 = espnId
    ? await espnStats.getLastNGames(espnId, 5, { season, postseason: isPlayoff, league })
    : null;
  trace.l5 = l5?.games?.length ? "espn_gamelog" : null;
  if (!trace.l5) {
    l5 = await getLastNGames(playerId, 5, { seasonType, league });
    trace.l5 = l5?.games?.length ? "stats_edge" : null;
  }
  // Opening-day cliff: when the current-season gamelog is empty (WNBA mid-May,
  // NBA early October) the LLM has no baseline and either hallucinates or
  // SKIPs every prop via the verifier's missing_baseline gate. Pull the prior
  // season's most-recent regular-season games as a fallback and tag the
  // result so composeGroundTruth surfaces a data_warnings entry.
  if (!l5?.games?.length) {
    const priorSeason = priorSeasonLabel(season, league);
    if (priorSeason && espnId) {
      const fb = await espnStats.getLastNGames(espnId, 5, { season: priorSeason, postseason: false, league });
      if (fb?.games?.length) {
        l5 = { ...fb, is_prior_season: true };
        trace.l5 = "espn_gamelog_prior";
      }
    }
  }
  if (!l5?.games?.length) trace.l5 = "missing";

  // Splits and opponent defense use regular season — playoff samples are too
  // small to be a stable baseline. Same logic as Rule 5a road deduction.
  const opponentSide = opponentFor(game, info.team_abbr, { league });
  // BR snapshot primary for splits (Vercel egress is throttled by stats edge,
  // and the BR file is on disk so it never times out). Stats edge stays on
  // the critical path only when the player isn't in the snapshot.
  const bbrefSplits = bbref.getHomeAwaySplits(player, { season, league });
  // ESPN primary for season averages; stats-edge fallback below. Defender
  // and matchup data have no ESPN equivalent and stay on stats edge.
  const [espnSeasonAvg, statsSplits, winProb, opponentDefense, primaryDefender, defRankByAbbr] = await Promise.all([
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
  ]);
  const splits = bbrefSplits ?? statsSplits;
  trace.splits = bbrefSplits ? "bbref_snapshot" : (statsSplits ? "stats_edge" : "missing");
  trace.win_prob = winProb ? `espn_${winProb.source}` : "missing";
  trace.opponent_defense = opponentDefense ? `team_defense_${opponentDefense.source}` : "missing";
  trace.primary_defender = primaryDefender ? primaryDefender.source : "missing";

  let seasonAvg = espnSeasonAvg ?? await getSeasonAverages(playerId, { seasonType: "Regular Season", league });
  trace.season_avg = espnSeasonAvg ? "espn_gamelog" : (seasonAvg ? "stats_edge" : null);
  // Same opening-day fallback as L5: when the current season has no games
  // yet, pull the prior-season aggregate so the framework has something to
  // anchor against. The is_prior_season tag propagates through to the
  // groundTruth data_warnings.
  if (!seasonAvg) {
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

  const { groundTruth, missing } = composeGroundTruth({
    player, propType, line, league,
    info, game, daysOut, seasonType,
    seasonAvg, l5, splits, winProb, allInjuries, opponentDefense, primaryDefender,
    defRankByAbbr,
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
async function gatherGroundTruthWithRetry({ player, propType, line }) {
  // Define which errors should trigger retries
  const maxRetries = 3;
  const baseDelayMs = 1000;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await gatherGroundTruth({ player, propType, line });
      
      // If we got a skip reason, don't retry - it's a definitive result
      if (result.skipReason) {
        return result;
      }
      
      // Otherwise, we got valid data, return it
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
      const delay = calculateBackoffDelay(attempt, baseDelayMs);
      await sleep(delay);
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
 * and invokes the Groq AI model for prop analysis.
 * @param {Request} req - The HTTP request object
 * @returns {Promise<Response>} JSON response with analysis results or error
 */
async function handlePost(req) {
  // duration_ms in verdict events is measured from here so it covers
  // ground-truth fetch + LLM round-trip + verifier — i.e., what the user
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

    // Pre-LLM mechanical filter. Skips the LLM call when the framework's
    // arithmetic gates would already force SKIP. Same checks as the
    // post-LLM verifier — pre and post can never disagree.
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

    // Verify at least one LLM provider key is configured (router picks)
    if (!process.env.GROQ_API_KEY && !process.env.GOOGLE_API_KEY) {
      return createErrorResponse(
        new ConfigurationError("No LLM provider configured (set GROQ_API_KEY and/or GOOGLE_API_KEY)")
      );
    }

    // Invoke routed LLM (Groq/Gemini per LLM_PROVIDERS)
    const llmResponse = await invokeLLM(groundTruth);
    if (llmResponse.isError) {
      logVerdict({
        source: "analyze",
        input: { player, propType, line },
        groundTruth,
        playerInfo,
        trace,
        errorInfo: { message: "LLM call failed", name: "LLMError", status: 500 },
        durationMs: elapsed(),
      });
      return llmResponse.response;
    }

    // Re-derive the mechanical framework checks on the LLM's output as a
    // second layer of defense (catches qualitative-mode drift). Same
    // logic as the pre-filter above.
    const verified = verifyVerdict({
      groundTruth,
      statType,
      direction,
      line,
      llmResult: llmResponse.data,
    });

    // Return successful response with (possibly overridden) verdict
    logVerdict({
      source: "analyze",
      input: { player, propType, line },
      result: verified,
      groundTruth,
      playerInfo,
      trace,
      durationMs: elapsed(),
      llmProvider: llmResponse.provider,
      llmModel: llmResponse.model,
    });
    return createSuccessResponse(verified, groundTruth);
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
 * Invokes the routed LLM (Groq/Gemini) with the given ground truth data.
 * Provider selection happens inside callLLM per LLM_PROVIDERS.
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {{isError: boolean, response?: Response, data?: Object, provider?: string, model?: string}}
 */
async function invokeLLM(groundTruth) {
  try {
    // Build prompt and invoke the routed LLM. Framework variant is picked
    // from the league field on groundTruth — NBA-default for legacy callers.
    const framework = getFramework(groundTruth?.league ?? "NBA");
    const prompt = buildPrompt(framework, groundTruth);
    const llm = await callLLM(prompt);
    if (llm.error) {
      return {
        isError: true,
        response: Response.json({ error: llm.error, debug: llm.debug }, { status: 500 })
      };
    }

    return {
      isError: false,
      data: llm.json,
      provider: llm.provider ?? null,
      model: llm.model ?? null,
    };
  } catch (error) {
    return {
      isError: true,
      response: Response.json({ error: error.message }, { status: 500 })
    };
  }
}

/**
 * Creates a successful response with LLM output and ground truth.
 * @param {Object> llmData - The parsed JSON data from the LLM
 * @param {Object} groundTruth - The ground truth data used for analysis
 * @returns {Response} JSON response with analysis results
 */
function createSuccessResponse(llmData, groundTruth) {
  return Response.json({ ...llmData, ground_truth: groundTruth });
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

  // Validate required fields
  if (!player || !propType || !line) {
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
    data: { player, propType, line }
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

/**
 * Returns a slimmed copy of groundTruth suitable for embedding in an
 * LLM prompt. The full groundTruth is preserved on the API response
 * (callers still get every field); only the prompt embed is trimmed.
 *
 * Trims:
 *   • l5.games[] — dropped entirely on props where Rule 5b.ii (shooting
 *     slump rebound suppressor) cannot fire. 5b.ii is rebound-OVER-only
 *     per framework, so every other prop pays ~600-1000 tokens per call
 *     for unused per-game shooting data.
 *   • l5.games[i] fields not referenced by any framework rule — keep
 *     just {fgm, fga, fg_pct} on rebound props, drop matchup/result/etc.
 *
 * Other fields (season, splits, injuries, win_prob, opponent_defense,
 * series, player_recent) are kept verbatim — many rules cross-reference
 * them in non-obvious ways and trimming risks silently dropping signal.
 *
 * @param {Object} gt - full ground truth from composeGroundTruth
 * @returns {Object} slimmed copy safe to embed in the prompt
 */
export function slimGroundTruthForPrompt(gt) {
  if (!gt) return gt;
  const propType = String(gt.prop_type || "");
  const stat = propType.replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
  const dir = /UNDER/i.test(propType) ? "UNDER" : "OVER";
  // 5b.ii fires only on Rebounds OVER. Other props (including PRA OVER)
  // cannot trigger it, so l5.games[] is unused for them.
  const needsL5Games = stat === "Rebounds" && dir === "OVER";

  let l5 = gt.l5;
  if (l5 && !needsL5Games) {
    const { games: _games, ...rest } = l5;
    l5 = rest;
  } else if (l5 && needsL5Games && Array.isArray(l5.games)) {
    l5 = {
      ...l5,
      games: l5.games.map((g) => ({
        fgm: g.fgm,
        fga: g.fga,
        fg_pct: g.fg_pct,
      })),
    };
  }

  return { ...gt, l5 };
}

/**
 * Builds the single-task prompt for the LLM based on the framework and
 * ground truth data. For multi-task batching use buildBatchPrompt.
 * @param {string} framework - The analytical framework to apply
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {string} Formatted prompt for the LLM API
 */
export function buildPrompt(framework, groundTruth) {
  const field = propTypeToField(groundTruth.prop_type);
  const daysOut = groundTruth.game?.days_out ?? 0;
  const forwardLookingNote = daysOut > 0
    ? `\n\nFORWARD-LOOKING GAME: groundTruth.game.days_out is ${daysOut} — this game is NOT today, it is ${daysOut} day(s) away. Injury reports, win probability, and lineup state may shift before tip-off. You MUST add a flag "📅 forward-looking pick (game ${daysOut}d out) — re-verify injuries closer to tip" and treat any UNDER mechanism that depends on a teammate's confirmed status (e.g., role compression) as A-tier max unless the absence is clearly long-term.`
    : "";

  // Build the prompt components. League label is read from groundTruth so the
  // role line matches the framework variant.
  const leagueLabel = String(groundTruth?.league ?? "NBA").toUpperCase();
  const roleDefinition = `You are the ${leagueLabel} PrizePicks Model v3.5 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.`;

  const dataRules = `DATA RULES — non-negotiable:
1. Use ONLY values from the GROUND TRUTH block below. Do NOT invent, estimate, recall from prior knowledge, or guess any number. Treat your training-data memory of player stats as forbidden.
2. Arithmetic on values supplied in GROUND TRUTH is permitted (it is already pre-computed for you in averages.pra / pr / pa / ra). Producing any number that cannot be derived from GROUND TRUTH is a violation.
3. The "data_used" field of your output must echo values directly from GROUND TRUTH. Do not put your own numbers there.
4. If applying a hard gate from the framework requires a value that is null or absent in GROUND TRUTH, set verdict to "SKIP" with a flag like "⚠️ missing: <field>". Do not substitute a guessed value.${forwardLookingNote}`;

  const frameworkSection = `FRAMEWORK:
${framework}`;

  // Trim the ground truth to the fields this prop actually uses. The
  // biggest savings come from dropping l5.games[] (~600-1000 tokens) for
  // props where Rule 5b.ii shooting-slump suppressor cannot fire — the
  // suppressor is rebound-OVER-only per framework. Compact JSON also
  // drops indentation whitespace.
  const slimGt = slimGroundTruthForPrompt(groundTruth);
  const groundTruthSection = `GROUND TRUTH (the only data you may cite):
${JSON.stringify(slimGt)}`;
  
  const whereToFindValues = `WHERE TO FIND VALUES (path → meaning):
- groundTruth.season.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fgm,fga,fg_pct,ft_pct,fg3_pct,fta,ftm,minutes}  → regular-season per-game averages (fta/ftm needed for Rule 5i FT-Floor Insurance Guard default)
- groundTruth.l5.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fga,fta,ftm,ft_pct,minutes}            → most-recent 5 games (playoff if l5.type==="Playoffs"). l5.averages.{fta,ftm,ft_pct} are the [v3.5] Rule 5i playoff override inputs — use them in place of season.averages.{fta,ft_pct} when l5.type==="Playoffs" AND l5.n>=3.
- groundTruth.l5.type / l5.n                                                                   → sample type ("Playoffs" | "Regular Season") and size. When type==="Playoffs" AND n>=3, applies the [v3.5] playoff overrides to (a) L5-vs-Season governance (L5 governs regardless of conflict size) and (b) Rule 5i (l5 FTA/FT% govern the floor).
- groundTruth.l5.games[i].{fgm,fga,fg_pct}                                                      → per-game shooting (used by Rule 5b.ii shooting-slump rebound suppressor; only embedded for Rebounds OVER props)
- groundTruth.l5.weighted.{averages,raw_vs_weighted_delta,outlier_present,mode}                → [v3.5] Weighted L5 baseline used by Rule 5a/5f/S-tier item 4 and the L5-vs-season tiebreaker. Game-level reads (5b.ii, 4c) keep using raw l5. Emit diagnostic flags when |weighted.ppg − raw l5.ppg| ≥ 2 ("weighted L5 diverges…") or weighted.outlier_present === true (post-outlier window — OVER buffer widens to 2.5 pts) or weighted.mode === "playoff_raw_fallback" (small playoff sample — proceed with raw L5 unchanged).
- groundTruth.variance.ppg_stddev                                                             → [v3.5] Per-player ppg σ for the Rule 5a addendum. Null when sample <8 games. When non-null AND > league threshold (NBA=6, WNBA=5), OVER buffer becomes 1.5 + 0.25 × (σ − threshold) on points-family props. Cite σ in justification.
- groundTruth.derived.ft_floor_baseline                                                       → [v3.5] Per-position FG floor for Rule 5i (FT-Floor Insurance Guard). NBA G/F/C = 6/8/10, WNBA = 4/6/8. Falls back to F when player position is unknown.
- groundTruth.splits.{home,road}.{...}                                                       → regular-season home/away splits
- groundTruth.home_away                                                                       → "home" | "away" for tonight's game
- groundTruth.opponent_team.name / abbr                                                       → tonight's opponent
- groundTruth.win_prob.player_team_pct                                                        → 0-1 float (multiply by 100 for the % the framework uses). Two distinct rules consume this value — do not conflate them:
    (a) Rule 5f BLOWOUT SUPPRESSOR — applies to OVERs of ANY stat. Triggered by extreme win prob (very high or very low). Downgrades or skips per framework wording. This is what fires on plain Points/Rebounds/etc. when win prob is lopsided.
    (b) [v3.5 R9] ASSIST WIN-PROB GATE — applies ONLY to props whose stat is in {Assists, PA, RA, PRA}. Band: [0.40, 0.75] regular season, [0.45, 0.70] playoff. Outside the band → SKIP. DO NOT apply R9 to Points, Rebounds, PR, 3-Pointers Made, FG Attempted, or any other non-assist-containing prop — for those props this rule does not exist and a low/high win prob is governed by 5f only.
- groundTruth.injuries.player_team / opponent                                                 → {player,status,detail,date}[] (used for role compression / matchup ceiling)
- groundTruth.player_recent.is_listed_injured                                                 → boolean — TRUE means post-injury return gate (Section 6) applies
- groundTruth.opponent_defense                                                                → {def_rating, def_rank (1-30, 1=best), primary_defender: {player, share_pct, n_games, confirmed} | null, source}; null only when both live and snapshot fail. primary_defender is the season-aggregated top defender vs this player from stats.nba.com matchup data; confirmed=true when share_pct >= 0.40. Use def_rank for Rule 5h baseline + Mechanism 3 matchup ceiling (top-5 = def_rank<=5); use primary_defender to gate the v3.5 5h FT-leak modifier on a named matchup.
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins, next_game_number, series_record, series_summary, leading_team_abbr, round, source}; null in regular season. Non-null = playoff game (activates playoff-specific rules: Game 1/2 caps, S-tier floor 85%, weighted-L5 series-game multiplier, etc.). leading_team_abbr is null when series is tied, otherwise the abbr of the team ahead — use it for Rule 5f tied-series and lead-3-0/3-1 gating instead of parsing series_record or series_summary.`;
  
  const propSpecificInfo = `For this prop ("${groundTruth.prop_type}" line ${groundTruth.line}), the relevant averages field is "${field ?? "(unknown — output SKIP)"}". Use season.averages.${field ?? "?"} and l5.averages.${field ?? "?"} as the baselines.`;
  
  const outputSpecification = `OUTPUT (single JSON object):
{
  "verdict":      "OVER" | "UNDER" | "SKIP",
  "tier":         "S" | "A" | "B" | "SKIP",
  "confidence":   integer 0-100,
  "justification": "2-3 sentences. Cite which baseline governed (season vs L5), road deduction if applied, suppressors triggered, and (for UNDER) the named mechanism. Numbers cited must come from GROUND TRUTH.",
  "flags":        array of strings (one per suppressor / hard cap / missing-data warning),
  "data_used": {
    "season_avg":  <number copied from groundTruth.season.averages.${field ?? "?"} — or null if season is null>,
    "l5_avg":      <number copied from groundTruth.l5.averages.${field ?? "?"} — or null if l5 is null>,
    "home_away":   <copy groundTruth.home_away>,
    "win_prob":    <copy groundTruth.win_prob.player_team_pct, or null>,
    "opponent":    <copy groundTruth.opponent_team.name>,
    "game_context": <if groundTruth.series is non-null, format as "{season.label} {series.round} G{series.next_game_number} ({series.series_summary})" — copy series.next_game_number and series.series_summary verbatim from GROUND TRUTH; do NOT compute, infer, or recall the game number, series record, or series leader from any other source. Example with the values supplied: "2025-26 RD16 G5 (BOS leads series 3-1)". If series is null, format as "{season.label} Regular Season".>
  }`;
  
  // Combine all sections
  return `${roleDefinition}

${dataRules}

${frameworkSection}

${groundTruthSection}

${whereToFindValues}

${propSpecificInfo}

${outputSpecification}`;
}

/**
 * Builds a batched prompt that evaluates N (prop_type, line) tasks in one
 * LLM call for the same player. The framework, ground truth, and "where
 * to find values" sections appear once; tasks are listed at the end with
 * IDs so the model can return an array keyed by ID.
 *
 * Decisions are explicitly required to be independent — no carry-over
 * between tasks. Caller is responsible for verifying each result against
 * its own task fields.
 *
 * @param {string} framework
 * @param {Object} groundTruth - shared ground truth for one player. The
 *   prop_type/line fields are stripped before embedding because those
 *   are per-task here.
 * @param {Array<{id: string, prop_type: string, line: number}>} tasks
 * @returns {string} batched prompt
 */
export function buildBatchPrompt(framework, groundTruth, tasks) {
  const daysOut = groundTruth.game?.days_out ?? 0;
  const forwardLookingNote = daysOut > 0
    ? `\n\nFORWARD-LOOKING GAME: groundTruth.game.days_out is ${daysOut} — this game is NOT today, it is ${daysOut} day(s) away. Injury reports, win probability, and lineup state may shift before tip-off. For EACH task add a flag "📅 forward-looking pick (game ${daysOut}d out) — re-verify injuries closer to tip" and treat any UNDER mechanism that depends on a teammate's confirmed status (e.g., role compression) as A-tier max unless the absence is clearly long-term.`
    : "";

  // Strip per-task fields — they belong on each task, not on the shared GT.
  const { prop_type: _pt, line: _l, ...gtCommon } = groundTruth;

  const leagueLabel = String(groundTruth?.league ?? "NBA").toUpperCase();
  const roleDefinition = `You are the ${leagueLabel} PrizePicks Model v3.5 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.`;

  const dataRules = `DATA RULES — non-negotiable:
1. Use ONLY values from the GROUND TRUTH block below. Do NOT invent, estimate, recall from prior knowledge, or guess any number. Treat your training-data memory of player stats as forbidden.
2. Arithmetic on values supplied in GROUND TRUTH is permitted (it is already pre-computed for you in averages.pra / pr / pa / ra). Producing any number that cannot be derived from GROUND TRUTH is a violation.
3. The "data_used" field of each task's output must echo values directly from GROUND TRUTH. Do not put your own numbers there.
4. If applying a hard gate from the framework requires a value that is null or absent in GROUND TRUTH, set that task's verdict to "SKIP" with a flag like "⚠️ missing: <field>". Do not substitute a guessed value.${forwardLookingNote}`;

  const frameworkSection = `FRAMEWORK:
${framework}`;

  const groundTruthSection = `GROUND TRUTH (the only data you may cite — shared across all tasks below):
${JSON.stringify(gtCommon, null, 2)}`;

  const whereToFindValues = `WHERE TO FIND VALUES (path → meaning):
- groundTruth.season.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fgm,fga,fg_pct,ft_pct,fg3_pct,fta,ftm,minutes}  → regular-season per-game averages (fta/ftm needed for Rule 5i FT-Floor Insurance Guard default)
- groundTruth.l5.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fga,fta,ftm,ft_pct,minutes}            → most-recent 5 games (playoff if l5.type==="Playoffs"). l5.averages.{fta,ftm,ft_pct} are the [v3.5] Rule 5i playoff override inputs — use them in place of season.averages.{fta,ft_pct} when l5.type==="Playoffs" AND l5.n>=3.
- groundTruth.l5.type / l5.n                                                                   → sample type ("Playoffs" | "Regular Season") and size. When type==="Playoffs" AND n>=3, applies the [v3.5] playoff overrides to (a) L5-vs-Season governance (L5 governs regardless of conflict size) and (b) Rule 5i (l5 FTA/FT% govern the floor).
- groundTruth.l5.games[i].{fgm,fga,fg_pct}                                                      → per-game shooting (used by Rule 5b.ii shooting-slump rebound suppressor; only embedded for Rebounds OVER props)
- groundTruth.l5.weighted.{averages,raw_vs_weighted_delta,outlier_present,mode}                → [v3.5] Weighted L5 baseline used by Rule 5a/5f/S-tier item 4 and the L5-vs-season tiebreaker. Game-level reads (5b.ii, 4c) keep using raw l5. Emit diagnostic flags when |weighted.ppg − raw l5.ppg| ≥ 2 ("weighted L5 diverges…") or weighted.outlier_present === true (post-outlier window — OVER buffer widens to 2.5 pts) or weighted.mode === "playoff_raw_fallback" (small playoff sample — proceed with raw L5 unchanged).
- groundTruth.variance.ppg_stddev                                                             → [v3.5] Per-player ppg σ for the Rule 5a addendum. Null when sample <8 games. When non-null AND > league threshold (NBA=6, WNBA=5), OVER buffer becomes 1.5 + 0.25 × (σ − threshold) on points-family props. Cite σ in justification.
- groundTruth.derived.ft_floor_baseline                                                       → [v3.5] Per-position FG floor for Rule 5i (FT-Floor Insurance Guard). NBA G/F/C = 6/8/10, WNBA = 4/6/8. Falls back to F when player position is unknown.
- groundTruth.splits.{home,road}.{...}                                                       → regular-season home/away splits
- groundTruth.home_away                                                                       → "home" | "away" for tonight's game
- groundTruth.opponent_team.name / abbr                                                       → tonight's opponent
- groundTruth.win_prob.player_team_pct                                                        → 0-1 float (multiply by 100 for the % the framework uses). Two distinct rules consume this value — do not conflate them:
    (a) Rule 5f BLOWOUT SUPPRESSOR — applies to OVERs of ANY stat. Triggered by extreme win prob (very high or very low). Downgrades or skips per framework wording. This is what fires on plain Points/Rebounds/etc. when win prob is lopsided.
    (b) [v3.5 R9] ASSIST WIN-PROB GATE — applies ONLY to props whose stat is in {Assists, PA, RA, PRA}. Band: [0.40, 0.75] regular season, [0.45, 0.70] playoff. Outside the band → SKIP. DO NOT apply R9 to Points, Rebounds, PR, 3-Pointers Made, FG Attempted, or any other non-assist-containing prop — for those props this rule does not exist and a low/high win prob is governed by 5f only.
- groundTruth.injuries.player_team / opponent                                                 → {player,status,detail,date}[] (used for role compression / matchup ceiling)
- groundTruth.player_recent.is_listed_injured                                                 → boolean — TRUE means post-injury return gate (Section 6) applies
- groundTruth.opponent_defense                                                                → {def_rating, def_rank (1-30, 1=best), primary_defender: {player, share_pct, n_games, confirmed} | null, source}; null only when both live and snapshot fail. primary_defender is the season-aggregated top defender vs this player from stats.nba.com matchup data; confirmed=true when share_pct >= 0.40. Use def_rank for Rule 5h baseline + Mechanism 3 matchup ceiling (top-5 = def_rank<=5); use primary_defender to gate the v3.5 5h FT-leak modifier on a named matchup.
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins, next_game_number, series_record, series_summary, leading_team_abbr, round, source}; null in regular season. Non-null = playoff game (activates playoff-specific rules: Game 1/2 caps, S-tier floor 85%, weighted-L5 series-game multiplier, etc.). leading_team_abbr is null when series is tied, otherwise the abbr of the team ahead — use it for Rule 5f tied-series and lead-3-0/3-1 gating instead of parsing series_record or series_summary.`;

  const taskListLines = tasks.map((t) => {
    const f = propTypeToField(t.prop_type);
    return `  - id="${t.id}": "${t.prop_type}" line=${t.line}  (averages field: "${f ?? "unknown — output SKIP"}")`;
  }).join("\n");

  // The FRAMEWORK above is the complete rule list — do not restate rules
  // here. Earlier versions of this prompt duplicated specific rules in a
  // numbered procedure, which silently drifted from the framework body
  // (e.g., L5-vs-Season governance and the OVER 1.5pt buffer were omitted
  // and the batched LLM stopped applying them). The only batch-specific
  // concern is task independence; everything else is governed by the
  // FRAMEWORK section verbatim.
  const batchInstructions = `TASKS TO EVALUATE (${tasks.length} total):
${taskListLines}

Apply the FRAMEWORK above in full and independently to each task. Every task is a separate evaluation against the same shared ground truth — do not let one task's hard gate, suppressor, governing-baseline choice, or verdict bias another's. If a rule's input is null/absent in GROUND TRUTH, follow the FRAMEWORK's instruction for that rule (SKIP or cap as specified) rather than substituting a guess.`;

  const outputSpecification = `OUTPUT (single JSON object — "results" array, one entry per task, SAME ORDER as TASKS TO EVALUATE):
{
  "results": [
    {
      "id":          "<echo the task id verbatim>",
      "verdict":     "OVER" | "UNDER" | "SKIP",
      "tier":        "S" | "A" | "B" | "SKIP",
      "confidence":  integer 0-100,
      "justification": "2-3 sentences citing baseline governed, road deduction if applied, suppressors triggered, and (UNDER) named mechanism. Numbers must come from GROUND TRUTH.",
      "flags":       array of strings (one per suppressor / hard cap / missing-data warning),
      "data_used": {
        "season_avg":  <number copied from season.averages.<this task's field>, or null>,
        "l5_avg":      <number copied from l5.averages.<this task's field>, or null>,
        "home_away":   <copy groundTruth.home_away>,
        "win_prob":    <copy groundTruth.win_prob.player_team_pct, or null>,
        "opponent":    <copy groundTruth.opponent_team.name>,
        "game_context": <if groundTruth.series is non-null, format as "{season.label} {series.round} G{series.next_game_number} ({series.series_summary})" — copy series.next_game_number and series.series_summary verbatim. If series is null, format as "{season.label} Regular Season".>
      }
    }
  ]
}`;

  return `${roleDefinition}

${dataRules}

${frameworkSection}

${groundTruthSection}

${whereToFindValues}

${batchInstructions}

${outputSpecification}`;
}

/**
 * Routes an LLM call across configured providers (Groq, Gemini) with
 * per-request rotation. The first call uses the first provider in
 * LLM_PROVIDERS; the second call uses the next; and so on. Within a
 * provider, the call burns the primary→fallback retry chain; if the whole
 * chain fails, the router falls over to the next provider's chain.
 *
 * @param {string} prompt - The prompt to send to the model
 * @returns {Promise<Object>} { json } on success, { error, debug? } otherwise
 */
export async function callLLM(prompt) {
  return routeLLM(prompt, {});
}

/**
 * Batched variant of callLLM. Routes through the same provider rotation
 * but with a batch-aware validator and an output budget scaled to batch
 * size. Returns { json: { results: [...] } } on success.
 *
 * @param {string} prompt - Built via buildBatchPrompt
 * @param {string[]} expectedIds - Task ids the model must return
 * @param {Object} [opts]
 * @param {number} [opts.maxTokens] - Override output budget (default scales by batch size)
 * @returns {Promise<Object>}
 */
export async function callLLMBatched(prompt, expectedIds, opts = {}) {
  const idSet = new Set(expectedIds);
  // Per-task result averages ~260 tokens on Groq, ~300 on Gemini Flash
  // (chattier). Budget 320 + a 300-token wrapper headroom so an 8-task
  // batch gets ~2860 tokens — comfortably above the worst case observed.
  // Cap at 5000 so we stay under cheap-model output limits.
  const defaultMax = Math.min(5000, 320 * expectedIds.length + 300);
  const maxTokens = opts.maxTokens ?? defaultMax;
  return routeLLM(prompt, {
    maxTokens,
    validator: makeBatchValidator(idSet),
  });
}

/**
 * @deprecated Use callLLM. Kept as a thin alias so older import sites and
 * external smoke scripts keep working. The first argument is ignored —
 * provider keys are resolved from env inside the router.
 */
export async function callGemini(_apiKey, prompt) {
  return callLLM(prompt);
}

/** @deprecated Use callLLMBatched. */
export async function callGeminiBatched(prompt, expectedIds, opts = {}) {
  return callLLMBatched(prompt, expectedIds, opts);
}

/**
 * Shared routing core for single-call and batched paths. Spreads requests
 * across configured providers via a module-level counter, threads `opts`
 * (maxTokens, validator) down to each provider's attempt function.
 */
async function routeLLM(prompt, opts) {
  const providers = getProviderRotation();
  if (providers.length === 0) {
    return { error: "No LLM provider configured (set GROQ_API_KEY and/or GOOGLE_API_KEY)" };
  }

  // Per-request rotation: shift the provider list so each request starts
  // on a different provider. Spreads load across independent rate-limit
  // pools (Groq TPM vs Gemini RPM). Single-provider configs are no-ops.
  const offset = _llmRequestCounter++ % providers.length;
  const ordered = providers.slice(offset).concat(providers.slice(0, offset));

  let last;
  for (const p of ordered) {
    last = await p.run(prompt, opts);
    if (!last.error) return last;
  }
  return last;
}

// Module-level rotation counter. Per-process state — fine for serverless
// functions because rotation only needs to differ within a warm instance.
let _llmRequestCounter = 0;

/**
 * Resolves the LLM_PROVIDERS env var into an ordered list of provider
 * adapters, filtered to those with credentials configured.
 * @returns {Array<{name: string, run: (prompt: string, opts: Object) => Promise<Object>}>}
 */
function getProviderRotation() {
  const order = (process.env.LLM_PROVIDERS || "groq,gemini")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const adapters = [];
  for (const name of order) {
    if (name === "groq" && process.env.GROQ_API_KEY) {
      adapters.push({ name, run: (p, o) => callGroqChain(process.env.GROQ_API_KEY, p, o) });
    } else if (name === "gemini" && process.env.GOOGLE_API_KEY) {
      adapters.push({ name, run: (p, o) => callGeminiChain(process.env.GOOGLE_API_KEY, p, o) });
    }
  }
  return adapters;
}

/**
 * Runs the Groq primary→fallback retry chain. Returns success on first
 * good response; on hard non-retryable error from primary, skips straight
 * to the fallback model.
 */
async function callGroqChain(apiKey, prompt, opts = {}) {
  const PRIMARY = process.env.GROQ_PRIMARY_MODEL || "llama-3.3-70b-versatile";
  const FALLBACK = process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-120b";
  const primaryDelays = (process.env.GROQ_PRIMARY_DELAYS || "0,500,1500")
    .split(",").map((d) => parseInt(d, 10));
  // v3.5: the fallback model `openai/gpt-oss-120b` has an 8K TPM cap, and the
  // 14K-char v3.5 framework body plus a heavy playoff GT can push a single
  // request past it. Cap the fallback's output reservation to free input
  // headroom; the primary chain still uses the caller-supplied budget. Tunable
  // via env so we can ratchet it lower without a redeploy if needed.
  const fallbackMaxTokens = parseInt(process.env.GROQ_FALLBACK_MAX_TOKENS || "900", 10);

  let last;
  for (const delay of primaryDelays) {
    if (delay) await sleep(delay);
    last = await groqAttempt(apiKey, prompt, PRIMARY, opts);
    if (!last.error || !last.retryable) break;
  }
  if (!last.error) return stripRetryable(last);

  const fallbackDelay = parseInt(process.env.GROQ_FALLBACK_DELAY || "500", 10);
  await sleep(fallbackDelay);
  // Respect a caller's smaller budget if they already passed one (e.g., a
  // single-task batched call). Only cap *down* from the caller value.
  const callerMax = opts.maxTokens ?? Infinity;
  const fallbackOpts = { ...opts, maxTokens: Math.min(callerMax, fallbackMaxTokens) };
  last = await groqAttempt(apiKey, prompt, FALLBACK, fallbackOpts);
  return stripRetryable(last);
}

/**
 * Runs the Gemini primary→fallback retry chain. Mirrors callGroqChain
 * structure but talks to the v1beta generateContent endpoint.
 */
async function callGeminiChain(apiKey, prompt, opts = {}) {
  const PRIMARY = process.env.GEMINI_PRIMARY_MODEL || "gemini-2.5-flash";
  const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite";
  const primaryDelays = (process.env.GEMINI_PRIMARY_DELAYS || "0,500,1500")
    .split(",").map((d) => parseInt(d, 10));

  let last;
  for (const delay of primaryDelays) {
    if (delay) await sleep(delay);
    last = await geminiAttempt(apiKey, prompt, PRIMARY, opts);
    if (!last.error || !last.retryable) break;
  }
  if (!last.error) return stripRetryable(last);

  const fallbackDelay = parseInt(process.env.GEMINI_FALLBACK_DELAY || "500", 10);
  await sleep(fallbackDelay);
  last = await geminiAttempt(apiKey, prompt, FALLBACK, opts);
  return stripRetryable(last);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripRetryable({ retryable: _r, ...rest }) {
  return rest;
}

async function groqAttempt(apiKey, prompt, model, { maxTokens = 1500, validator = validateLLMOutput } = {}) {
  let res;
  try {
    res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" }
        }),
      }
    );
  } catch (err) {
    return { error: `Groq fetch failed: ${err.message}`, retryable: true };
  }

  const data = await res.json();
  if (data.error) {
    // Classify by HTTP status: 408/429/5xx are transient → retry primary,
    // then fall back; 4xx auth/decommissioned/bad-request are permanent →
    // skip the retry chain and let the router try the next provider.
    const status = res.status;
    const retryable = status === 408 || status === 429 || status >= 500;
    return { error: data.error?.message || `Groq error (${status})`, retryable };
  }

  const text = data.choices?.[0]?.message?.content?.trim() || "";
  if (!text) {
    return { error: "Empty Groq response", debug: data };
  }

  let jsonStr = null;
  if (text.startsWith("{") && text.endsWith("}")) {
    jsonStr = text;
  } else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) jsonStr = text.substring(start, end + 1);
  }
  if (!jsonStr) {
    return {
      error: `No JSON in Groq response`,
      debug: text.slice(0, 800),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { error: `JSON parse failed: ${e.message}`, debug: jsonStr.slice(0, 800) };
  }

  const invalid = validator(parsed);
  if (invalid) {
    return {
      error: `Groq output failed schema validation: ${invalid}`,
      retryable: false,
      debug: jsonStr.slice(0, 800),
    };
  }
  return { json: parsed, provider: "groq", model };
}

/**
 * Single attempt against Gemini's generateContent endpoint. Same return
 * shape as groqAttempt: { json, provider, model } on success,
 * { error, retryable, debug? } on failure. Used by callGeminiChain
 * inside the multi-provider router.
 */
async function geminiAttempt(apiKey, prompt, model, { maxTokens = 1500, validator = validateLLMOutput } = {}) {
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
          },
        }),
      }
    );
  } catch (err) {
    return { error: `Gemini fetch failed: ${err.message}`, retryable: true };
  }

  const data = await res.json();
  if (data.error) {
    const status = data.error.status;
    const code = data.error.code;
    const retryable =
      code === 503 || code === 429 || code === 500 ||
      status === "UNAVAILABLE" || status === "RESOURCE_EXHAUSTED" || status === "INTERNAL";
    return { error: data.error.message, retryable };
  }

  const cand = data.candidates?.[0];
  const finishReason = cand?.finishReason;
  const text = cand?.content?.parts?.[0]?.text?.trim() || "";
  if (!text) return { error: `Empty Gemini response (finishReason: ${finishReason})`, debug: data };

  let jsonStr = null;
  if (text.startsWith("{") && text.endsWith("}")) {
    jsonStr = text;
  } else {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) jsonStr = text.substring(start, end + 1);
  }
  if (!jsonStr) {
    return {
      error: finishReason === "MAX_TOKENS"
        ? "Gemini response truncated (hit max tokens). Try again or shorten prompt."
        : `No JSON in Gemini response (finishReason: ${finishReason})`,
      debug: text.slice(0, 800),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return { error: `JSON parse failed: ${e.message} (finishReason: ${finishReason})`, debug: jsonStr.slice(0, 800) };
  }

  const invalid = validator(parsed);
  if (invalid) {
    return {
      error: `Gemini output failed schema validation: ${invalid}`,
      retryable: false,
      debug: jsonStr.slice(0, 800),
    };
  }
  return { json: parsed, provider: "gemini", model };
}

const VALID_VERDICTS = new Set(["OVER", "UNDER", "SKIP"]);
const VALID_TIERS = new Set(["S", "A", "B", "SKIP"]);

function validateLLMOutput(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return "not an object";
  if (!VALID_VERDICTS.has(o.verdict)) return `verdict "${o.verdict}" not in {OVER,UNDER,SKIP}`;
  if (!VALID_TIERS.has(o.tier)) return `tier "${o.tier}" not in {S,A,B,SKIP}`;
  if (!Number.isInteger(o.confidence) || o.confidence < 0 || o.confidence > 100) {
    return `confidence ${o.confidence} not integer 0..100`;
  }
  if (typeof o.justification !== "string" || o.justification.trim() === "") {
    return "justification missing or empty";
  }
  if (!Array.isArray(o.flags) || o.flags.some((f) => typeof f !== "string")) {
    return "flags not an array of strings";
  }
  if (o.verdict === "SKIP") {
    if (o.data_used != null && (typeof o.data_used !== "object" || Array.isArray(o.data_used))) {
      return "data_used must be object or null on SKIP";
    }
  } else {
    if (!o.data_used || typeof o.data_used !== "object" || Array.isArray(o.data_used)) {
      return "data_used required object on non-SKIP verdict";
    }
  }
  return null;
}

/**
 * Builds a validator for a batched response. Checks the wrapper shape
 * ({"results": [...]}), the length, that every entry has an "id"
 * matching one of the expected ids, and validates each entry against the
 * single-result schema. Order is not required since callers match by id.
 *
 * @param {Set<string>} expectedIds
 * @returns {(o: any) => string|null}
 */
function makeBatchValidator(expectedIds) {
  return function validateBatchOutput(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return "not an object";
    if (!Array.isArray(o.results)) return "results field not an array";
    if (o.results.length !== expectedIds.size) {
      return `results length ${o.results.length} != expected ${expectedIds.size}`;
    }
    const seen = new Set();
    for (let i = 0; i < o.results.length; i++) {
      const r = o.results[i];
      if (!r || typeof r !== "object") return `results[${i}] not an object`;
      if (typeof r.id !== "string") return `results[${i}].id not a string`;
      if (!expectedIds.has(r.id)) return `results[${i}].id "${r.id}" not in expected ids`;
      if (seen.has(r.id)) return `results[${i}].id "${r.id}" duplicated`;
      seen.add(r.id);
      const inner = validateLLMOutput(r);
      if (inner) return `results[${i}] (id="${r.id}"): ${inner}`;
    }
    return null;
  };
}
