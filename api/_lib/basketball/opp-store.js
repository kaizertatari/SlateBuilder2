// Runtime access to the basketball opponent-factor artifact (SHADOW mode:
// the factor is attached to ground truth and logged on every verdict; no
// rule reads it). Blob first, deploy-bundled data/ file as the floor, so the
// daily `build-basketball-opponent --push` reaches the app without a redeploy.
//
//   NBA   data/nba-opp-model.json
//   WNBA  data/wnba-opp-model.json

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBlobStore } from "../blob-store.js";
import * as cache from "../cache.js";
import { opponentFactor } from "./opponent.js";
import { PROP_KEY, meanAt } from "./dist.js";
import { toEspnAbbr, toNbaAbbr } from "../espn.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, "../../../data");
const ARTIFACT_TTL_MS = 5 * 60 * 1000;

const stores = {};
export function oppModelStore(league) {
  const file = `${String(league).toLowerCase()}-opp-model.json`;
  return (stores[league] ??= createBlobStore({
    pathname: file, bundledPath: path.join(DATA, file), label: `${String(league).toLowerCase()}-opp-store`,
    emptyFallback: null,
  }));
}

export async function getOppModel(league) {
  const key = `opp-artifact:${league}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const model = await oppModelStore(league).read();
  if (model) cache.set(key, model, ARTIFACT_TTL_MS);
  return model;
}

// Any spelling (stats or ESPN) → stats.nba.com abbreviation, which is what
// the game logs and the artifact are keyed by.
const statsAbbr = (abbr, league) => (abbr ? toNbaAbbr(toEspnAbbr(abbr, league), league) : null);

/**
 * Shadow factor for one verdict. Never throws — returns null on any miss so
 * the verdict path is unaffected.
 */
export async function getOppFactor({ league, playerId, team, opponent, propType }) {
  try {
    if (league !== "NBA" && league !== "WNBA") return null;
    const model = await getOppModel(league);
    if (!model) return null;
    const f = opponentFactor(model, {
      playerId, team: statsAbbr(team, league), opponent: statsAbbr(opponent, league), prop: propType,
    });
    if (!f) return null;
    // Calibrated-distribution parameters for this prop (probability
    // pipeline step 1, SHADOW) — the logger prices the line with them.
    const key = PROP_KEY[String(propType ?? "").replace(/\s+(OVER|UNDER)$/i, "").trim()];
    const dist = key && model.dist?.r?.[key] > 0 ? { key, r: model.dist.r[key], c: model.dist.c[key], season: model.dist.season } : null;
    // Early-season shrink (SHADOW): the opponent model's expected value for
    // this prop per minute played (prior-carrying player rate × pace × team).
    // The projection is linear in minutes, so the logger scales it by the
    // player's projected minutes (dist.js shrinkMean).
    const ctx = { playerId, team: statsAbbr(team, league), opponent: statsAbbr(opponent, league) };
    const perMin = key ? meanAt(model, ctx, key, 1, "team") : null;
    // Known-lineup minutes (SHADOW): the player's team rotation, for the
    // logger's lineupMinutes (artifact built before 2026-10-28 has none).
    const teamRotation = model.rotation?.[ctx.team] ?? null;
    return { ...f, fitted_at: model.fitted_at ?? null, data_through: model.data_through ?? null, dist, opp_per_min: perMin ?? null, team_rotation: teamRotation };
  } catch {
    return null;
  }
}
