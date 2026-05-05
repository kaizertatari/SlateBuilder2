// Batch analyze PrizePicks lines for a single player using the existing
// framework. For each (player, stat_type) bucket, picks the lowest line
// PrizePicks publishes and analyzes only that line, sharing one
// ground-truth fetch across both OVER and UNDER directions when applicable.
//
// POST /api/analyze-all
// Body: { player: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
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
// (default 300s on all plans). CONCURRENCY=1 keeps us under Gemini's
// free-tier 20 req/min quota — the primary-then-fallback retry chain in
// callGemini can burn up to 4 requests per failed task, which trips the
// quota fast at higher concurrency.
const MAX_LINES = 25;
const CONCURRENCY = 1;

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

    if (!player || typeof player !== "string") {
      return Response.json(
        { error: "player (string) is required" },
        { status: 400 }
      );
    }
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

    // Find the player's props (exact match on by_player keys).
    const playerProps = (linesData.by_player || {})[player] || [];

    // Resolve allowed internal stat names (default: full STATS whitelist).
    const allowedStats = (statTypes && Array.isArray(statTypes) && statTypes.length > 0)
      ? new Set(statTypes)
      : new Set(["Points", "Rebounds", "Assists", "PRA", "PR", "PA", "RA", "3-Pointers Made", "FG Attempted"]);

    // Group props by stat (each bucket holds every line PrizePicks publishes
    // for that (player, stat) — we'll pick the lowest one).
    const buckets = new Map();
    for (const prop of playerProps) {
      const stat = mapStatType(prop.stat_type);
      if (!stat || !allowedStats.has(stat) || !PROP_TO_FIELD[stat]) continue;
      if (!buckets.has(stat)) buckets.set(stat, []);
      buckets.get(stat).push(prop);
    }

    if (buckets.size === 0) {
      return Response.json({
        request_id: reqId,
        total_analyzed: 0,
        total_s_a: 0,
        top_10: [],
        message: "No matching lines found for the given filters.",
      });
    }

    const directions = direction ? [direction] : ["OVER", "UNDER"];
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return Response.json(
        { request_id: reqId, error: "Google API key not configured" },
        { status: 500 }
      );
    }

    // For each bucket: pick the lowest PrizePicks line, fetch ground truth
    // once for that line, then push a task per requested direction reusing
    // the cached groundTruth.
    const tasks = [];
    const skipped = [];

    for (const [stat, props] of buckets) {
      if (tasks.length >= MAX_LINES) break;

      const chosen = props.reduce((best, p) => (p.line < best.line ? p : best));

      const groundTruthResult = await gatherGroundTruth({
        player,
        propType: `${stat} ${directions[0]}`,
        line: chosen.line,
      });
      if (groundTruthResult.skipReason) {
        skipped.push({ stat, reason: groundTruthResult.skipReason });
        continue;
      }

      const game = `${chosen.player_team || ""} @ ${chosen.opponent || ""}`;
      for (const dir of directions) {
        if (tasks.length >= MAX_LINES) break;
        tasks.push({
          player,
          statType: stat,
          direction: dir,
          line: chosen.line,
          propType: `${stat} ${dir}`,
          game,
          groundTruth: groundTruthResult.groundTruth,
        });
      }
    }

    if (tasks.length === 0) {
      return Response.json({
        request_id: reqId,
        total_analyzed: 0,
        total_s_a: 0,
        top_10: [],
        skipped: skipped.length > 0 ? skipped : undefined,
        message: "All buckets skipped before analysis (see `skipped`).",
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
      skipped: skipped.length > 0 ? skipped : undefined,
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

async function analyzeSingle({ player, statType, line, propType, game, groundTruth: cachedGroundTruth }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Google API key not configured");

  // Reuse the cached ground truth when the dedup pipeline supplied one,
  // otherwise fetch fresh. The cached object was gathered with a placeholder
  // direction/line — overwrite both so the prompt evaluates this task.
  let groundTruth;
  if (cachedGroundTruth) {
    groundTruth = { ...cachedGroundTruth, prop_type: propType, line };
  } else {
    const r = await gatherGroundTruth({ player, propType, line });
    if (r.skipReason) return null;
    groundTruth = r.groundTruth;
  }

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
