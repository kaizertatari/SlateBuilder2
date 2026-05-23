// Post-refresh validator for data/prizepicks-lines.json. Exits 0 with a
// one-line summary on pass; exits 1 with the failing assertion on fail.
//
// Used by the `refresh-prizepicks:guarded` npm script wrapper so a bad
// scrape (empty file, missing games, stale fetch) gets caught before
// the operator commits.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = path.join(ROOT, "data/prizepicks-lines.json");
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const REQUIRED_KEYS = ["fetched_at", "games", "by_player", "total_props", "total_players", "leagues"];

function fail(msg) {
  console.error(`✗ validate-prizepicks-snapshot: ${msg}`);
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

  const gameCount = Object.keys(snap.games || {}).length;
  if (gameCount === 0) fail(`games map is empty`);

  if (!(typeof snap.total_props === "number") || snap.total_props <= 0) {
    fail(`total_props must be a positive number, got ${snap.total_props}`);
  }

  const fetchedAt = new Date(snap.fetched_at);
  if (Number.isNaN(fetchedAt.getTime())) {
    fail(`fetched_at is not a valid date: ${snap.fetched_at}`);
  }
  const ageMs = Date.now() - fetchedAt.getTime();
  if (ageMs > STALE_AFTER_MS) {
    fail(`fetched_at is stale (${Math.round(ageMs / 3600000)}h old, max 6h)`);
  }

  console.log(`✓ ${path.relative(ROOT, filePath)}: ${snap.total_props} props across ${gameCount} games, fetched ${Math.round(ageMs / 60000)}m ago`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
