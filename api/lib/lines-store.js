// Read/write access to the PrizePicks lines blob.
//
// On Vercel, the deployed bundle FS is read-only at runtime; only /tmp is
// writable, and /tmp is per Fluid Compute instance + ephemeral. This module
// papers over that: reads prefer /tmp (fresh, written by /api/refresh-lines),
// then fall back to the bundled data/prizepicks-lines.json from the deploy.
//
// To get durable cross-instance freshness, swap the body of these two
// functions for Vercel Blob / Edge Config / KV. This file is the single seam.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = path.resolve(HERE, "../../data/prizepicks-lines.json");

export function getTmpPath() {
  // /tmp on Vercel/Linux; on Windows local dev, prefer %TEMP%.
  if (process.platform === "win32" && process.env.TEMP) {
    return path.join(process.env.TEMP, "prizepicks-lines.json");
  }
  return "/tmp/prizepicks-lines.json";
}

export async function readLines() {
  // Try the warm-instance cache first; fall back to the bundled file.
  try {
    const raw = await fs.readFile(getTmpPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    // Fall through to bundled file.
  }
  const raw = await fs.readFile(BUNDLED_PATH, "utf8");
  return JSON.parse(raw);
}

export async function writeLines(data) {
  // On Vercel, only /tmp is writable. The CLI scraper writes data/ directly;
  // the API endpoint uses this path so it matches prod behavior.
  const tmp = getTmpPath();
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  return tmp;
}
