// Probe stats.nba.com/stats/leagueseasonmatchups to confirm column names + shape
// before building api/lib/matchup-defender.js.
// Usage: node scripts/smoke-defender.mjs ["Player Name"] ["OPP_ABBR"] [Regular|Playoffs]

import { resolvePlayerId } from "../api/lib/player-ids.js";
import { currentSeason } from "../api/lib/nba-stats.js";

import { TEAM_ID_BY_ABBR } from "../api/lib/team-ids.js";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Connection": "keep-alive",
};

const player = process.argv[2] || "Joel Embiid";
const oppAbbr = (process.argv[3] || "BOS").toUpperCase();
const seasonTypeArg = (process.argv[4] || "Playoffs");
const seasonType = /play/i.test(seasonTypeArg) ? "Playoffs" : "Regular Season";

const playerId = resolvePlayerId(player);
const defTeamId = TEAM_ID_BY_ABBR[oppAbbr];
const season = currentSeason();

console.log(`Player: ${player} (id=${playerId})`);
console.log(`DefTeam: ${oppAbbr} (id=${defTeamId})`);
console.log(`Season: ${season}  SeasonType: ${seasonType}\n`);

if (!playerId || !defTeamId) {
  console.error("Bad input — playerId or defTeamId missing.");
  process.exit(1);
}

const params = new URLSearchParams({
  LeagueID: "00",
  PerMode: "Totals",
  Season: season,
  SeasonType: seasonType,
  OffPlayerID: String(playerId),
  DefTeamID: String(defTeamId),
});
const url = `https://stats.nba.com/stats/leagueseasonmatchups?${params}`;
console.log("URL:", url, "\n");

const res = await fetch(url, {
  headers: HEADERS,
  signal: AbortSignal.timeout(10000),
});
console.log("HTTP:", res.status, res.statusText);
if (!res.ok) {
  console.error(await res.text().catch(() => "(no body)"));
  process.exit(2);
}

const data = await res.json();
const rs = data.resultSets?.[0];
console.log("ResultSet name:", rs?.name);
console.log("Headers:", JSON.stringify(rs?.headers));
console.log(`Row count: ${rs?.rowSet?.length ?? 0}`);

if (!rs?.rowSet?.length) {
  console.log("\nNo rows. Either no matchups recorded yet or endpoint changed.");
  process.exit(0);
}

const rowToObj = (h, r) => Object.fromEntries(h.map((k, i) => [k, r[i]]));
const rows = rs.rowSet.map((r) => rowToObj(rs.headers, r));

const possKey = rs.headers.find((h) => /PARTIAL_POSS|POSS/i.test(h));
console.log(`Possessions key: ${possKey}`);

rows.sort((a, b) => (b[possKey] ?? 0) - (a[possKey] ?? 0));
const totalPoss = rows.reduce((s, r) => s + (r[possKey] ?? 0), 0);

console.log(`\nTop 3 defenders by ${possKey}:`);
for (const r of rows.slice(0, 3)) {
  const share = totalPoss ? ((r[possKey] ?? 0) / totalPoss) : 0;
  console.log(
    `  ${r.DEF_PLAYER_NAME?.padEnd(24)} poss=${(r[possKey] ?? 0).toFixed(1).padStart(6)}  ` +
    `share=${(share * 100).toFixed(1)}%  GP=${r.GP}  matchup_min=${r.MATCHUP_MIN}`
  );
}

console.log("\nFull headers list:");
console.log(rs.headers.join("\n"));
