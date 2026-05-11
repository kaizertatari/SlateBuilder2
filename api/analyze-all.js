// Batch analyze PrizePicks lines for a single player using the existing
// framework. For each (player, stat_type) bucket, picks the lowest line
// PrizePicks publishes and analyzes only that line, sharing one
// ground-truth fetch across both OVER and UNDER directions when applicable.
//
// POST /api/analyze-all
// Body: { player: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
//
// Returns: { total_analyzed, total_s_a, top_10: [...] }

import { gatherGroundTruth, buildBatchPrompt, callLLMBatched } from "./analyze.js";
import { MODEL_FRAMEWORK } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { readLines } from "./lib/lines-store.js";
import { STATS, mapPrizePicksStatType } from "./lib/prop-types.js";
import { get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

// Response cache TTL. Primary invalidation is via the key itself
// (incorporates linesData.fetched_at), so when the cron at 5/17 UTC rewrites
// lines, prior keys become unreachable. The TTL is a defensive bound past
// the 12h cron cadence to keep the Map from growing unbounded on a
// long-lived warm instance.
const CACHE_TTL_MS = 13 * 60 * 60 * 1000;

function normalizePlayer(name) {
  return name.trim().toLowerCase();
}

function buildCacheKey(player, fetchedAt, sortedStats, direction) {
  return `analyze-all:${normalizePlayer(player)}::${fetchedAt || "unknown"}::${sortedStats}::${direction}`;
}

// Per-player line budget. With batched LLM calls this no longer maps 1:1
// to request count — N lines now cost ceil(N / LLM_BATCH_SIZE) calls.
// 40 gives headroom for "32+ lines per player" once line-picking expands
// beyond lowest-only (currently 9 stats × 2 directions = 18 max).
const MAX_LINES = parseInt(process.env.MAX_LINES_PER_PLAYER || "40", 10);

// How many (line, direction) tuples to batch per LLM call. Each task in
// the batch adds ~220 tokens to the output budget; 8 keeps us under the
// 4000-token output cap with margin. Smaller batches reduce blast radius
// if a single task fails schema validation (entire batch retried).
const LLM_BATCH_SIZE = parseInt(process.env.LLM_BATCH_SIZE || "8", 10);

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

    // Cache lookup. Inputs are deterministic in (player, fetched_at,
    // statTypes, direction) — between cron ticks (12h), the same inputs
    // yield the same response. A hit skips every external API call and
    // every LLM call. fetched_at is embedded in the key, so the next
    // cron-driven refresh makes prior keys unreachable.
    const linesFetchedAt = linesData.fetched_at || null;
    const sortedStats = (Array.isArray(statTypes) && statTypes.length > 0)
      ? [...statTypes].sort().join(",")
      : "ALL";
    const normDirection = direction || "BOTH";
    const cacheKey = buildCacheKey(player, linesFetchedAt, sortedStats, normDirection);
    const cached = cacheGet(cacheKey);
    if (cached) {
      return Response.json(cached, { headers: { "X-Cache": "HIT" } });
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
      const responseBody = {
        request_id: reqId,
        total_analyzed: 0,
        total_s_a: 0,
        top_10: [],
        lines_fetched_at: linesFetchedAt,
        message: "No matching lines found for the given filters.",
      };
      cacheSet(cacheKey, responseBody, CACHE_TTL_MS);
      return Response.json(responseBody, { headers: { "X-Cache": "MISS" } });
    }

     const directions = direction ? [direction] : ["OVER", "UNDER"];
    // Router (callLLM) picks Groq/Gemini per request from env. Require
    // at least one provider key to be set; per-call selection happens
    // inside the router via LLM_PROVIDERS.
    if (!process.env.GROQ_API_KEY && !process.env.GOOGLE_API_KEY) {
      return Response.json(
        { request_id: reqId, error: "No LLM provider configured (set GROQ_API_KEY and/or GOOGLE_API_KEY)" },
        { status: 500 }
      );
    }

     // Build the task list once per player. groundTruth is fetched a single
     // time for the entire player (it is stat-agnostic except for the
     // prop_type/line metadata fields, which buildBatchPrompt strips). Any
     // player-wide skip (no upcoming game, retired, etc.) short-circuits
     // the whole request.
     //
     // Per stat: pick BOTH the lowest line (PrizePicks "discount") and the
     // median line so the model gets a shot at each price point. This was
     // reverted in 2cfcdc7 because Gemini free-tier 20 RPM couldn't sustain
     // 36 tasks; now that batching collapses N tasks into ~ceil(N/8) LLM
     // calls, even 40 tasks cost only ~5 calls — well under any cap.
       const tasks = [];
       const skipped = [];
       let sharedGroundTruth = null;

     for (const [stat, props] of buckets) {
       if (tasks.length >= MAX_LINES) break;

          // Lowest + median. If only one distinct line is published (or
          // lowest === median), dedupe so we don't analyze the same prop
          // twice.
          const sorted = [...props].sort((a, b) => a.line - b.line);
          const lowest = sorted[0];
          const median = sorted[Math.floor(sorted.length / 2)];
          const chosenLines = lowest.line === median.line ? [lowest] : [lowest, median];

       // Fetch the player-wide groundTruth on first stat we see. Reuse for
       // every subsequent bucket — caches inside gatherGroundTruth would
       // make repeated calls cheap, but batching needs ONE shared object
       // anyway.
       if (!sharedGroundTruth) {
         const r = await gatherGroundTruth({
           player,
           propType: `${stat} ${directions[0]}`,
           line: lowest.line,
         });
         if (r.skipReason) {
           // Player-wide skip — record and stop building tasks.
           skipped.push({ stat, reason: r.skipReason });
           break;
         }
         sharedGroundTruth = r.groundTruth;
       }

       for (const chosen of chosenLines) {
         if (tasks.length >= MAX_LINES) break;
         const game = `${chosen.player_team || ""} @ ${chosen.opponent || ""}`;
         for (const dir of directions) {
           if (tasks.length >= MAX_LINES) break;
           tasks.push({
             id: `${stat}-${dir}-${chosen.line}`,
             player,
             statType: stat,
             direction: dir,
             line: chosen.line,
             oddsType: chosen.odds_type || null,
             propType: `${stat} ${dir}`,
             game,
           });
         }
       }
     }

    if (tasks.length === 0) {
      const responseBody = {
        request_id: reqId,
        total_analyzed: 0,
        total_s_a: 0,
        top_10: [],
        lines_fetched_at: linesFetchedAt,
        skipped: skipped.length > 0 ? skipped : undefined,
        message: "All buckets skipped before analysis (see `skipped`).",
      };
      cacheSet(cacheKey, responseBody, CACHE_TTL_MS);
      return Response.json(responseBody, { headers: { "X-Cache": "MISS" } });
    }

    // Batched LLM path: each call evaluates up to LLM_BATCH_SIZE tasks.
    // The router (callLLMBatched) rotates Groq/Gemini per call so two
    // batches go to two providers. tier_counts captures the verdict
    // distribution across all completed analyses.
    const results = [];
    const errors = [];
    const tierCounts = { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 };
    const tasksById = new Map(tasks.map((t) => [t.id, t]));

    for (let i = 0; i < tasks.length; i += LLM_BATCH_SIZE) {
      const chunk = tasks.slice(i, i + LLM_BATCH_SIZE);
      const promptTasks = chunk.map((t) => ({ id: t.id, prop_type: t.propType, line: t.line }));
      const expectedIds = promptTasks.map((t) => t.id);
      const prompt = buildBatchPrompt(MODEL_FRAMEWORK, sharedGroundTruth, promptTasks);

      let llm = await callLLMBatched(prompt, expectedIds);
      if (llm.error) {
        // One outer retry: the router has already exhausted both providers'
        // primary→fallback chains, so this is a last-ditch attempt against
        // transient provider-wide weather.
        await new Promise((r) => setTimeout(r, 1500));
        llm = await callLLMBatched(prompt, expectedIds);
      }

      if (llm.error) {
        for (const t of chunk) {
          errors.push({ task: `${t.player} ${t.propType}`, error: llm.error });
          tierCounts.UNKNOWN += 1;
        }
        continue;
      }

      for (const r of llm.json.results) {
        const task = tasksById.get(r.id);
        if (!task) continue;  // validator shouldn't allow this, defensive
        const tierKey = tierCounts[r.tier] !== undefined ? r.tier : "UNKNOWN";
        tierCounts[tierKey] += 1;
        if (r.tier === "S" || r.tier === "A") {
          results.push({
            player: task.player,
            game: task.game || "—",
            prop_type: task.statType,
            direction: r.verdict,
            line: task.line,
            odds_type: task.oddsType,
            verdict: r.verdict,
            tier: r.tier,
            confidence: r.confidence || 0,
            justification: r.justification || "",
          });
        }
      }
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

    // Cache the full response. Partial-failure responses (errors[] non-empty)
    // are cached on purpose: user picked fetched_at-only invalidation, so a
    // retry within the same window would re-spend tokens for the same
    // chance of success. Errors clear at the next cron tick.
    const responseBody = {
      request_id: reqId,
      total_analyzed: tasks.length,
      total_s_a: results.length,
      tier_counts: tierCounts,
      top_10: top10,
      lines_fetched_at: linesFetchedAt,
      errors: errors.length > 0 ? errors : undefined,
      skipped: skipped.length > 0 ? skipped : undefined,
    };
    cacheSet(cacheKey, responseBody, CACHE_TTL_MS);
    return Response.json(responseBody, { headers: { "X-Cache": "MISS" } });

  } catch (error) {
    return Response.json({ request_id: reqId, error: error.message }, { status: 500 });
  }
}

// analyzeSingle was the pre-batching per-task path; the batched flow in
// handlePost replaced it. Kept removed to avoid dead-code drift — restore
// from git history (commit before this refactor) if you need a one-shot
// LLM evaluator that mirrors the analyze.js handler. For one-off prop
// analysis, prefer POST /api/analyze.
