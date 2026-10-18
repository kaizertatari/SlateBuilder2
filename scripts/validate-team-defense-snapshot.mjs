// Post-refresh validator for the team-defense snapshots. Exits 0 with a
// one-line summary on pass; exits 1 with the failing assertion on fail.
//
// Reuses currentSeason() from api/_lib/nba-stats.js — same function the
// runtime adapter uses to format season labels, so the validator and the
// engine agree on the expected label.
//
// Usage: node scripts/validate-team-defense-snapshot.mjs [--league NBA|WNBA] [path]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentSeason } from "../api/_lib/nba-stats.js";
import { TEAM_ID_BY_ABBR, WNBA_TEAM_ID_BY_ABBR } from "../api/_lib/team-ids.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATHS = {
  NBA: path.join(ROOT, "data/team-defense.json"),
  WNBA: path.join(ROOT, "data/team-defense-wnba.json"),
};
// Every team in the id map must be present — a missing one means an id
// drifted or was never filled in, and that opponent silently loses defense.
const ID_MAPS = { NBA: TEAM_ID_BY_ABBR, WNBA: WNBA_TEAM_ID_BY_ABBR };
const REQUIRED_KEYS = ["season", "fetched_at", "seasons"];

function fail(msg) {
  console.error(`✗ validate-team-defense-snapshot: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const li = args.indexOf("--league");
  const league = (li >= 0 ? args[li + 1] : "NBA").toUpperCase();
  if (!DEFAULT_PATHS[league]) fail(`--league must be NBA or WNBA (got ${league})`);
  const positional = args.filter((_, i) => li < 0 || (i !== li && i !== li + 1));
  const filePath = positional[0] || DEFAULT_PATHS[league];

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    fail(`cannot read ${filePath}: ${e.message}`);
  }

  let snap;
  try {
    snap = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in ${filePath}: ${e.message}`);
  }

  for (const k of REQUIRED_KEYS) {
    if (!(k in snap)) fail(`missing required top-level key "${k}"`);
  }

  const expectedSeason = currentSeason(new Date(), league);
  if (snap.season !== expectedSeason) {
    fail(`season mismatch: file has "${snap.season}", expected "${expectedSeason}"`);
  }

  const regularSeason = snap.seasons?.["Regular Season"];
  if (!regularSeason || typeof regularSeason !== "object") {
    fail(`seasons["Regular Season"] is missing or not an object`);
  }
  const idMap = ID_MAPS[league];
  const missing = Object.keys(idMap).filter((abbr) => !regularSeason[abbr]);
  if (missing.length) fail(`Regular Season is missing ${missing.join(", ")}`);
  for (const [abbr, row] of Object.entries(regularSeason)) {
    if (row.team_id !== idMap[abbr]) fail(`${abbr} team_id ${row.team_id} != team-ids.js ${idMap[abbr]}`);
  }

  if (league === "NBA" && !Object.keys(snap.prior_season?.teams ?? {}).length) {
    fail(`NBA snapshot is missing prior_season (needed for the this-season/last-season blend)`);
  }

  console.log(`✓ ${path.relative(ROOT, filePath)}: ${league} ${snap.season}, ${Object.keys(regularSeason).length} teams`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
