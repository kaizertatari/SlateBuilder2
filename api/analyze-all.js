// Batch analyze PrizePicks lines for a single player using the existing
// framework. For each (player, stat_type) bucket, picks the lowest line
// PrizePicks publishes and analyzes only that line, sharing one
// ground-truth fetch across both OVER and UNDER directions when applicable.
//
// POST /api/analyze-all
// Body: { player: string, statTypes?: string[], direction?: "OVER"|"UNDER" }
//
// Returns: { total_analyzed, total_s_a, top_10: [...] }

import { gatherGroundTruthWithRetry } from "./analyze.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { readLines } from "./lib/lines-store.js";
import { STATS, mapPrizePicksStatType } from "./lib/prop-types.js";
import { get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { preFilterMechanical } from "./lib/verdict-verifier.js";
import { applyEngine } from "./lib/engine.js";
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
 * Choose which lines from a (player, stat) bucket get analyzed for a
 * given direction.
 *
 * OVER selection (priority order):
 *   1. Lowest-line goblin (easier OVER, discount payout)
 *   2. Standard (regular price)
 *   3. Lowest-line demon (harder OVER, boosted payout — usually
 *      pre-filter SKIPs but worth evaluating when math allows)
 *
 * UNDER selection:
 *   1. Lowest-line goblin
 *   2. Standard
 *   Demons are intentionally excluded on UNDER — a demon's higher line
 *   makes the UNDER trivially easier, which would generate inflated
 *   tier counts without representing a real edge. Operator only takes
 *   demons on OVER.
 *
 * Fallback: if none of the eligible odds_types exist for the stat —
 * rare, usually a newly-published combo prop — return the lowest
 * available line of any type so the bucket isn't silently dropped.
 *
 * Dedupe: if any two of the chosen lines land on the same numeric line
 * (rare but possible with promo pricing), return one entry per
 * distinct line.
 *
 * Exported so the smoke test can re-derive the same selection from the
 * raw lines JSON. `direction` is optional; when omitted, defaults to
 * the OVER selection (3 price points) for back-compatibility with
 * callers that don't yet thread direction through.
 *
 * @param {Array<Object>} props  props for one (player, stat) bucket
 * @param {"OVER"|"UNDER"} [direction="OVER"]  direction for which to pick lines
 * @returns {Array<Object>} 0-3 chosen line objects
 */
export function selectLinesForStat(props, direction = "OVER") {
  if (!Array.isArray(props) || props.length === 0) return [];
  const lowestByType = (type) =>
    props
      .filter((p) => p.odds_type === type)
      .sort((a, b) => a.line - b.line)[0] ?? null;
  const goblin = lowestByType("goblin");
  const standard = lowestByType("standard");
  // Demons are OVER-only. UNDER picks never see them — the higher line
  // makes UNDER trivially easier without representing a real edge.
  const demon = direction === "UNDER" ? null : lowestByType("demon");
  const chosen = [];
  const seenLines = new Set();
  const tryAdd = (entry) => {
    if (!entry) return;
    if (seenLines.has(entry.line)) return;
    seenLines.add(entry.line);
    chosen.push(entry);
  };
  tryAdd(goblin);
  tryAdd(standard);
  tryAdd(demon);
  if (chosen.length === 0) {
    // Fallback only when no goblin AND no standard exist; on UNDER this
    // means we never fall back to a demon (would defeat the gate).
    const candidates = direction === "UNDER"
      ? props.filter((p) => p.odds_type !== "demon")
      : props;
    const fallback = [...candidates].sort((a, b) => a.line - b.line)[0];
    if (fallback) chosen.push(fallback);
  }
  return chosen;
}

// Per-player line budget. Each task is now one deterministic engine
// invocation, so this caps the work per analyze-all request. The
// realistic max with goblin + standard + demon per stat is
// 9 stats × 3 lines × 2 dirs = 54; default 60 covers that with headroom.
const MAX_LINES = parseInt(process.env.MAX_LINES_PER_PLAYER || "60", 10);

// (Engine-only branch: no LLM provider, no TPM pacing required.
// Original Groq token-bucket pacing + Retry-After parser removed.)

// Engine-only batch: one deterministic call per task. The previous
// LLM batched/single-prop endpoints have been removed on this branch;
// the engine in api/lib/engine.js implements the v3.5 framework in
// JavaScript so analyze-all + /api/analyze produce identical verdicts
// for the same ground truth.

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req, reqId));
}

async function handlePost(req, reqId) {
  try {
    // Rate limit. Bumped from 3 → 20 per 60s so the multi-player UI can
    // fan out 6+ players in parallel without tripping 429s. Single-operator
    // app, no public traffic — the cap exists to bound abuse, not to
    // throttle the legitimate UI.
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const limit = rateLimit(`analyze-all:${ip}`, { windowMs: 60_000, max: 20 });
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
     // Engine-only branch — no LLM provider required. The provider-key
     // guard that lived here is gone.

     // Build the task list once per player. groundTruth is fetched a single
     // time for the entire player (it is stat-agnostic except for the
     // prop_type/line metadata fields, which the engine reads per-task). Any
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
       // Direction-aware line selection: demons are OVER-only, so each
       // direction may pick a different set of lines from the same bucket.
       // Seed the per-direction selections once so the loop body below can
       // bail early when both directions are empty.
       const perDirection = new Map();
       for (const dir of directions) {
         perDirection.set(dir, selectLinesForStat(props, dir));
       }
       const anyLines = [...perDirection.values()].some((arr) => arr.length > 0);
       if (!anyLines) continue;

       // Fetch the player-wide groundTruth on first stat we see. Reuse for
       // every subsequent bucket — caches inside gatherGroundTruth would
       // make repeated calls cheap, but batching needs ONE shared object
       // anyway. Seed with the first direction's first chosen line.
       if (!sharedGroundTruth) {
         const firstDir = directions.find((d) => perDirection.get(d)?.length > 0);
         const seedLine = perDirection.get(firstDir)[0].line;
         // Retry budget: 2 extra attempts at 500ms exponential backoff.
         // bdl.findPlayer + getCommonPlayerInfo both have 8s timeouts and
         // are racing — under 6-player parallel load they regularly fail
         // BOTH on a single attempt, dropping the player to total_analyzed=0.
         // The 6-player probe (607b764) reproduced this with Holmgren after
         // a 1-retry budget was already in place. Three attempts with
         // progressive backoff (~500ms + 1s = 1.5s of waits) buys upstream
         // breathing room while keeping the parallel wall clock under ~25s
         // worst case for a single stressed player.
         const r = await gatherGroundTruthWithRetry(
           {
             player,
             propType: `${stat} ${firstDir}`,
             // groundTruth is line-agnostic except for the prop_type/line
             // metadata (overwritten per-task below), so any chosen line
             // works as a seed.
             line: seedLine,
           },
           { maxRetries: 2, baseDelayMs: 500 }
         );
         if (r.skipReason) {
           // Player-wide skip — record and stop building tasks.
           skipped.push({ stat, reason: r.skipReason });
           break;
         }
         sharedGroundTruth = r.groundTruth;
         sharedTrace = r.trace ?? null;
         sharedPlayerInfo = r.playerInfo ?? null;
       }

       for (const dir of directions) {
         if (tasks.length >= MAX_LINES) break;
         const chosenLines = perDirection.get(dir) || [];
         for (const chosen of chosenLines) {
           if (tasks.length >= MAX_LINES) break;
           const game = `${chosen.player_team || ""} @ ${chosen.opponent || ""}`;
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

    // Serial deterministic path: pre-filter then engine, one task at
    // a time. No LLM, no provider rotation, no TPM pacing. tier_counts
    // captures the verdict distribution across all completed analyses.
    const results = [];
    const errors = [];
    const tierCounts = { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 };

    for (const task of tasks) {
      // sharedGroundTruth has the FIRST task's prop_type/line baked in
      // (from the initial gatherGroundTruth call). Overwrite with this
      // task's values so the engine sees the correct prop.
      const taskGroundTruth = {
        ...sharedGroundTruth,
        prop_type: task.propType,
        line: task.line,
      };
      const taskStartedAt = Date.now();

      // PRE-FILTER: the mechanical framework hard-gates short-circuit
      // before engine setup. Same checks as the engine's internals so
      // pre-filter and engine never disagree.
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

      const verified = applyEngine({
        groundTruth: taskGroundTruth,
        statType: task.statType,
        direction: task.direction,
        line: task.line,
      });

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
          // Engine audit fields. rules_fired lists the framework rules
          // that contributed to this verdict so the operator (and
          // grade-outcomes hits per rule) can attribute outcomes.
          rules_fired: Array.isArray(verified.rules_fired) ? verified.rules_fired : [],
          flags: Array.isArray(verified.flags) ? verified.flags : [],
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
