// Capture the NBA pregame context we can't recover later: the ESPN injury
// report (status per player) and the Vegas game lines (spread + total, from
// the DK+FD odds snapshot). Neither is stored historically anywhere else, so
// without this the known-lineup minutes and blowout effects can only be
// measured going forward. Appends one JSON line per capture to
// data/basketball/pregame/nba-<season>.jsonl; skips the write when nothing
// changed since the last capture. Runs after every odds refresh
// (refresh-odds-task.bat, 4×/day).
//
// Usage: node scripts/capture-nba-pregame.mjs [--dry-run]

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAllInjuries } from "../api/_lib/espn.js";
import { currentSeason } from "../api/_lib/nba-stats.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
// odds.json games carry no league tag and mix in WNBA; NBA totals run
// ~200–250, WNBA ~150–175.
const NBA_MIN_TOTAL = 185;
const HORIZON_MS = 36 * 3600 * 1000;

async function main() {
  const now = Date.now();
  const odds = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "odds.json"), "utf8"));
  const games = Object.entries(odds.games ?? {})
    .filter(([, g]) => typeof g.game_total === "number" && g.game_total >= NBA_MIN_TOTAL)
    .filter(([, g]) => { const t = Date.parse(g.start_time); return t > now - 6 * 3600 * 1000 && t < now + HORIZON_MS; })
    .map(([key, g]) => ({ key, home: g.home, away: g.away, start_time: g.start_time, game_total: g.game_total, home_spread: g.home_spread, away_spread: g.away_spread }));
  const inj = (await getAllInjuries({ league: "NBA" })) ?? [];
  const injuries = inj.map((t) => ({
    team_id: t.team_id, team_name: t.team_name,
    injuries: (t.injuries ?? []).map((i) => ({ player: i.player, status: i.status, type: i.type, detail: i.detail, date: i.date })),
  }));
  const body = { games, injuries };
  const hash = crypto.createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 12);

  const season = currentSeason(new Date(), "NBA");
  const dir = path.join(ROOT, "data", "basketball", "pregame");
  const file = path.join(dir, `nba-${season}.jsonl`);
  let lastHash = null;
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    try { lastHash = JSON.parse(lines.at(-1)).hash ?? null; } catch { lastHash = null; }
  }
  const nInj = injuries.reduce((a, t) => a + t.injuries.length, 0);
  const summary = `${games.length} NBA games (odds ${odds.fetched_at}), ${nInj} injury entries across ${injuries.length} teams`;
  if (hash === lastHash) { console.log(`capture-nba-pregame: unchanged since last capture (${summary}) — not written`); return; }
  if (!injuries.length && !games.length) { console.log("capture-nba-pregame: no games and no injuries (ESPN unreachable?) — not written"); process.exitCode = 1; return; }
  const row = { captured_at: new Date(now).toISOString(), odds_fetched_at: odds.fetched_at ?? null, hash, ...body };
  if (DRY) { console.log(`capture-nba-pregame (DRY RUN): would append ${summary} → ${path.relative(ROOT, file)}`); return; }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  console.log(`capture-nba-pregame: ${summary} → ${path.relative(ROOT, file)}`);
}

main().catch((e) => { console.error("capture-nba-pregame:", e.message ?? e); process.exit(1); });
