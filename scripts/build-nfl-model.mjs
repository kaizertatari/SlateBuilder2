// NFL model step 2 — fit api/_lib/nfl/model.js on the nflverse snapshot
// (npm run refresh-nfl-data) and write the artifact data/nfl-model.json.
//
// Usage: npm run build-nfl-model  [-- --push]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitModel } from "../api/_lib/nfl/model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async (f) => JSON.parse(await fs.readFile(path.join(ROOT, "data", f), "utf8"));

// Round floats so the artifact diffs stay small and readable.
const round = (v) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(5)) : v);
const roundDeep = (o) => (Array.isArray(o) ? o.map(roundDeep) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, roundDeep(v)])) : round(o));

async function main() {
  const [pg, games, players, injuries] = await Promise.all([read("nfl-player-games.json"), read("nfl-games.json"), read("nfl-players.json"), read("nfl-injuries.json")]);
  const t0 = Date.now();
  const model = fitModel({ rows: pg.rows, games: games.games, players: players.players });
  // Runtime fields, so the deployed verdict engine reads ONE artifact: names
  // + roster status for the name resolver and gates, the upcoming schedule
  // (closing-line fallback when the odds snapshot has no game line), and the
  // two latest injury-report weeks.
  for (const [id, p] of Object.entries(model.players)) {
    const reg = players.players[id];
    if (!reg) continue;
    p.name = reg.name;
    p.status = reg.status ?? null;
    if (reg.team) p.roster_team = reg.team;
  }
  const schedule = games.games.filter((g) => g.home_score == null && g.season === model.current)
    .map(({ game_id, season, week, game_type, gameday, gametime, away, home, spread_line, total_line, roof }) => ({ game_id, season, week, game_type, gameday, gametime, away, home, spread_line, total_line, roof }));
  const injWeeks = [...new Set(injuries.rows.filter((r) => r.season === model.current).map((r) => r.week))].sort((a, b) => b - a).slice(0, 2);
  const injuryReport = {};
  for (const r of injuries.rows) {
    if (r.season !== model.current || !injWeeks.includes(r.week) || !model.players[r.player_id]) continue;
    (injuryReport[r.week] ??= {})[r.player_id] = { report_status: r.report_status ?? null, practice_status: r.practice_status ?? null, injury: r.primary_injury ?? null };
  }
  const out = roundDeep({ ...model, schedule, injuries: { season: model.current, weeks: injuryReport, fetched_at: injuries.fetched_at }, fitted_at: new Date().toISOString(), data_fetched_at: pg.fetched_at });
  await fs.writeFile(path.join(ROOT, "data/nfl-model.json"), JSON.stringify(out) + "\n");
  const qbs = Object.values(model.players).filter((p) => p.pos === "QB" && p.attShareStart != null).length;
  console.log(`build-nfl-model: fit through ${model.current} week ${model.lastWeek} on ${model.fitted_on} team-games in ${Date.now() - t0}ms — ${Object.keys(model.players).length} players (${qbs} QBs with starts); pass_att season shift ${model.team.pass_att.seasonAdj.toFixed(2)}`);
  if (process.argv.includes("--push")) {
    // Blob copy for the deployed app (api/_lib/nfl/store.js nflModelStore) —
    // without it the app keeps the artifact bundled at the last deploy.
    const { loadEnvLocal } = await import("./_env.mjs");
    loadEnvLocal();
    if (!process.env.BLOB_READ_WRITE_TOKEN) console.warn("  --push: BLOB_READ_WRITE_TOKEN not set — skipped");
    else {
      const { nflModelStore } = await import("../api/_lib/nfl/store.js");
      console.log(`  pushed to blob: ${await nflModelStore.write(out)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
