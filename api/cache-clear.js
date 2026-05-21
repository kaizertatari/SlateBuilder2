// Manual cache wipe for the analyze-all response namespace.
//
// POST /api/cache-clear  → { request_id, cleared }
//
// Drops every analyze-all:* entry from the in-process Map on the warm
// Fluid Compute instance that handles the request. Other namespaces
// (ESPN scoreboard SWR, team-defense snapshot) are untouched — they
// rotate on their own freshness windows and re-hitting them adds load
// without benefit.
//
// Per-instance only: each Vercel worker has its own Map, so a single
// POST clears the cache for whichever instance receives it. Concurrent
// instances will still serve cached responses until they receive their
// own clear call. For local dev / single-warm-instance personal use
// this is fine.
//
// Rate-limited (1/min/IP) so a misclick or refresh loop can't degrade
// the whole cache layer. No token auth — wipe is non-destructive (next
// analyze-all just hits the cold path).

import { clearByPrefix } from "./lib/cache.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handleClear(req, reqId));
}

async function handleClear(req, reqId) {
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const limit = rateLimit(`cache-clear:${ip}`, { windowMs: 60_000, max: 1 });
  if (!limit.ok) {
    return Response.json(
      { request_id: reqId, error: "Rate limit exceeded — wait a moment before clearing again." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
    );
  }

  const cleared = clearByPrefix("analyze-all:");
  return Response.json({ request_id: reqId, cleared });
}
