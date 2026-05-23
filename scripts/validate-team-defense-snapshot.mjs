// Post-refresh validator for data/team-defense.json. Exits 0 with a
// one-line summary on pass; exits 1 with the failing assertion on fail.
//
// Reuses currentSeason() from api/lib/nba-stats.js — same function the
// runtime adapter uses to format season labels, so the validator and the
// engine agree on the expected label.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentSeason } from "../api/lib/nba-stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = path.join(ROOT, "data/team-defense.json");
const REQUIRED_KEYS = ["season", "fetched_at", "seasons"];
const EXPECTED_TEAM_COUNT = 30;

function fail(msg) {
  console.error(`✗ validate-team-defense-snapshot: ${msg}`);
  process.exit(1);
}

async function main() {
  const filePath = process.argv[2] || DEFAULT_PATH;
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

  const expectedSeason = currentSeason(new Date(), "NBA");
  if (snap.season !== expectedSeason) {
    fail(`season mismatch: file has "${snap.season}", expected "${expectedSeason}"`);
  }

  const regularSeason = snap.seasons?.["Regular Season"];
  if (!regularSeason || typeof regularSeason !== "object") {
    fail(`seasons["Regular Season"] is missing or not an object`);
  }
  const teamCount = Object.keys(regularSeason).length;
  if (teamCount !== EXPECTED_TEAM_COUNT) {
    fail(`Regular Season has ${teamCount} teams, expected ${EXPECTED_TEAM_COUNT}`);
  }

  console.log(`✓ ${path.relative(ROOT, filePath)}: NBA ${snap.season}, ${teamCount} teams`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
