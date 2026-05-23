// Post-refresh validator for data/bbref-splits.json or
// data/bbref-splits-wnba.json. Exits 0 with a one-line summary on pass;
// exits 1 with the failing assertion on fail.
//
// Reuses defaultSeasonEndYear / seasonLabel from refresh-bbref-splits.mjs
// so the source of truth for the calendar math stays singular.

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultSeasonEndYear,
  seasonLabel,
} from "./refresh-bbref-splits.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_KEYS = ["season", "fetched_at", "players"];

function fail(msg) {
  console.error(`✗ validate-bbref-splits-snapshot: ${msg}`);
  process.exit(1);
}

function leagueFromPath(filePath) {
  return /bbref-splits-wnba\.json$/i.test(filePath) ? "WNBA" : "NBA";
}

function priorPlayerCount(repoRelPath) {
  try {
    const blob = execFileSync("git", ["show", `HEAD:${repoRelPath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(blob);
    return Object.keys(parsed.players || {}).length;
  } catch {
    return null;
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) fail(`usage: validate-bbref-splits-snapshot.mjs <path-to-json>`);

  const absPath = path.resolve(filePath);
  let raw;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (e) {
    fail(`cannot read ${absPath}: ${e.message}`);
  }

  let snap;
  try {
    snap = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in ${absPath}: ${e.message}`);
  }

  for (const k of REQUIRED_KEYS) {
    if (!(k in snap)) fail(`missing required top-level key "${k}"`);
  }

  const league = leagueFromPath(absPath);
  const expectedSeason = seasonLabel(defaultSeasonEndYear(new Date(), league), league);
  if (snap.season !== expectedSeason) {
    fail(`season mismatch: file has "${snap.season}", expected "${expectedSeason}" for ${league}`);
  }

  const currentN = Object.keys(snap.players || {}).length;
  if (currentN === 0) fail(`players map is empty`);

  const relPath = path.relative(ROOT, absPath);
  const priorN = priorPlayerCount(relPath);
  if (priorN != null && priorN > 0) {
    const ratio = currentN / priorN;
    if (ratio < 0.8) {
      fail(`player count regressed: ${currentN} now vs ${priorN} prior (${(ratio * 100).toFixed(1)}%, min 80%)`);
    }
  }

  const priorNote = priorN != null ? ` (prior ${priorN})` : "";
  console.log(`✓ ${relPath}: ${league} ${snap.season}, ${currentN} players${priorNote}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
