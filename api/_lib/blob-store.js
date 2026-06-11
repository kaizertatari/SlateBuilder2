// Shared Vercel Blob store scaffolding for the snapshot blobs
// (prizepicks-lines.json, odds.json — see lines-store.js / odds-store.js).
//
// Backing store: Vercel Blob. A residential refresh writes one fixed
// pathname; every Fluid Compute instance reads that same blob, so refreshes
// propagate across instances (unlike /tmp, which is per-instance +
// ephemeral). Reads fall back to the bundled snapshot from the deploy when
// the blob is unreachable — survives a Blob outage but can serve stale
// data; treat the bundled file as a floor, not a cache.

import fs from "node:fs/promises";
import { put, head } from "@vercel/blob";

// 60s edge cache — long enough that a burst of reads shares one origin
// fetch, short enough that a refresh's writes are visible to users within a
// minute. Without this, Vercel Blob's default ~1 month edge TTL would
// silently mask refreshes until the next deploy.
const EDGE_CACHE_SECONDS = 60;

/**
 * Build a read/write accessor pair for one fixed-pathname blob.
 *
 * @param {Object} cfg
 * @param {string} cfg.pathname    Fixed blob pathname. Combined with
 *   addRandomSuffix:false + allowOverwrite:true, refreshes update this
 *   single object in place, so its URL is stable.
 * @param {string} cfg.bundledPath Absolute path of the deploy-bundled
 *   fallback snapshot.
 * @param {string} cfg.label       Log prefix (e.g. "lines-store").
 * @param {*} [cfg.emptyFallback]  Returned when BOTH the blob and the
 *   bundled file are unreadable. Omit to let the bundled-read error
 *   propagate instead (callers that must 404 on missing data want that).
 * @returns {{ read: () => Promise<Object>, write: (data: Object) => Promise<string>, location: string }}
 */
export function createBlobStore({ pathname, bundledPath, label, emptyFallback }) {
  // Per-instance memo of the blob URL. addRandomSuffix:false makes the URL
  // stable across writes, so caching it for the life of the instance is safe.
  let cachedBlobUrl = null;

  async function getBlobUrl() {
    if (cachedBlobUrl) return cachedBlobUrl;
    const meta = await head(pathname);
    cachedBlobUrl = meta.url;
    return cachedBlobUrl;
  }

  async function readBundled() {
    const raw = await fs.readFile(bundledPath, "utf8");
    return JSON.parse(raw);
  }

  async function read() {
    // Try the durable blob first; fall back to the bundled file on any
    // failure (no token, blob doesn't exist yet, network error, bad JSON).
    try {
      const url = await getBlobUrl();
      // cache:'no-store' bypasses the runtime fetch cache; the
      // EDGE_CACHE_SECONDS set on `put` still bounds origin load.
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
      // Non-OK (e.g. blob deleted) — log so a stale-data situation is
      // visible instead of silently serving the build-time bundle.
      console.warn(`[${label}] blob fetch ${res.status}; serving bundled fallback (stale).`);
    } catch (err) {
      // A bad/expired BLOB_READ_WRITE_TOKEN lands here — without this log
      // the app silently serves the bundled snapshot and looks "fine" but
      // stale.
      console.warn(`[${label}] blob read failed (${err.message}); serving bundled fallback (stale).`);
    }
    if (emptyFallback === undefined) return readBundled();
    try {
      return await readBundled();
    } catch {
      return emptyFallback;
    }
  }

  async function write(data) {
    const body = JSON.stringify(data, null, 2) + "\n";
    const result = await put(pathname, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: EDGE_CACHE_SECONDS,
    });
    cachedBlobUrl = result.url;
    return result.url;
  }

  return { read, write, location: `vercel-blob:${pathname}` };
}
