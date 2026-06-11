// Home-side residential-IP bridge for the PrizePicks scrape.
//
// PrizePicks 403s Vercel cloud IPs, so api/refresh-lines.js can never
// scrape from a deployed function. This daemon runs on the operator's
// home machine (residential IP) and exposes POST /refresh on
// 127.0.0.1:HOME_BRIDGE_PORT. The Vercel function forwards refresh
// clicks here via a Cloudflare Tunnel (or similar) and we run the
// existing scrape + writeLines path in-process — no scraping logic is
// duplicated.
//
// Usage:
//   npm run refresh-bridge
//
// Env (loaded from .env.local):
//   HOME_BRIDGE_SECRET  — shared secret with the Vercel function (required)
//   HOME_BRIDGE_PORT    — listen port (default 4000)
//   BLOB_READ_WRITE_TOKEN — needed by writeLines() to push the blob
//
// Auth: callers must send `Authorization: Bearer ${HOME_BRIDGE_SECRET}`.
// Concurrent calls return 409 (only one scrape in flight at a time —
// PrizePicks doesn't like parallel hits and the result would clobber
// itself anyway).

import http from "node:http";
import { randomUUID } from "node:crypto";
import { loadEnvLocal } from "./_env.mjs";
import { scrapePrizePicksForToday } from "./scrape-prizepicks.mjs";
import { writeLines, getStoreLocation } from "../api/_lib/lines-store.js";

loadEnvLocal();

const PORT = Number(process.env.HOME_BRIDGE_PORT ?? 4000);
const SECRET = process.env.HOME_BRIDGE_SECRET;

if (!SECRET) {
  console.error("HOME_BRIDGE_SECRET not set in .env.local; refusing to start.");
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN not set; writeLines() would fail. Refusing to start.");
  process.exit(1);
}

let inFlight = false;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const reqId = randomUUID().slice(0, 8);

  if (req.method !== "POST" || req.url !== "/refresh") {
    return send(res, 404, { request_id: reqId, error: "Not found" });
  }

  const auth = req.headers.authorization || "";
  const supplied = auth.replace(/^Bearer\s+/i, "").trim();
  if (supplied !== SECRET) {
    console.log(`[${reqId}] unauthorized`);
    return send(res, 401, { request_id: reqId, error: "Unauthorized" });
  }

  if (inFlight) {
    return send(res, 409, { request_id: reqId, error: "Refresh already in progress" });
  }
  inFlight = true;
  console.log(`[${reqId}] scrape starting`);

  try {
    const data = await scrapePrizePicksForToday({ write: false });
    if (!data.total_props) {
      console.log(`[${reqId}] scrape returned 0 props; refusing to write blob`);
      return send(res, 502, {
        request_id: reqId,
        error: "Scrape returned 0 props; refusing to overwrite blob.",
        fetched_at: data.fetched_at,
        leagues: data.leagues,
      });
    }
    const persistedTo = await writeLines(data);
    console.log(`[${reqId}] wrote ${data.total_props} props (${data.total_players} players) → ${persistedTo}`);
    return send(res, 200, {
      request_id: reqId,
      fetched_at: data.fetched_at,
      total_props: data.total_props,
      total_players: data.total_players,
      persisted_to: persistedTo,
    });
  } catch (err) {
    console.error(`[${reqId}] error:`, err.message);
    return send(res, 500, {
      request_id: reqId,
      error: err.message,
      persist_path: getStoreLocation(),
    });
  } finally {
    inFlight = false;
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`refresh-bridge listening on http://127.0.0.1:${PORT}/refresh`);
  console.log("Expose via Cloudflare Tunnel or ngrok and set HOME_REFRESH_URL on Vercel.");
});
