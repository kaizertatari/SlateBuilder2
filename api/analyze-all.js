// Batch analyze PrizePicks lines using the existing framework.
// Filters by player, stat types, and direction, runs the Gemini model,
// and returns top 10 S/A tier results as a table.
//
// POST /api/analyze-all
// Body: { player?: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
//
// Returns: { total_analyzed, total_s_a, top_10: [...] }

import { gatherGroundTruth, buildPrompt, callGemini, PROP_TO_FIELD } from "./analyze.js";
import { MODEL_FRAMEWORK } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { readLines } from "./lib/lines-store.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

// Bounded by Gemini cost / rate-limit, not by Vercel platform timeout
// (default 300s on all plans).
const MAX_LINES = 25;
const CONCURRENCY = 3;

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req, reqId));
}

async function handlePost(req, reqId) {
  try {
    // Rate limit (stricter for batch)
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const limit = rateLimit(`analyze-all:${ip}`, { windowMs: 60_000, max: 3 });
    if (!limit.ok) {
      return Response.json(
        { error: "Rate limit exceeded. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
      );
    }

    const body = await req.json();
    const { player, statTypes, direction } = body;

    // Validate direction if provided
    if (direction && !["OVER", "UNDER"].includes(direction)) {
      return Response.json(
        { error: "direction must be 'OVER' or 'UNDER'" },
        { status: 400 }
      );
    }

    // Read PrizePicks lines (from /tmp cache when warm, else bundled file).
    let linesData;
    try {
      linesData = await readLines();
    } catch {
      return Response.json(
        { error: "No lines data available. Run: npm run refresh-prizepicks (local) or POST /api/refresh-lines (deployed)." },
        { status: 404 }
      );
    }

    let allProps = [];

    // Collect props from by_player
    if (player) {
      // Filter by specific player
      const normalizedPlayer = player.toLowerCase();
      for (const [name, props] of Object.entries(linesData.by_player || {})) {
        if (name.toLowerCase() === normalizedPlayer || name.toLowerCase().includes(normalizedPlayer)) {
          allProps.push(...props);
        }
      }
    } else {
      // All players
      for (const props of Object.values(linesData.by_player || {})) {
        allProps.push(...props);
      }
    }

    // Filter by stat types if provided
    if (statTypes && Array.isArray(statTypes) && statTypes.length > 0) {
      const validStats = new Set(statTypes.map(s => s.toLowerCase()));
      allProps = allProps.filter(p => {
        const mapped = mapStatType(p.stat_type);
        return mapped && validStats.has(mapped.toLowerCase());
      });
    } else {
      // Default: only include stats from STATS array (Points, Rebounds, Assists, PRA, PR, PA, RA, 3-Pointers Made, FG Attempted)
      const defaultMapped = new Set(["points", "rebounds", "assists", "pra", "pr", "pa", "ra", "3-pointers made", "fg attempted"]);
      allProps = allProps.filter(p => {
        const mapped = mapStatType(p.stat_type);
        return mapped && defaultMapped.has(mapped.toLowerCase());
      });
    }

    // Filter by direction if provided
    const directions = direction ? [direction] : ["OVER", "UNDER"];

    // Build analysis tasks (limit to MAX_LINES)
    const tasks = [];
    const seen = new Set();

    for (const prop of allProps) {
      if (tasks.length >= MAX_LINES) break;

      const playerKey = prop.player_key || prop.player;
      const statType = prop.stat_type;

      // Map PrizePicks stat type to our internal stat type
      const mappedStatType = mapStatType(statType);
      
      // Skip if we can't map this stat type to a supported one
      if (!mappedStatType || !PROP_TO_FIELD[mappedStatType]) continue;

      for (const dir of directions) {
        if (tasks.length >= MAX_LINES) break;

        // Avoid duplicates (same player + stat + direction)
        const key = `${playerKey}:${mappedStatType}:${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);

        tasks.push({
          player: playerKey,
          statType: mappedStatType,
          direction: dir,
          line: prop.line,
          propType: `${mappedStatType} ${dir}`,
          game: `${prop.player_team || ""} @ ${prop.opponent || ""}`,
        });
      }
    }

    if (tasks.length === 0) {
      return Response.json({
        request_id: reqId,
        total_analyzed: 0,
        total_s_a: 0,
        top_10: [],
        message: "No matching lines found for the given filters.",
      });
    }

    // Process tasks in parallel batches (CONCURRENCY at a time) to use the
    // 300s function budget without hammering Gemini.
    const results = [];
    const errors = [];

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
      const batch = tasks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((t) => analyzeSingle(t)));
      settled.forEach((s, idx) => {
        const task = batch[idx];
        if (s.status === "fulfilled") {
          const r = s.value;
          if (r && (r.tier === "S" || r.tier === "A")) results.push(r);
        } else {
          errors.push({ task: `${task.player} ${task.propType}`, error: s.reason?.message || String(s.reason) });
        }
      });
    }

    // Sort by tier (S first), then confidence (desc)
    results.sort((a, b) => {
      const tierOrder = { S: 0, A: 1 };
      const tierDiff = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
      if (tierDiff !== 0) return tierDiff;
      return (b.confidence || 0) - (a.confidence || 0);
    });

    // Return top 10
    const top10 = results.slice(0, 10);

    return Response.json({
      request_id: reqId,
      total_analyzed: tasks.length,
      total_s_a: results.length,
      top_10: top10,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    return Response.json({ request_id: reqId, error: error.message }, { status: 500 });
  }
}

function mapStatType(statType) {
  if (!statType) return null;
  const s = statType.toLowerCase();
  // Map PrizePicks stat types to our internal STATS array values
  const map = {
    "pts+rebs+asts": "PRA",
    "pts+rebs": "PR",
    "pts+asts": "PA",
    "rebs+asts": "RA",
    "3-pt made": "3-Pointers Made",
    "fg attempted": "FG Attempted",
    "points": "Points",
    "rebounds": "Rebounds",
    "assists": "Assists",
  };
  return map[s] || null;
}

async function analyzeSingle({ player, statType, line, propType, game }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Google API key not configured");

  // Gather ground truth
  const groundTruthResult = await gatherGroundTruth({ player, propType, line });
  if (groundTruthResult.skipReason) return null;

  const { groundTruth } = groundTruthResult;

  // Build prompt and call Gemini
  const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
  const llm = await callGemini(apiKey, prompt);

  if (llm.error) throw new Error(llm.error);

  const result = llm.json;

  // Ensure result has required fields
  if (!result || !result.verdict || !result.tier) return null;

  return {
    player,
    game: game || "—",
    prop_type: statType,
    direction: result.verdict,
    line,
    verdict: result.verdict,
    tier: result.tier,
    confidence: result.confidence || 0,
    justification: result.justification || "",
  };
}
