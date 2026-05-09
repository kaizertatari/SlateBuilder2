// Read/write access to the PrizePicks lines blob.
//
// Backing store: Vercel Blob. The cron writes one fixed pathname; every
// Fluid Compute instance reads that same blob, so refreshes propagate
// across instances (unlike /tmp, which is per-instance + ephemeral).
//
// Reads fall back to the bundled data/prizepicks-lines.json from the
// deploy when the blob is unreachable — survives a Blob outage but
// can serve stale data; treat the bundled file as a floor, not a cache.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put, head } from "@vercel/blob";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = path.resolve(HERE, "../../data/prizepicks-lines.json");

// Fixed pathname so the URL is stable. Combined with addRandomSuffix:false
// + allowOverwrite:true, the cron updates this single object in place.
const BLOB_PATHNAME = "prizepicks-lines.json";

// 60s edge cache — long enough that a burst of analyze-all calls share one
// origin fetch, short enough that the 5am/11am UTC cron's writes are visible
// to users within a minute. Without this, Vercel Blob's default ~1 month edge
// TTL would silently mask cron updates until the next deploy.
const EDGE_CACHE_SECONDS = 60;

// Per-instance memo of the blob URL. addRandomSuffix:false makes this URL
// stable across writes, so caching it for the life of the instance is safe.
let cachedBlobUrl = null;

async function getBlobUrl() {
  if (cachedBlobUrl) return cachedBlobUrl;
  const meta = await head(BLOB_PATHNAME);
  cachedBlobUrl = meta.url;
  return cachedBlobUrl;
}

export function getStoreLocation() {
  return `vercel-blob:${BLOB_PATHNAME}`;
}

export async function readLines() {
  // Try the durable blob first; fall back to the bundled file on any failure
  // (no token, blob doesn't exist yet, network error, malformed JSON).
  try {
    const url = await getBlobUrl();
    // cache:'no-store' bypasses the runtime fetch cache; the EDGE_CACHE_SECONDS
    // set on `put` still bounds origin load.
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    // Fall through to bundled file.
  }
  const raw = await fs.readFile(BUNDLED_PATH, "utf8");
  return JSON.parse(raw);
}

export async function writeLines(data) {
  const body = JSON.stringify(data, null, 2) + "\n";
  const result = await put(BLOB_PATHNAME, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: EDGE_CACHE_SECONDS,
  });
  cachedBlobUrl = result.url;
  return result.url;
}
