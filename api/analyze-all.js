// Batch analyze PrizePicks lines for a single player using the existing
// framework. For each (player, stat_type) bucket, picks the lowest line
// PrizePicks publishes and analyzes only that line, sharing one
// ground-truth fetch across both OVER and UNDER directions when applicable.
//
// POST /api/analyze-all
// Body: { player: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
//
// Returns: { total_analyzed, total_s_a, top_10: [...] }

import { gatherGroundTruth, buildPrompt, callGemini } from "./analyze.js";
import { MODEL_FRAMEWORK } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { readLines } from "./lib/lines-store.js";
import { STATS, PROP_TO_FIELD, mapPrizePicksStatType } from "./lib/prop-types.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

// Bounded by Gemini cost / rate-limit, not by Vercel platform timeout
// (default 300s on all plans). CONCURRENCY=2 doubles throughput so 2-line
// × BOTH-direction × 9-stat coverage (36 tasks) finishes inside 300s; in
// the worst case where every task hits the primary→fallback retry chain
// (up to 4 calls/task), CONCURRENCY=2 can briefly burst 8 Gemini requests
// in ~2s — at the edge of the free-tier 10–20 RPM quota. Drop back to 1
// if you start seeing 429s in `errors`.
const MAX_LINES = 36;
const CONCURRENCY = 2;

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
      const retryAfterMs = limit.retryAfterMs ?? 0;
      return Response.json(
        { error: "Rate limit exceeded. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } }
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
      : new Set(STATS);

      // Group props by stat (each bucket holds every line PrizePicks publishes
      // for that (player, stat) — we'll pick the lowest one).
      const buckets = new Map();
     for (const prop of playerProps) {
       const stat = mapPrizePicksStatType(prop.stat_type);
       if (!stat || !allowedStats.has(stat)) continue;
       let props = buckets.get(stat);
       if (props === undefined) {
         props = [];
         buckets.set(stat, props);
       }
       props.push(prop);
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

     // For each bucket: pick the lowest and median PrizePicks lines, fetch
     // ground truth once for the stat (line-independent for this codepath),
     // then push a task per chosen line × direction reusing the cached
     // groundTruth. If only one line is published, or lowest and median
     // resolve to the same line value, the duplicate is dropped so we don't
     // analyze the same prop twice.
       const tasks = [];
       const skipped = [];

     for (const [stat, props] of buckets) {
       if (tasks.length >= MAX_LINES) break;

          // Tag each chosen prop with its PrizePicks line type so the UI can
          // surface it in a column. When only one line is published the
          // dedupe collapses to a single entry — label it "Normal" since a
          // standalone line is the standard offer, not a Goblin discount.
          const sorted = [...props].sort((a, b) => a.line - b.line);
          const lowest = sorted[0];
          const median = sorted[Math.floor(sorted.length / 2)];
          const chosenLines = lowest.line === median.line
            ? [{ prop: lowest, lineType: "Normal" }]
            : [{ prop: lowest, lineType: "Goblin" }, { prop: median, lineType: "Normal" }];

       const groundTruthResult = await gatherGroundTruth({
         player,
         propType: `${stat} ${directions[0]}`,
         line: chosenLines[0].line,
       });
       if (groundTruthResult.skipReason) {
         skipped.push({ stat, reason: groundTruthResult.skipReason });
         continue;
       }

       const groundTruth = groundTruthResult.groundTruth;
       for (const { prop: chosen, lineType } of chosenLines) {
         if (tasks.length >= MAX_LINES) break;
         const game = `${chosen.player_team || ""} @ ${chosen.opponent || ""}`;
         for (const dir of directions) {
           if (tasks.length >= MAX_LINES) break;
           tasks.push({
             player,
             statType: stat,
             direction: dir,
             line: chosen.line,
             lineType,
             propType: `${stat} ${dir}`,
             game,
             groundTruth,
           });
         }
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

async function analyzeSingle({ player, statType, line, lineType, propType, game, groundTruth: cachedGroundTruth }) {
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

  // Build prompt and call Gemini, with one outer retry on transient failures
  // not already handled inside callGemini's primary→fallback chain (e.g.,
  // schema-validation rejections, post-fallback overload).
  const prompt = buildPrompt(MODEL_FRAMEWORK, groundTruth);
  let llm = await callGemini(apiKey, prompt);
  if (llm.error) {
    await new Promise((r) => setTimeout(r, 1500));
    llm = await callGemini(apiKey, prompt);
  }

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
    line_type: lineType,
    verdict: result.verdict,
    tier: result.tier,
    confidence: result.confidence || 0,
    justification: result.justification || "",
  };
}
