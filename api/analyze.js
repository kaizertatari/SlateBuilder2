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
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

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

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req));
}

async function handlePost(req) {
  try {
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const limit = rateLimit(`analyze:${ip}`, { windowMs: 60_000, max: 10 });
    if (!limit.ok) {
      return Response.json(
        { error: "Rate limit exceeded. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
      );
    }

    const body = await req.json();
    const { player, propType, line } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!/\s+(OVER|UNDER)\s*$/i.test(propType) || propTypeToField(propType) == null) {
      return Response.json(
        {
          error: `Unknown prop type: "${propType}". Supported: ${Object.keys(PROP_TO_FIELD).map((k) => `${k} OVER/UNDER`).join(", ")}`,
        },
        { status: 400 }
      );
    }

    const gathered = await gatherGroundTruth({ player, propType, line });

    if (gathered.skipReason) {
      return Response.json(skipResult(gathered.skipReason, gathered.message));
    }

    const { groundTruth, missing, trace } = gathered;

    if (missing.length > 0) {
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
        ground_truth: groundTruth,
      });
    }

    const googleKey = process.env.GOOGLE_API_KEY;
    if (!googleKey) {
      return Response.json({ error: "Google API key not configured" }, { status: 500 });
    }

    const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
    const llm = await callGemini(googleKey, prompt);
    if (llm.error) {
      return Response.json({ error: llm.error, debug: llm.debug }, { status: 500 });
    }

    return Response.json({ ...llm.json, ground_truth: groundTruth });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

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

export function propTypeToField(propType) {
  // propType examples: "Points OVER", "Rebounds UNDER", "3-Pointers Made OVER"
  const stat = String(propType).replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
  return PROP_TO_FIELD[stat] ?? null;
}

export function buildPrompt(framework, groundTruth) {
  const field = propTypeToField(groundTruth.prop_type);
  const daysOut = groundTruth.game?.days_out ?? 0;
  const forwardLookingNote = daysOut > 0
    ? `\n\nFORWARD-LOOKING GAME: groundTruth.game.days_out is ${daysOut} — this game is NOT today, it is ${daysOut} day(s) away. Injury reports, win probability, and lineup state may shift before tip-off. You MUST add a flag "📅 forward-looking pick (game ${daysOut}d out) — re-verify injuries closer to tip" and treat any UNDER mechanism that depends on a teammate's confirmed status (e.g., role compression) as A-tier max unless the absence is clearly long-term.`
    : "";
  return `You are the NBA PrizePicks Model v3.4 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.

DATA RULES — non-negotiable:
1. Use ONLY values from the GROUND TRUTH block below. Do NOT invent, estimate, recall from prior knowledge, or guess any number. Treat your training-data memory of player stats as forbidden.
2. Arithmetic on values supplied in GROUND TRUTH is permitted (it is already pre-computed for you in averages.pra / pr / pa / ra). Producing any number that cannot be derived from GROUND TRUTH is a violation.
3. The "data_used" field of your output must echo values directly from GROUND TRUTH. Do not put your own numbers there.
4. If applying a hard gate from the framework requires a value that is null or absent in GROUND TRUTH, set verdict to "SKIP" with a flag like "⚠️ missing: <field>". Do not substitute a guessed value.${forwardLookingNote}

FRAMEWORK:
${framework}

GROUND TRUTH (the only data you may cite):
${JSON.stringify(groundTruth, null, 2)}

WHERE TO FIND VALUES (path → meaning):
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
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins, next_game_number, series_record, series_summary, leading_team_abbr, round, source}; null in regular season. leading_team_abbr is null when series is tied, otherwise the abbr of the team ahead — use it for Rule 5f tied-series and lead-3-0/3-1 gating instead of parsing series_record or series_summary.

For this prop ("${groundTruth.prop_type}" line ${groundTruth.line}), the relevant averages field is "${field ?? "(unknown — output SKIP)"}". Use season.averages.${field ?? "?"} and l5.averages.${field ?? "?"} as the baselines.

OUTPUT (single JSON object):
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
  }
}`;
}

export async function callGemini(apiKey, prompt) {
  // Try primary model up to 3 times (1 initial + 2 retries) on transient
  // overload, then fall back to flash-lite once before surfacing the error.
  const PRIMARY = "gemini-2.5-flash";
  const FALLBACK = "gemini-2.5-flash-lite";
  const primaryDelays = [0, 500, 1500];

  let last;
  for (const delay of primaryDelays) {
    if (delay) await sleep(delay);
    last = await geminiAttempt(apiKey, prompt, PRIMARY);
    if (!last.error || !last.retryable) return stripRetryable(last);
  }

  await sleep(500);
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
