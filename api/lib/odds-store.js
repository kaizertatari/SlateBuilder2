// Read/write access to the sharp-odds blob (DK+FD no-vig consensus).
//
// Mirrors lines-store.js: a single fixed Vercel Blob object that every Fluid
// Compute instance reads, so a residential `npm run refresh-odds` propagates
// to the deployed slate builder without a redeploy. Reads fall back to the
// bundled data/odds.json (a floor, not a cache) when the blob is unreachable.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { put, head } from "@vercel/blob";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = path.resolve(HERE, "../../data/odds.json");
const BLOB_PATHNAME = "odds.json";
const EDGE_CACHE_SECONDS = 60;

let cachedBlobUrl = null;

async function getBlobUrl() {
  if (cachedBlobUrl) return cachedBlobUrl;
  const meta = await head(BLOB_PATHNAME);
  cachedBlobUrl = meta.url;
  return cachedBlobUrl;
}

export function getOddsStoreLocation() {
  return `vercel-blob:${BLOB_PATHNAME}`;
}

export async function readOdds() {
  try {
    const url = await getBlobUrl();
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    // Fall through to bundled file.
  }
  try {
    const raw = await fs.readFile(BUNDLED_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { by_player: {}, games: {}, sources: [] };
  }
}

export async function writeOdds(data) {
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
