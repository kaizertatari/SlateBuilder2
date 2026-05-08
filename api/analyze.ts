import { resolvePlayerId, resolveEspnId } from "./lib/player-ids.ts";
import {
  currentSeason,
  getCommonPlayerInfo,
  getSeasonAverages,
  getLastNGames,
  getHomeAwaySplits,
} from "./lib/nba-stats.ts";
import * as bdl from "./lib/balldontlie.ts";
import * as espnStats from "./lib/espn-stats.ts";
import { getOpponentDefense } from "./lib/team-defense.ts";
import { getPrimaryDefender } from "./lib/matchup-defender.ts";
import {
  getTodaysGames,
  findGameForTeamAbbr,
  findNextGameForTeamAbbr,
  getWinProbability,
  getAllInjuries,
  opponentFor,
} from "./lib/espn.ts";
import { composeGroundTruth } from "./lib/ground-truth.ts";
import { MODEL_FRAMEWORK } from "./lib/framework.ts";
import { rateLimit } from "./lib/rate-limit.ts";
import { runWithRequestContext } from "./lib/request-context.ts";
import { PROP_TO_FIELD } from "./lib/prop-types.ts";
import { randomUUID } from "node:crypto";
import {
  ConfigurationError,
  ValidationError,
  RateLimitError,
  ExternalAPIError,
  LLMError,
  DataNotFoundError,
  createErrorResponse,
  isRetryableError,
  sleep,
  calculateBackoffDelay
} from "./lib/errors.ts";

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
// without calling Gemini.
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
  // ESPN primary for season averages; NBA fallback below. Splits, defender,
  // and matchup data have no ESPN equivalent and stay on stats.nba.com.
  const [espnSeasonAvg, splits, winProb, opponentDefense, primaryDefender] = await Promise.all([
    espnId ? espnStats.getSeasonAverages(espnId, { season }) : null,
    getHomeAwaySplits(playerId, { seasonType: "Regular Season" }),
    getWinProbability(game.game_id, game.competition_id),
    opponentSide ? getOpponentDefense(opponentSide.abbr, { seasonType: "Regular Season" }) : null,
    opponentSide ? getPrimaryDefender(playerId, opponentSide.abbr, { seasonType }) : null,
  ]);
  trace.splits = splits ? "nba_stats" : "missing";
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
 * and invokes the Gemini AI model for prop analysis.
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

    // Verify Google API key is configured
    const googleKey = process.env.GOOGLE_API_KEY;
    if (!googleKey) {
      return createErrorResponse(new ConfigurationError("Google API key not configured"));
    }

    // Invoke Gemini model
    const llmResponse = await invokeGeminiModel(googleKey, groundTruth);
    if (llmResponse.isError) {
      return llmResponse.response;
    }

    // Return successful response with LLM output and ground truth
    return createSuccessResponse(llmResponse.data, groundTruth);
  } catch (error) {
    // Handle unexpected errors with proper error categorization
    return createErrorResponse(error);
  }
}

/**
 * Invokes the Gemini AI model with the given ground truth data.
 * @param {string} googleKey - Google API key for Gemini
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {{isError: boolean, response?: Response, data?: Object}} Result containing either the LLM response or error
 */
async function invokeGeminiModel(googleKey, groundTruth) {
  try {
    // Build prompt for Gemini and invoke the model
    const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
    const llm = await callGemini(googleKey, prompt);
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
 * Creates a rate limit exceeded response.
 * @param {number} retryAfterMs - Milliseconds until the rate limit resets
 * @returns {Response} JSON response with rate limit error
 */
function createRateLimitResponse(retryAfterMs) {
  return Response.json(
    { error: "Rate limit exceeded. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } }
  );
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
 * Builds the prompt for the Gemini AI model based on the framework and ground truth data.
 * Constructs a detailed prompt that instructs the model on how to analyze the prop bet.
 * @param {string} framework - The analytical framework to apply
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {string} Formatted prompt for Gemini API
 */
/**
 * Builds the prompt for the Gemini AI model based on the framework and ground truth data.
 * Constructs a detailed prompt that instructs the model on how to analyze the prop bet.
 * @param {string} framework - The analytical framework to apply
 * @param {Object} groundTruth - The verified data to use for analysis
 * @returns {string} Formatted prompt for Gemini API
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
 * Invokes the Gemini AI model with retry logic and fallback.
 * Attempts the primary model up to 3 times with exponential backoff for transient errors,
 * then falls back to the flash-lite model once before giving up.
 * @param {string} apiKey - Google API key for Gemini
 * @param {string} prompt - The prompt to send to the model
 * @returns {Promise<Object>} Result containing either the parsed JSON or error information
 */
export async function callGemini(apiKey, prompt) {
  // Try primary model up to 3 times (1 initial + 2 retries) on transient
  // overload, then fall back to flash-lite once before surfacing the error.
  const PRIMARY = process.env.GEMINI_PRIMARY_MODEL || "gemini-2.5-flash";
  const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite";
  const primaryDelaysStr = process.env.GEMINI_PRIMARY_DELAYS || "0,500,1500";
  const primaryDelays = primaryDelaysStr.split(',').map(delay => parseInt(delay, 10));

  let last;
  for (const delay of primaryDelays) {
    if (delay) await sleep(delay);
    last = await geminiAttempt(apiKey, prompt, PRIMARY);
    if (!last.error || !last.retryable) return stripRetryable(last);
  }

  // Wait briefly before trying fallback model
  const fallbackDelay = parseInt(process.env.GEMINI_FALLBACK_DELAY || '500', 10);
  await sleep(fallbackDelay);
  last = await geminiAttempt(apiKey, prompt, FALLBACK);
  return stripRetryable(last);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripRetryable({ retryable: _r, ...rest }) {
  return rest;
}

async function geminiAttempt(apiKey, prompt, model) {
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
            maxOutputTokens: 8192,
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

  const invalid = validateGeminiOutput(parsed);
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

function validateGeminiOutput(o) {
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
