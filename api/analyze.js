import { resolvePlayerId, resolveEspnId } from "./lib/player-ids.js";
import {
  currentSeason,
  getCommonPlayerInfo,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
} from "./lib/nba-stats.js";
import * as bdl from "./lib/balldontlie.js";
import * as espnStats from "./lib/espn-stats.js";
import { getOpponentDefense } from "./lib/team-defense.js";
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
import { MODEL_FRAMEWORK } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { PROP_TO_FIELD } from "./lib/prop-types.js";
import { verifyVerdict } from "./lib/verdict-verifier.js";
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
  const playerId = resolvePlayerId(player);
  if (!playerId) {
    return { skipReason: "player_not_configured", message: `No PlayerID configured for ${player}` };
  }

  const season = currentSeason();
  const espnId = resolveEspnId(player);

  // Identity: balldontlie primary (returns team_abbr instantly), stats.nba.com
  // fallback only when balldontlie misses. NBA Stats from Vercel egress
  // commonly times out at ~6s, and team_abbr is the only field we need
  // downstream — paying that latency on the critical path is wasteful.
  const [bdlPlayer, games, allInjuries] = await Promise.all([
    bdl.findPlayer(player),
    getTodaysGames(),
    getAllInjuries(),
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
    const nbaInfo = await getCommonPlayerInfo(playerId);
    if (!nbaInfo) {
      return { skipReason: "player_lookup_failed", message: `Could not resolve ${player} via balldontlie or stats.nba.com` };
    }
    info = nbaInfo;
    infoSource = "nba_stats";
  }

  const trace = {
    scoreboard: "espn",
    injuries: allInjuries ? "espn" : "missing",
    info: infoSource,
  };

  let game = findGameForTeamAbbr(games, info.team_abbr);
  let daysOut = 0;
  if (!game) {
    const next = await findNextGameForTeamAbbr(info.team_abbr, 7);
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
    ? await espnStats.getLastNGames(espnId, 5, { season, postseason: isPlayoff })
    : null;
  trace.l5 = l5?.games?.length ? "espn_gamelog" : null;
  if (!trace.l5) {
    l5 = await getLastNGames(playerId, 5, { seasonType });
    trace.l5 = l5?.games?.length ? "nba_stats" : "missing";
  }

  // Splits and opponent defense use regular season — playoff samples are too
  // small (5–28 games) to be a stable baseline. Same logic as Rule 5a road
  // deduction.
  const opponentSide = opponentFor(game, info.team_abbr);
  // BR snapshot primary for splits (Vercel egress is throttled by stats.nba.com,
  // and the BR file is on disk so it never times out). NBA Stats stays on the
  // critical path only when the player isn't in the snapshot.
  const bbrefSplits = bbref.getHomeAwaySplits(player, { season });
  // ESPN primary for season averages; NBA fallback below. Defender and
  // matchup data have no ESPN equivalent and stay on stats.nba.com.
  const [espnSeasonAvg, nbaSplits, winProb, opponentDefense, primaryDefender] = await Promise.all([
    espnId ? espnStats.getSeasonAverages(espnId, { season }) : null,
    bbrefSplits ? null : getHomeAwaySplits(playerId, { seasonType: "Regular Season" }),
    getWinProbability(game.game_id, game.competition_id),
    opponentSide ? getOpponentDefense(opponentSide.abbr, { seasonType: "Regular Season" }) : null,
    opponentSide ? getPrimaryDefender(playerId, opponentSide.abbr, { seasonType }) : null,
  ]);
  const splits = bbrefSplits ?? nbaSplits;
  trace.splits = bbrefSplits ? "bbref_snapshot" : (nbaSplits ? "nba_stats" : "missing");
  trace.win_prob = winProb ? `espn_${winProb.source}` : "missing";
  trace.opponent_defense = opponentDefense ? `team_defense_${opponentDefense.source}` : "missing";
  trace.primary_defender = primaryDefender ? primaryDefender.source : "missing";

  const seasonAvg = espnSeasonAvg ?? await getSeasonAverages(playerId, { seasonType: "Regular Season" });
  trace.season_avg = espnSeasonAvg ? "espn_gamelog" : (seasonAvg ? "nba_stats" : "missing");

  const { groundTruth, missing } = composeGroundTruth({
    player, propType, line,
    info, game, daysOut, seasonType,
    seasonAvg, l5, splits, winProb, allInjuries, opponentDefense, primaryDefender,
  });

   return { groundTruth, missing, trace };
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
      return Response.json(skipResult(gathered.skipReason, gathered.message));
    }

    const { groundTruth, missing, trace } = gathered;

    // Check for missing required data
    if (missing.length > 0) {
      return createMissingDataResponse(missing, trace);
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
      return llmResponse.response;
    }

    // Re-derive the mechanical framework checks (OVER 1.5pt buffer,
    // Rule 5i FT-floor) deterministically. Same call as /api/analyze-all
    // so both endpoints agree on these regardless of model rotation.
    const direction = /OVER/i.test(propType) ? "OVER" : "UNDER";
    const statType = String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
    const verified = verifyVerdict({
      groundTruth,
      statType,
      direction,
      line,
      llmResult: llmResponse.data,
    });

    // Return successful response with (possibly overridden) verdict
    return createSuccessResponse(verified, groundTruth);
  } catch (error) {
    // Handle unexpected errors with proper error categorization
    return createErrorResponse(error);
  }
}

/**
 * Invokes the routed LLM (Groq/Gemini) with the given ground truth data.
 * Provider selection happens inside callLLM per LLM_PROVIDERS.
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {{isError: boolean, response?: Response, data?: Object}} Result containing either the LLM response or error
 */
async function invokeLLM(groundTruth) {
  try {
    // Build prompt and invoke the routed LLM
    const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
    const llm = await callLLM(prompt);
    if (llm.error) {
      return {
        isError: true,
        response: Response.json({ error: llm.error, debug: llm.debug }, { status: 500 })
      };
    }
    
    return {
      isError: false,
      data: llm.json
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
  
  // Build the prompt components
  const roleDefinition = "You are the NBA PrizePicks Model v3.4 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.";
  
  const dataRules = `DATA RULES — non-negotiable:
1. Use ONLY values from the GROUND TRUTH block below. Do NOT invent, estimate, recall from prior knowledge, or guess any number. Treat your training-data memory of player stats as forbidden.
2. Arithmetic on values supplied in GROUND TRUTH is permitted (it is already pre-computed for you in averages.pra / pr / pa / ra). Producing any number that cannot be derived from GROUND TRUTH is a violation.
3. The "data_used" field of your output must echo values directly from GROUND TRUTH. Do not put your own numbers there.
4. If applying a hard gate from the framework requires a value that is null or absent in GROUND TRUTH, set verdict to "SKIP" with a flag like "⚠️ missing: <field>". Do not substitute a guessed value.${forwardLookingNote}`;
  
  const frameworkSection = `FRAMEWORK:
${framework}`;
  
  const groundTruthSection = `GROUND TRUTH (the only data you may cite):
${JSON.stringify(groundTruth, null, 2)}`;
  
  const whereToFindValues = `WHERE TO FIND VALUES (path → meaning):
- groundTruth.season.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fgm,fga,fg_pct,ft_pct,fg3_pct,fta,ftm,minutes}  → regular-season per-game averages (fta/ftm needed for Rule 5i FT-Floor Insurance Guard)
- groundTruth.l5.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fga,minutes}                              → most-recent 5 games (playoff if l5.type==="Playoffs")
- groundTruth.l5.games[i].{fgm,fga,fg_pct}                                                      → per-game shooting (used by Rule 5b.ii shooting-slump rebound suppressor)
- groundTruth.splits.{home,road}.{...}                                                       → regular-season home/away splits
- groundTruth.home_away                                                                       → "home" | "away" for tonight's game
- groundTruth.opponent_team.name / abbr                                                       → tonight's opponent
- groundTruth.win_prob.player_team_pct                                                        → 0-1 float (multiply by 100 for the % the framework uses)
- groundTruth.injuries.player_team / opponent                                                 → {player,status,detail,date}[] (used for role compression / matchup ceiling)
- groundTruth.player_recent.is_listed_injured                                                 → boolean — TRUE means post-injury return gate (Section 6) applies
- groundTruth.opponent_defense                                                                → {def_rating, def_rank (1-30, 1=best), primary_defender: {player, share_pct, n_games, confirmed} | null, source}; null only when both live and snapshot fail. primary_defender is the season-aggregated top defender vs this player from stats.nba.com matchup data; confirmed=true when share_pct >= 0.40. Use def_rank for Rule 5h baseline + Mechanism 3 matchup ceiling (top-5 = def_rank<=5); use primary_defender to gate the v3.4 5h FT-leak modifier on a named matchup.
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins, next_game_number, series_record, series_summary, leading_team_abbr, round, source}; null in regular season. leading_team_abbr is null when series is tied, otherwise the abbr of the team ahead — use it for Rule 5f tied-series and lead-3-0/3-1 gating instead of parsing series_record or series_summary.`;
  
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

  const roleDefinition = "You are the NBA PrizePicks Model v3.4 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.";

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
- groundTruth.season.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fgm,fga,fg_pct,ft_pct,fg3_pct,fta,ftm,minutes}  → regular-season per-game averages (fta/ftm needed for Rule 5i FT-Floor Insurance Guard)
- groundTruth.l5.averages.{ppg,rpg,apg,pra,pr,pa,ra,fg3m,fga,minutes}                              → most-recent 5 games (playoff if l5.type==="Playoffs")
- groundTruth.l5.games[i].{fgm,fga,fg_pct}                                                      → per-game shooting (used by Rule 5b.ii shooting-slump rebound suppressor)
- groundTruth.splits.{home,road}.{...}                                                       → regular-season home/away splits
- groundTruth.home_away                                                                       → "home" | "away" for tonight's game
- groundTruth.opponent_team.name / abbr                                                       → tonight's opponent
- groundTruth.win_prob.player_team_pct                                                        → 0-1 float (multiply by 100 for the % the framework uses)
- groundTruth.injuries.player_team / opponent                                                 → {player,status,detail,date}[] (used for role compression / matchup ceiling)
- groundTruth.player_recent.is_listed_injured                                                 → boolean — TRUE means post-injury return gate (Section 6) applies
- groundTruth.opponent_defense                                                                → {def_rating, def_rank (1-30, 1=best), primary_defender: {player, share_pct, n_games, confirmed} | null, source}; null only when both live and snapshot fail. primary_defender is the season-aggregated top defender vs this player from stats.nba.com matchup data; confirmed=true when share_pct >= 0.40. Use def_rank for Rule 5h baseline + Mechanism 3 matchup ceiling (top-5 = def_rank<=5); use primary_defender to gate the v3.4 5h FT-leak modifier on a named matchup.
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins, next_game_number, series_record, series_summary, leading_team_abbr, round, source}; null in regular season. leading_team_abbr is null when series is tied, otherwise the abbr of the team ahead — use it for Rule 5f tied-series and lead-3-0/3-1 gating instead of parsing series_record or series_summary.`;

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

  let last;
  for (const delay of primaryDelays) {
    if (delay) await sleep(delay);
    last = await groqAttempt(apiKey, prompt, PRIMARY, opts);
    if (!last.error || !last.retryable) break;
  }
  if (!last.error) return stripRetryable(last);

  const fallbackDelay = parseInt(process.env.GROQ_FALLBACK_DELAY || "500", 10);
  await sleep(fallbackDelay);
  last = await groqAttempt(apiKey, prompt, FALLBACK, opts);
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
  return { json: parsed };
}

/**
 * Single attempt against Gemini's generateContent endpoint. Same return
 * shape as groqAttempt: { json } on success, { error, retryable, debug? }
 * on failure. Used by callGeminiChain inside the multi-provider router.
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
  return { json: parsed };
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
