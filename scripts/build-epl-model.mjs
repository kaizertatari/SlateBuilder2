// Fit the EPL player model on the current snapshot and write the artifact the
// runtime prices from:
//
//   data/epl-matches.json + data/epl-players.json  →  data/epl-model.json
//
// Run after `npm run refresh-epl-data` (each matchweek). Prints the upcoming
// round's fixtures with the model's expected team totals — the numbers step 3
// compares against DraftKings / FanDuel.
//
// Usage: npm run build-epl-model  [-- --dry-run]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitModel, teamTotal } from "../api/_lib/epl/model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data/epl-model.json");
const DRY = process.argv.includes("--dry-run");

// Players one per line (the bulk of the file) so weekly rebuilds diff small.
function artifactJson(model) {
  const { players, ...rest } = model;
  const head = Object.entries(rest).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = Object.entries(players).map(([id, p]) => `${JSON.stringify(id)}: ${JSON.stringify(p)}`);
  return `{\n${head.join(",\n")},\n"players": {\n${body.join(",\n")}\n}\n}\n`;
}

async function main() {
  const snapshot = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-matches.json"), "utf8"));
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-players.json"), "utf8"));

  const model = fitModel(snapshot, { registry });
  model.fitted_at = new Date().toISOString();
  model.teams = Object.fromEntries(Object.entries(registry.teams || {}).map(([tid, t]) => [tid, { abbr: t.abbr, name: t.name }]));

  const players = Object.values(model.players);
  const priorOnly = players.filter((p) => p.prior_only).length;
  const unavailable = players.filter((p) => !p.prior_only && p.status?.fpl && p.status.fpl !== "a").length;
  console.log(`=== build-epl-model ===`);
  console.log(`  season ${model.season}: trained on ${model.trained_matches} matches through ${model.trained_through}`);
  console.log(`  ${players.length - priorOnly} players with data + ${priorOnly} prior-only (no minutes yet); ${unavailable} flagged not-available by FPL`);
  console.log(`  dispersion (NB size; null = Poisson): ${JSON.stringify(model.dispersion)}`);

  // Preview: next round's fixtures with model team totals.
  const next = snapshot.fixtures.filter((f) => !f.finished && !f.cancelled);
  const nextRound = next.length ? Math.min(...next.map((f) => f.round)) : null;
  if (nextRound != null) {
    const abbr = (tid) => model.teams[tid]?.abbr ?? tid;
    const tf = model.team_factors;
    console.log(`\n  Round ${nextRound} — model expected team totals (home / away):`);
    console.log(`  ${"fixture".padEnd(11)}  ${"xG".padStart(11)}  ${"shots".padStart(11)}  ${"SoT".padStart(9)}  ${"passes".padStart(9)}  ${"tackles".padStart(11)}  ${"clearances".padStart(11)}`);
    for (const f of next.filter((x) => x.round === nextRound)) {
      const h = f.home.team_id, a = f.away.team_id;
      const pair = (s, d) => `${teamTotal(tf[s], h, a, true).toFixed(d)} / ${teamTotal(tf[s], a, h, false).toFixed(d)}`;
      console.log(`  ${`${abbr(h)}-${abbr(a)}`.padEnd(11)}  ${pair("xg", 2).padStart(11)}  ${pair("shots", 1).padStart(11)}  ${pair("sot", 1).padStart(9)}  ${pair("passes_att", 0).padStart(9)}  ${pair("tackles", 1).padStart(11)}  ${pair("clearances", 1).padStart(11)}`);
    }
  }

  const json = artifactJson(model);
  console.log(`\n  data/epl-model.json: ${(json.length / 1024).toFixed(0)} KB`);
  if (DRY) {
    console.log("  DRY RUN — nothing written");
    return;
  }
  await fs.writeFile(OUT, json);
  console.log("  done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
