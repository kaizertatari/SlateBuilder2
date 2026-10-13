// NFL model step 2 — fit api/_lib/nfl/model.js on the nflverse snapshot
// (npm run refresh-nfl-data) and write the artifact data/nfl-model.json.
//
// Usage: npm run build-nfl-model

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
  const [pg, games, players] = await Promise.all([read("nfl-player-games.json"), read("nfl-games.json"), read("nfl-players.json")]);
  const t0 = Date.now();
  const model = fitModel({ rows: pg.rows, games: games.games, players: players.players });
  const out = roundDeep({ ...model, fitted_at: new Date().toISOString(), data_fetched_at: pg.fetched_at });
  await fs.writeFile(path.join(ROOT, "data/nfl-model.json"), JSON.stringify(out) + "\n");
  const qbs = Object.values(model.players).filter((p) => p.pos === "QB" && p.attShareStart != null).length;
  console.log(`build-nfl-model: fit through ${model.current} week ${model.lastWeek} on ${model.fitted_on} team-games in ${Date.now() - t0}ms — ${Object.keys(model.players).length} players (${qbs} QBs with starts); pass_att season shift ${model.team.pass_att.seasonAdj.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
