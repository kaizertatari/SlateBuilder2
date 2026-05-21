// Batch analyze PrizePicks lines for a single player using the existing
// framework. For each (player, stat_type) bucket, picks the lowest line
// PrizePicks publishes and analyzes only that line, sharing one
// ground-truth fetch across both OVER and UNDER directions when applicable.
//
// POST /api/analyze-all
// Body: { player: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
//
// Returns: { total_analyzed, total_s_a, top_10: [...] }

import { gatherGroundTruth, buildPrompt, callLLM, UNJUSTIFIED_SKIP_RETRY_ADDENDUM } from "./analyze.js";
import { getFramework } from "./lib/framework.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { readLines } from "./lib/lines-store.js";
import { STATS, mapPrizePicksStatType } from "./lib/prop-types.js";
import { get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { verifyVerdict, preFilterMechanical } from "./lib/verdict-verifier.js";
import { logVerdict } from "./lib/verdict-logger.js";
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

/**
 * Choose which lines from a (player, stat) bucket get analyzed.
 *
 * Priority order:
 *   1. Lowest-line goblin (easier OVER, discount payout)
 *   2. Standard (regular price)
 * Demon lines (harder OVER, boosted payout) are intentionally not analyzed.
 *
 * Fallback: if neither goblin nor standard exists for the stat — common
 * for combo props and newly-published stat types — return the lowest
 * available line of any type. Keeps coverage instead of silently dropping
 * the bucket.
 *
 * Dedupe: if goblin and standard land on the same numeric line (rare but
 * possible), return one entry.
 *
 * Exported so the smoke test can re-derive the same selection from the
 * raw lines JSON.
 *
 * @param {Array<Object>} props  props for one (player, stat) bucket
 * @returns {Array<Object>} 0-2 chosen line objects
 */
export function selectLinesForStat(props) {
  if (!Array.isArray(props) || props.length === 0) return [];
  const lowestByType = (type) =>
    props
      .filter((p) => p.odds_type === type)
      .sort((a, b) => a.line - b.line)[0] ?? null;
  const goblin = lowestByType("goblin");
  const standard = lowestByType("standard");
  const chosen = [];
  if (goblin) chosen.push(goblin);
  if (standard && (!goblin || standard.line !== goblin.line)) chosen.push(standard);
  if (chosen.length === 0) {
    const fallback = [...props].sort((a, b) => a.line - b.line)[0];
    if (fallback) chosen.push(fallback);
  }
  return chosen;
}

// Per-player line budget. Each task is now one LLM call (looped, not
// batched), so this directly caps LLM calls per analyze-all request.
// Default 40 covers the realistic max (9 stats × 2 lines × 2 dirs = 36).
// Lower this if free-tier daily quotas tighten.
const MAX_LINES = parseInt(process.env.MAX_LINES_PER_PLAYER || "40", 10);

// We deliberately do NOT batch the LLM calls anymore — buildBatchPrompt /
// callLLMBatched still exist in analyze.js for one-off use but the
// batched LLM was diverging from the single-prop endpoint (different
// reasoning, attention dilution, smaller per-task token budget). Looping
// single-prop calls is slower on cold cache but guarantees both endpoints
// produce the same verdict for the same ground truth. The verifier in
// api/lib/verdict-verifier.js is the second layer of defense.

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
    const { player, statTypes, direction, league: rawLeague } = body;

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
    const league = rawLeague && ["NBA", "WNBA"].includes(String(rawLeague).toUpperCase())
      ? String(rawLeague).toUpperCase()
      : null;

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

    // Find the player's props (exact match on by_player keys). If the client
    // sent a league, filter cross-league props out — defends against the rare
    // case where the scraper grouped an NBA + WNBA player with the same name
    // under one by_player entry.
    const rawPlayerProps = (linesData.by_player || {})[player] || [];
    const playerProps = league
      ? rawPlayerProps.filter((p) => (p.league ?? "NBA") === league)
      : rawPlayerProps;

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
     // Per stat: pick the LOWEST GOBLIN line (PrizePicks "discount" — the
     // easier OVER) plus the STANDARD line (regular price). Matches the
     // two price points the operator is most likely to bet from. Demon
     // lines (harder OVER, higher payout) are intentionally NOT analyzed.
     // Fallback: if a stat has neither goblin nor standard (rare — typically
     // a combo stat or new prop type), analyze the lowest line of any type
     // so we don't silently lose coverage.
       const tasks = [];
       const skipped = [];
       let sharedGroundTruth = null;
       // Captured alongside sharedGroundTruth on the first successful
       // gatherGroundTruth call. They describe the player and the data
       // sources used; both apply to every task in this request.
       let sharedTrace = null;
       let sharedPlayerInfo = null;

     for (const [stat, props] of buckets) {
       if (tasks.length >= MAX_LINES) break;
       const chosenLines = selectLinesForStat(props);
       if (chosenLines.length === 0) continue;

       // Fetch the player-wide groundTruth on first stat we see. Reuse for
       // every subsequent bucket — caches inside gatherGroundTruth would
       // make repeated calls cheap, but batching needs ONE shared object
       // anyway.
       if (!sharedGroundTruth) {
         const r = await gatherGroundTruth({
           player,
           propType: `${stat} ${directions[0]}`,
           // groundTruth is line-agnostic except for the prop_type/line metadata
           // (overwritten per-task below), so any chosen line works as a seed.
           line: chosenLines[0].line,
         });
         if (r.skipReason) {
           // Player-wide skip — record and stop building tasks.
           skipped.push({ stat, reason: r.skipReason });
           break;
         }
         sharedGroundTruth = r.groundTruth;
         sharedTrace = r.trace ?? null;
         sharedPlayerInfo = r.playerInfo ?? null;
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

    // Serial single-prop LLM path: one call per task using the exact
    // same prompt builder as /api/analyze. The router (callLLM) rotates
    // Groq/Gemini per call, so consecutive tasks naturally alternate
    // providers. tier_counts captures the verdict distribution across
    // all completed analyses.
    const results = [];
    const errors = [];
    const tierCounts = { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 };

    for (const task of tasks) {
      // sharedGroundTruth has the FIRST task's prop_type/line baked in
      // (from the initial gatherGroundTruth call). Overwrite with this
      // task's values so buildPrompt embeds the correct prop in the
      // role-definition and output-spec sections.
      const taskGroundTruth = {
        ...sharedGroundTruth,
        prop_type: task.propType,
        line: task.line,
      };
      // Per-task latency for the verdict event. ground-truth fetch already
      // happened (shared across tasks); this measures pre-filter + LLM +
      // verifier for THIS task, which is what makes per-provider latency
      // comparisons meaningful.
      const taskStartedAt = Date.now();

      // PRE-FILTER: run the mechanical framework checks before paying for
      // an LLM call. If the arithmetic says SKIP (e.g., OVER buffer fails,
      // Rule 5i FT-floor on UNDER Points/PRA), short-circuit here. This
      // is the same check the post-LLM verifier runs, so the verdict can
      // never differ from the LLM path.
      const preSkip = preFilterMechanical({
        groundTruth: taskGroundTruth,
        statType: task.statType,
        direction: task.direction,
        line: task.line,
      });
      if (preSkip) {
        tierCounts.SKIP += 1;
        logVerdict({
          source: "analyze-all",
          input: { player: task.player, propType: task.propType, line: task.line },
          result: preSkip,
          groundTruth: taskGroundTruth,
          playerInfo: sharedPlayerInfo,
          trace: sharedTrace,
          durationMs: Date.now() - taskStartedAt,
        });
        continue;
      }

      const framework = getFramework(taskGroundTruth?.league ?? "NBA");
      const prompt = buildPrompt(framework, taskGroundTruth);

      let llm = await callLLM(prompt);
      if (llm.error) {
        // One outer retry — the router already exhausted both providers'
        // primary→fallback chains, so this is a last-ditch attempt
        // against transient provider-wide weather.
        await new Promise((r) => setTimeout(r, 1500));
        llm = await callLLM(prompt);
      }

      if (llm.error) {
        errors.push({ task: `${task.player} ${task.propType}`, error: llm.error });
        tierCounts.UNKNOWN += 1;
        logVerdict({
          source: "analyze-all",
          input: { player: task.player, propType: task.propType, line: task.line },
          groundTruth: taskGroundTruth,
          playerInfo: sharedPlayerInfo,
          trace: sharedTrace,
          errorInfo: { message: llm.error, name: "LLMError", status: 500 },
          durationMs: Date.now() - taskStartedAt,
        });
        continue;
      }

      // Single-prop LLM returns the verdict object directly (no
      // `results` array wrapper that the batched validator required).
      const r = llm.json;

      // Re-derive the mechanical framework checks the LLM might have
      // dropped (OVER 1.5pt buffer, Rule 5i FT-floor). The verifier also
      // classifies LLM SKIPs and audits data_used for hallucinated values.
      let verified = verifyVerdict({
        groundTruth: taskGroundTruth,
        statType: task.statType,
        direction: task.direction,
        line: task.line,
        llmResult: r,
      });
      let llmForLog = llm;

      // One-shot retry on unjustified SKIPs. Reuses the same prompt with
      // an addendum demanding either a framework citation or a revised
      // verdict. Capped at one re-call per task by passing isRetry=true on
      // the second verification.
      if (verified.should_retry) {
        const retryLlm = await callLLM(`${prompt}${UNJUSTIFIED_SKIP_RETRY_ADDENDUM}`);
        if (!retryLlm.error && retryLlm.json) {
          const reverified = verifyVerdict({
            groundTruth: taskGroundTruth,
            statType: task.statType,
            direction: task.direction,
            line: task.line,
            llmResult: retryLlm.json,
            isRetry: true,
          });
          const recovered = reverified.verdict !== "SKIP" || reverified.skip_kind === "framework_cited";
          verified = { ...reverified, retry_recovered: recovered };
          llmForLog = retryLlm;
        }
      }

      const tierKey = tierCounts[verified.tier] !== undefined ? verified.tier : "UNKNOWN";
      tierCounts[tierKey] += 1;
      logVerdict({
        source: "analyze-all",
        input: { player: task.player, propType: task.propType, line: task.line },
        result: verified,
        groundTruth: taskGroundTruth,
        playerInfo: sharedPlayerInfo,
        trace: sharedTrace,
        durationMs: Date.now() - taskStartedAt,
        llmProvider: llmForLog.provider ?? null,
        llmModel: llmForLog.model ?? null,
      });
      if (verified.tier === "S" || verified.tier === "A" || verified.tier === "B") {
        results.push({
          player: task.player,
          game: task.game || "—",
          prop_type: task.statType,
          direction: verified.verdict,
          line: task.line,
          odds_type: task.oddsType,
          verdict: verified.verdict,
          tier: verified.tier,
          confidence: verified.confidence || 0,
          justification: verified.justification || "",
        });
      }
    }

    // Sort by tier (S first), then confidence (desc)
    results.sort((a, b) => {
      const tierOrder = { S: 0, A: 1, B: 2 };
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
