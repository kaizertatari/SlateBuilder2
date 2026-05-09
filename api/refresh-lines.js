// Refresh the PrizePicks lines blob from the live API and persist to the
// warm-instance cache (/tmp on Vercel).
//
// POST /api/refresh-lines  (manual)
//   Authorization: Bearer $REFRESH_TOKEN
//
// GET /api/refresh-lines  (Vercel cron)
//   Authorization: Bearer $CRON_SECRET
//   x-vercel-cron: <set by Vercel scheduler>
//
// Returns { request_id, fetched_at, total_props, total_players, persisted_to }.

import { scrapePrizePicksForToday } from "../scripts/scrape-prizepicks.mjs";
import { writeLines, getStoreLocation } from "./lib/lines-store.js";
import { rateLimit } from "./lib/rate-limit.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handleRefresh(req, reqId, "POST"));
}

export async function GET(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handleRefresh(req, reqId, "GET"));
}

async function handleRefresh(req, reqId, method) {
  const refreshToken = process.env.REFRESH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  if (!refreshToken && !cronSecret) {
    return Response.json(
      { request_id: reqId, error: "Neither REFRESH_TOKEN nor CRON_SECRET is configured on the server." },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization") || "";
  const supplied = auth.replace(/^Bearer\s+/i, "").trim();
  const isVercelCron = !!req.headers.get("x-vercel-cron");

  // GET is reserved for the Vercel scheduler: require the cron header AND a
  // CRON_SECRET match. POST accepts either token (manual operators or curl).
  let authorized = false;
  if (method === "GET") {
    authorized = isVercelCron && !!cronSecret && supplied === cronSecret;
  } else {
    authorized =
      (refreshToken && supplied === refreshToken) ||
      (cronSecret && supplied === cronSecret);
  }
  if (!authorized) {
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
      { request_id: reqId, error: err.message, persist_path: getStoreLocation() },
      { status: 500 }
    );
  }
}
