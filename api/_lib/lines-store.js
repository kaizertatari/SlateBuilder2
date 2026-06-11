// Read/write access to the PrizePicks lines blob. Thin wrapper over the
// shared blob-store factory — see api/_lib/blob-store.js for the
// blob-vs-bundled fallback semantics and edge-cache rationale.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlobStore } from "./blob-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const store = createBlobStore({
  pathname: "prizepicks-lines.json",
  bundledPath: path.resolve(HERE, "../../data/prizepicks-lines.json"),
  label: "lines-store",
  // No emptyFallback: when both the blob and the bundled file are
  // unreadable, the error propagates — callers (analyze-all, build-slate,
  // /api/lines) turn it into a 404 rather than serving an empty slate.
});

export function getStoreLocation() {
  return store.location;
}

export const readLines = store.read;
export const writeLines = store.write;
