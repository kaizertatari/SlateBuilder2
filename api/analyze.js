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
import {
  getTodaysGames,
  findGameForTeamAbbr,
  findNextGameForTeamAbbr,
  getWinProbability,
  getAllInjuries,
} from "./lib/espn.js";
import { composeGroundTruth } from "./lib/ground-truth.js";
import { MODEL_FRAMEWORK } from "./lib/framework.js";

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

  const [nbaInfo, games, allInjuries] = await Promise.all([
    getCommonPlayerInfo(playerId),
    getTodaysGames(),
    getAllInjuries(),
  ]);

  if (!games) return { skipReason: "schedule_unavailable", message: "Could not fetch ESPN scoreboard" };

  // Identity: stats.nba.com primary, balldontlie fallback (free-tier OK).
  // Only team_abbr is strictly required downstream.
  let info = nbaInfo;
  if (!info) {
    const bdlPlayer = await bdl.findPlayer(player);
    if (!bdlPlayer || !bdlPlayer.team_abbr) {
      return { skipReason: "player_lookup_failed", message: `Could not resolve ${player} via stats.nba.com or balldontlie` };
    }
    info = {
      player_id: playerId,
      full_name: bdlPlayer.full_name,
      team_id: null,
      team_name: bdlPlayer.team_name,
      team_abbr: bdlPlayer.team_abbr,
    };
  }

  let game = findGameForTeamAbbr(games, info.team_abbr);
  let daysOut = 0;
  if (!game) {
    const next = await findNextGameForTeamAbbr(info.team_abbr, 7);
    if (!next) return { skipReason: "no_upcoming_game", message: `${info.team_name ?? info.team_abbr} has no game in the next 7 days` };
    game = next.game;
    daysOut = next.days_out;
  }

  // Detect season type: playoffs first, then regular season. Each tier tries
  // stats.nba.com then ESPN gamelog before giving up.
  let seasonType = "Playoffs";
  let l5 = await getLastNGames(playerId, 5, { seasonType });
  if (!l5 || !l5.games?.length) l5 = await espnStats.getLastNGames(espnId, 5, { season, postseason: true });
  if (!l5 || !l5.games?.length) {
    seasonType = "Regular Season";
    l5 = await getLastNGames(playerId, 5, { seasonType });
    if (!l5 || !l5.games?.length) l5 = await espnStats.getLastNGames(espnId, 5, { season, postseason: false });
  }

  const [nbaSeasonAvg, splits, winProb] = await Promise.all([
    getSeasonAverages(playerId, { seasonType: "Regular Season" }),
    getHomeAwaySplits(playerId, { seasonType: "Regular Season" }),
    getWinProbability(game.game_id, game.competition_id),
  ]);
  const seasonAvg = nbaSeasonAvg ?? await espnStats.getSeasonAverages(espnId, { season });

  const { groundTruth, missing } = composeGroundTruth({
    player, propType, line,
    info, game, daysOut, seasonType,
    seasonAvg, l5, splits, winProb, allInjuries,
  });

  return { groundTruth, missing };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { player, propType, line } = body;

    if (!player || !propType || !line) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    const gathered = await gatherGroundTruth({ player, propType, line });

    if (gathered.skipReason) {
      return Response.json(skipResult(gathered.skipReason, gathered.message));
    }

    const { groundTruth, missing } = gathered;

    if (missing.length > 0) {
      return Response.json({
        verdict: "SKIP",
        tier: "SKIP",
        confidence: 0,
        justification: `Missing required data: ${missing.join(", ")}. Cannot apply framework.`,
        flags: missing.map((f) => `⚠️ missing: ${f}`),
        data_used: null,
        ground_truth: groundTruth,
      });
    }

    const googleKey = process.env.GOOGLE_API_KEY || process.env.VITE_GOOGLE_API_KEY;
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

// Maps a prop_type string to the matching key inside an averages object.
// Exported so the smoke script can inspect.
export const PROP_TO_FIELD = {
  Points: "ppg",
  Rebounds: "rpg",
  Assists: "apg",
  PRA: "pra",
  PR: "pr",
  PA: "pa",
  "3-Pointers Made": "fg3m",
};

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
  return `You are the NBA PrizePicks Model v3.3 verdict engine. Output exactly one JSON object — no prose, no markdown, no code fences.

DATA RULES — non-negotiable:
1. Use ONLY values from the GROUND TRUTH block below. Do NOT invent, estimate, recall from prior knowledge, or guess any number. Treat your training-data memory of player stats as forbidden.
2. Arithmetic on values supplied in GROUND TRUTH is permitted (it is already pre-computed for you in averages.pra / pr / pa). Producing any number that cannot be derived from GROUND TRUTH is a violation.
3. The "data_used" field of your output must echo values directly from GROUND TRUTH. Do not put your own numbers there.
4. If applying a hard gate from the framework requires a value that is null or absent in GROUND TRUTH, set verdict to "SKIP" with a flag like "⚠️ missing: <field>". Do not substitute a guessed value.${forwardLookingNote}

FRAMEWORK:
${framework}

GROUND TRUTH (the only data you may cite):
${JSON.stringify(groundTruth, null, 2)}

WHERE TO FIND VALUES (path → meaning):
- groundTruth.season.averages.{ppg,rpg,apg,pra,pr,pa,fg3m,fg_pct,ft_pct,fg3_pct,minutes}  → regular-season per-game averages
- groundTruth.l5.averages.{ppg,rpg,apg,pra,pr,pa,fg3m,minutes}                              → most-recent 5 games (playoff if l5.type==="Playoffs")
- groundTruth.splits.{home,road}.{...}                                                       → regular-season home/away splits
- groundTruth.home_away                                                                       → "home" | "away" for tonight's game
- groundTruth.opponent_team.name / abbr                                                       → tonight's opponent
- groundTruth.win_prob.player_team_pct                                                        → 0-1 float (multiply by 100 for the % the framework uses)
- groundTruth.injuries.player_team / opponent                                                 → {player,status,detail,date}[] (used for role compression / matchup ceiling)
- groundTruth.player_recent.is_listed_injured                                                 → boolean — TRUE means post-injury return gate (Section 6) applies
- groundTruth.series                                                                          → playoff series state {games_played, player_team_wins, opponent_wins}; null in regular season

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
    "game_context": <short string referencing season.label, season.type, and series state if playoff, e.g. "2025-26 Playoffs G5, DEN trails 1-3">
  }
}`;
}

async function callGemini(apiKey, prompt) {
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
    return { error: `Gemini fetch failed: ${err.message}` };
  }

  const data = await res.json();
  if (data.error) return { error: data.error.message };

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

  try {
    return { json: JSON.parse(jsonStr) };
  } catch (e) {
    return { error: `JSON parse failed: ${e.message} (finishReason: ${finishReason})`, debug: jsonStr.slice(0, 800) };
  }
}
