// Refresh the PrizePicks lines blob from the live API and persist to the
// warm-instance cache (/tmp on Vercel). Token-guarded via REFRESH_TOKEN.
//
// POST /api/refresh-lines
//   Authorization: Bearer $REFRESH_TOKEN
//
// Returns { request_id, fetched_at, total_props, total_players, persisted_to }.

import { scrapePrizePicksForToday } from "../scripts/scrape-prizepicks.mjs";
import { writeLines, getTmpPath } from "./lib/lines-store.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req, reqId));
}

async function handlePost(req, reqId) {
  const expected = process.env.REFRESH_TOKEN;
  if (!expected) {
    return Response.json(
      { request_id: reqId, error: "REFRESH_TOKEN not configured on the server." },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization") || "";
  const supplied = auth.replace(/^Bearer\s+/i, "").trim();
  if (!supplied || supplied !== expected) {
    return Response.json({ request_id: reqId, error: "Unauthorized" }, { status: 401 });
  }

  // Cheap rate limit so a leaked token can't be used to hammer PrizePicks.
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  const limit = rateLimit(`refresh-lines:${ip}`, { windowMs: 60_000, max: 6 });
  if (!limit.ok) {
    return Response.json(
      { request_id: reqId, error: "Rate limit exceeded." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
    );
  }

  try {
    const data = await scrapePrizePicksForToday({ write: false });
    const persistedTo = await writeLines(data);
    return Response.json({
      request_id: reqId,
      fetched_at: data.fetched_at,
      total_props: data.total_props,
      total_players: data.total_players,
      persisted_to: persistedTo,
    });
  } catch (err) {
    return Response.json(
      { request_id: reqId, error: err.message, persist_path: getTmpPath() },
      { status: 500 }
    );
  }
}
