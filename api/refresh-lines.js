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
  // Vercel's cron scheduler historically attached `x-vercel-cron`; current
  // deployments instead send `x-vercel-cron-schedule` (containing the cron
  // expression). Accept either so we survive future header renames without
  // falling back to bearer-only auth on the GET path.
  const isVercelCron =
    !!req.headers.get("x-vercel-cron") ||
    !!req.headers.get("x-vercel-cron-schedule");

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
    // PrizePicks blocks cloud-provider IPs, so a scrape from Vercel silently
    // yields total_props=0. If a home bridge is configured, forward the
    // refresh there — it runs on a residential IP via Cloudflare Tunnel
    // (see scripts/refresh-bridge.mjs). Otherwise refuse the write so a
    // bad scrape can't clobber the good blob a prior local refresh pushed.
    if (!data.total_props) {
      const bridgeUrl = process.env.HOME_REFRESH_URL;
      const bridgeSecret = process.env.HOME_BRIDGE_SECRET;
      if (bridgeUrl && bridgeSecret) {
        try {
          const target = `${bridgeUrl.replace(/\/$/, "")}/refresh`;
          const bridgeResp = await fetch(target, {
            method: "POST",
            headers: { Authorization: `Bearer ${bridgeSecret}` },
            signal: AbortSignal.timeout(90_000),
          });
          const bridgeBody = await bridgeResp.json().catch(() => ({}));
          return Response.json(
            { request_id: reqId, forwarded_to_bridge: true, ...bridgeBody },
            { status: bridgeResp.status }
          );
        } catch (err) {
          return Response.json(
            {
              request_id: reqId,
              error: `Home bridge unreachable: ${err.message}`,
              fetched_at: data.fetched_at,
            },
            { status: 502 }
          );
        }
      }
      return Response.json(
        {
          request_id: reqId,
          error: "Scrape returned 0 props; refusing to overwrite blob.",
          fetched_at: data.fetched_at,
          leagues: data.leagues,
        },
        { status: 502 }
      );
    }
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
