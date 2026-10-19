// Basketball opponent-factor model, step 3 — fit the runtime artifact the
// app reads in SHADOW mode (factor logged on every basketball verdict, no
// tier change) from the game-log snapshots in data/basketball/.
//
//   NBA   current season fitted on top of last season's full fit (prior team
//         factors at OPP_PARAMS.priorTeamWeight, player rates at 0.35); in the
//         preseason the artifact is last season's prior alone
//   WNBA  current season only (no carry-over)
//
// Writes data/<league>-opp-model.json; --push also writes the Blob copy the
// deployed app reads (api/_lib/basketball/opp-store.js).
//
// Usage: node scripts/build-basketball-opponent.mjs --league NBA|WNBA [--push]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitOpponentModel, compactModel } from "../api/_lib/basketball/opponent.js";
import { fitDistParams } from "../api/_lib/basketball/dist.js";
import { currentSeason } from "../api/_lib/nba-stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const li = args.indexOf("--league");
const LEAGUE = (li >= 0 ? args[li + 1] : "NBA").toUpperCase();
if (!["NBA", "WNBA"].includes(LEAGUE)) throw new Error(`--league must be NBA or WNBA (got ${LEAGUE})`);

const season = currentSeason(new Date(), LEAGUE);
const y = parseInt(season, 10);
const priorSeason = LEAGUE === "WNBA" ? String(y - 1) : `${y - 1}-${String(y % 100).padStart(2, "0")}`;
const load = async (s) => {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, "data", "basketball", `${LEAGUE.toLowerCase()}-${s}.json`), "utf8")); }
  catch { return null; }
};
const EMPTY = { players: {}, team_games: [], rows: [] };

async function main() {
  const cur = (await load(season)) ?? EMPTY;
  const priorSnap = LEAGUE === "NBA" ? await load(priorSeason) : null;
  const prior = priorSnap ? fitOpponentModel(priorSnap) : null;
  if (!cur.rows.length && !prior) throw new Error(`${LEAGUE}: no ${season} games and no prior — nothing to fit`);
  const model = fitOpponentModel(cur, { prior });
  const dataThrough = cur.team_games.reduce((m, t) => (t.date > m ? t.date : m), "") || null;
  // Calibrated distribution (basketball probability pipeline, step 1 —
  // SHADOW): fit walk-forward on the last completed season, as backtested.
  const distSnap = await load(priorSeason);
  const dist = distSnap ? { season: priorSeason, ...fitDistParams(distSnap) } : null;
  const out = compactModel(model, {
    league: LEAGUE, season, prior_season: prior ? priorSeason : null,
    fitted_at: new Date().toISOString(), data_through: dataThrough,
    current_games: cur.team_games.length / 2,
    dist,
  });
  const file = path.join(ROOT, "data", `${LEAGUE.toLowerCase()}-opp-model.json`);
  await fs.writeFile(file, JSON.stringify(out) + "\n");
  const g = Object.values(out.games);
  console.log(`build-basketball-opponent: ${LEAGUE} ${season} through ${dataThrough ?? "(no games yet — prior only)"}; ${Object.keys(out.team).length} defenses (games ${g.length ? Math.min(...g) : 0}–${g.length ? Math.max(...g) : 0}), ${Object.keys(out.rates).length} players → ${path.relative(ROOT, file)} (${(JSON.stringify(out).length / 1e3).toFixed(0)} KB)`);

  if (args.includes("--push")) {
    const { loadEnvLocal } = await import("./_env.mjs");
    loadEnvLocal();
    if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn("  --push: BLOB_READ_WRITE_TOKEN not set — skipped");
    else {
      const { oppModelStore } = await import("../api/_lib/basketball/opp-store.js");
      console.log(`  pushed to blob: ${await oppModelStore(LEAGUE).write(out)}`);
    }
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
