// Runtime data access for the NFL verdict engine (the I/O half — verdict.js
// stays pure). Blob first, deploy-bundled data/ file as the floor (same
// createBlobStore semantics as the EPL stores), so a residential `--push`
// refresh reaches the deployed app without a redeploy.
//
//   model   data/nfl-model.json  (fit + names/status, schedule, injury reports)
//   odds    data/nfl-odds.json   (DK + FD props, anytime TD, game lines)
//   lines   data/nfl-pp-lines.json — the NFL PrizePicks board is its OWN
//           snapshot, never folded into the basketball lines
//
// Simulations are the expensive part (~0.1s per player), so the built
// context is cached for the artifact TTL: repeated analyze/build-slate calls
// reuse every player's draws until the model or odds snapshot changes.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlobStore } from "../blob-store.js";
import * as cache from "../cache.js";
import { buildNflContext } from "./verdict.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../../../data");

export const nflModelStore = createBlobStore({
  pathname: "nfl-model.json", bundledPath: path.join(DATA, "nfl-model.json"), label: "nfl-model-store",
});
export const nflOddsStore = createBlobStore({
  pathname: "nfl-odds.json", bundledPath: path.join(DATA, "nfl-odds.json"), label: "nfl-odds-store",
  // No market is non-fatal: every line is priced model-only (and not tiered).
  emptyFallback: { games: {}, by_player: {}, anytime_td: {} },
});
export const nflLinesStore = createBlobStore({
  pathname: "nfl-pp-lines.json", bundledPath: path.join(DATA, "nfl-pp-lines.json"), label: "nfl-lines-store",
  emptyFallback: { fetched_at: null, games: {}, by_player: {}, total_props: 0, total_players: 0, leagues: {} },
});
export const readNflLines = () => nflLinesStore.read();

const ARTIFACT_TTL_MS = 5 * 60 * 1000;

async function cached(key, loader, ttlMs) {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await loader();
  cache.set(key, v, ttlMs);
  return v;
}

/** Model + odds → verdict context (cached with its simulations). */
export async function getNflContext() {
  const [model, odds] = await Promise.all([
    cached("nfl-artifact:model", () => nflModelStore.read(), ARTIFACT_TTL_MS),
    cached("nfl-artifact:odds", () => nflOddsStore.read(), ARTIFACT_TTL_MS),
  ]);
  const key = `nfl-context:${model.fitted_at ?? "?"}|${odds.fetched_at ?? "?"}`;
  const ctx = await cached(key, async () => buildNflContext({ model, odds }), ARTIFACT_TTL_MS);
  // The kickoff gate must use the request's clock, not the cache's.
  ctx.now = Date.now();
  return ctx;
}
