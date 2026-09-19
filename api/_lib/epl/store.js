// Runtime data access for the EPL verdict engine (the I/O half — verdict.js
// stays pure).
//
//   model / registry / odds   Blob first, deploy-bundled data/ file as the
//                             floor (same createBlobStore semantics as the
//                             lines/odds snapshots), so a residential
//                             `--push` refresh reaches the deployed app
//                             without a redeploy.
//   lineups                   fetched live from FotMob per fixture (plain
//                             HTTP, __NEXT_DATA__), cached briefly: the
//                             predicted XI + injury list until the clubs
//                             publish the confirmed sheet ~1h before
//                             kickoff. "Re-run after lineups" = analyze
//                             again once they're out.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlobStore } from "../blob-store.js";
import * as cache from "../cache.js";
import { extractNextData, matchPageUrl, parseLineup } from "./fotmob.js";
import { buildEplContext } from "./verdict.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../../../data");

export const eplModelStore = createBlobStore({
  pathname: "epl-model.json", bundledPath: path.join(DATA, "epl-model.json"), label: "epl-model-store",
});
export const eplRegistryStore = createBlobStore({
  pathname: "epl-players.json", bundledPath: path.join(DATA, "epl-players.json"), label: "epl-players-store",
});
// The EPL PrizePicks board has its OWN snapshot (scripts/refresh-epl-
// prizepicks.mjs), separate from the basketball lines: independent failure
// domains, and no EPL props leak into the production basketball snapshot.
export const eplLinesStore = createBlobStore({
  pathname: "epl-pp-lines.json", bundledPath: path.join(DATA, "epl-pp-lines.json"), label: "epl-lines-store",
  emptyFallback: { fetched_at: null, games: {}, by_player: {}, total_props: 0, total_players: 0, leagues: {} },
});
export const readEplLines = () => eplLinesStore.read();

export const eplOddsStore = createBlobStore({
  pathname: "epl-odds.json", bundledPath: path.join(DATA, "epl-odds.json"), label: "epl-odds-store",
  // No market is non-fatal: every stat degrades to model-only (capped at B).
  emptyFallback: { matches: {}, players: {}, shading: {} },
});

const ARTIFACT_TTL_MS = 5 * 60 * 1000;
const LINEUP_TTL_MS = 5 * 60 * 1000;
const LINEUP_WINDOW_MS = 36 * 3600 * 1000; // only fetch lineups for kickoffs this close
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function cached(key, loader, ttlMs) {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await loader();
  cache.set(key, v, ttlMs);
  return v;
}

async function fetchLineup(matchId) {
  return cached(`epl-lineup:${matchId}`, async () => {
    try {
      const res = await fetch(matchPageUrl(matchId), { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      return parseLineup(extractNextData(await res.text()));
    } catch {
      return null;
    }
  }, LINEUP_TTL_MS);
}

/**
 * Load everything the verdict engine needs, with lineups for the given
 * fixtures (only those kicking off within 36h; pass [] to skip lineups).
 * @param {{ matchIds?: string[], withLineups?: boolean }} [opts]
 */
export async function getEplContext({ matchIds = null, withLineups = true } = {}) {
  const [model, registry, odds] = await Promise.all([
    cached("epl-artifact:model", () => eplModelStore.read(), ARTIFACT_TTL_MS),
    cached("epl-artifact:registry", () => eplRegistryStore.read(), ARTIFACT_TTL_MS),
    cached("epl-artifact:odds", () => eplOddsStore.read(), ARTIFACT_TTL_MS),
  ]);
  const lineups = new Map();
  if (withLineups) {
    const now = Date.now();
    const ids = (matchIds ?? (model.fixtures || []).map((f) => f.match_id))
      .filter((id) => {
        const f = (model.fixtures || []).find((x) => x.match_id === id);
        const ko = f ? Date.parse(f.kickoff) : NaN;
        return Number.isFinite(ko) && ko > now - 2 * 3600 * 1000 && ko - now < LINEUP_WINDOW_MS;
      });
    const fetched = await Promise.all([...new Set(ids)].map(async (id) => [id, await fetchLineup(id)]));
    for (const [id, l] of fetched) if (l) lineups.set(id, l);
  }
  return buildEplContext({ model, registry, odds, lineups });
}
