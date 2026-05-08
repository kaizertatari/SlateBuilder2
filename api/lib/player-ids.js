// Source of truth: data/players.json — { name: { nba, espn } }.
// Server reads it once at module init via fs.readFileSync (Vercel bundles
// referenced files into the function package); the Vite client imports the
// same JSON natively. Both sides stay in lock-step without code duplication.
//
// Regenerate via: node scripts/refresh-playoff-players.mjs
// Players omitted resolve to null and the orchestrator returns SKIP with a
// clear flag.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.resolve(HERE, "../../data/players.json");

export const PLAYER_INFO = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));

export function resolvePlayerId(name) {
  return PLAYER_INFO[name]?.nba ?? null;
}

export function resolveEspnId(name) {
  return PLAYER_INFO[name]?.espn ?? null;
}

// Legacy export retained for build-espn-ids.mjs and any other consumers
// that just want { name: nba_id }.
export const PLAYER_IDS = Object.fromEntries(
  Object.entries(PLAYER_INFO).map(([k, v]) => [k, v.nba])
);
