// Read/write access to the sharp-odds blob (DK+FD no-vig consensus). Thin
// wrapper over the shared blob-store factory — see api/lib/blob-store.js
// for the blob-vs-bundled fallback semantics and edge-cache rationale.
// A residential `npm run refresh-odds` propagates to the deployed slate
// builder without a redeploy.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlobStore } from "./blob-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const store = createBlobStore({
  pathname: "odds.json",
  bundledPath: path.resolve(HERE, "../../data/odds.json"),
  label: "odds-store",
  // Missing odds is non-fatal: the market rules no-op on an empty store, so
  // degrade to "no market signal" rather than failing the request.
  emptyFallback: { by_player: {}, games: {}, sources: [] },
});

export function getOddsStoreLocation() {
  return store.location;
}

export const readOdds = store.read;
export const writeOdds = store.write;
