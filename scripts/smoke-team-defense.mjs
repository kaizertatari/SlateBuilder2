// Smoke for opponent-defense coverage: team-id maps, ESPN↔stats abbr
// aliases, and the live/snapshot table ranking in team-defense.js. No network.
//   node scripts/smoke-team-defense.mjs
import { readFileSync } from "node:fs";
import { rankDefenseTables, DEF_MIN_GAMES } from "../api/_lib/team-defense.js";
import { WNBA_TEAM_ID_BY_ABBR, TEAM_ID_BY_ABBR } from "../api/_lib/team-ids.js";
import { toNbaAbbr } from "../api/_lib/espn.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("  FAIL: " + m); } };

// A) Every team in each id map has an id, and the committed snapshot agrees
//    with the map (team_id per abbr) — catches the rotated LAS/MIN/WAS ids
//    and the never-filled POR/TOR ids.
for (const [league, file, map] of [
  ["WNBA", "data/team-defense-wnba.json", WNBA_TEAM_ID_BY_ABBR],
  ["NBA", "data/team-defense.json", TEAM_ID_BY_ABBR],
]) {
  const missingIds = Object.entries(map).filter(([, id]) => id == null).map(([a]) => a);
  ok(missingIds.length === 0, `A: ${league} ids missing for ${missingIds.join(",")}`);
  const snap = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).seasons["Regular Season"];
  for (const abbr of Object.keys(map)) {
    ok(snap[abbr]?.team_id === map[abbr], `A: ${league} ${abbr} snapshot team_id ${snap[abbr]?.team_id} != map ${map[abbr]}`);
  }
}
// B) Names behind the WNBA ids that were wrong
{
  const snap = JSON.parse(readFileSync(new URL("../data/team-defense-wnba.json", import.meta.url), "utf8")).seasons["Regular Season"];
  ok(/Sparks/.test(snap.LAS?.team_name), "B: LAS → Sparks");
  ok(/Lynx/.test(snap.MIN?.team_name), "B: MIN → Lynx");
  ok(/Mystics/.test(snap.WAS?.team_name), "B: WAS → Mystics");
}
// C) Every ESPN WNBA abbr seen in verdicts resolves to a mapped team
for (const espn of ["ATL", "CHI", "CON", "DAL", "GS", "IND", "LA", "LV", "MIN", "NY", "PHX", "POR", "SEA", "TOR", "WSH"]) {
  ok(WNBA_TEAM_ID_BY_ABBR[toNbaAbbr(espn, "WNBA")] != null, `C: ESPN ${espn} → ${toNbaAbbr(espn, "WNBA")} unmapped`);
}

// D) Table ranking
const teams = (gp) => ({ AAA: { def_rank: 1, gp }, BBB: { def_rank: 2, gp } });
const live = (gp) => ({ teams: teams(gp), fetched_at: "2026-10-18T00:00:00Z" });
const snap = (season) => ({ season, fetched_at: "2026-05-23T00:00:00Z", seasons: { "Regular Season": teams(82) } });
const rank = (o) => rankDefenseTables({ seasonType: "Regular Season", seasonLabel: "2026-27", league: "NBA", ...o });
{
  const t = rank({ live: live(DEF_MIN_GAMES), snapshot: snap("2026-27") });
  ok(t[0].source === "live" && !t[0].thin && t[0].as_of === "2026-10-18T00:00:00Z", "D1: established live first");
}
{
  const t = rank({ live: live(3), snapshot: snap("2025-26") });
  ok(t[0].source === "snapshot" && t[0].prior_season === true, "D2: NBA thin live → prior-season snapshot first, flagged");
  ok(t[1].source === "live" && t[1].thin === true, "D2: thin live kept as last resort");
}
{
  const t = rank({ live: null, snapshot: snap("2025-26") });
  ok(t.length === 1 && t[0].prior_season, "D3: NBA live down → prior-season snapshot, flagged");
}
{
  const t = rank({ live: null, snapshot: snap("2025"), seasonLabel: "2026", league: "WNBA" });
  ok(t.length === 0, "D4: WNBA never carries a prior-season snapshot");
}
{
  const t = rank({ live: live(4), snapshot: snap("2025"), seasonLabel: "2026", league: "WNBA" });
  ok(t.length === 1 && t[0].source === "live" && t[0].thin, "D5: WNBA early season → thin live only");
}
{
  const t = rank({ live: null, snapshot: snap("2026"), seasonLabel: "2026", league: "WNBA" });
  ok(t.length === 1 && t[0].source === "snapshot" && !t[0].prior_season, "D6: WNBA live down → current snapshot");
}
{
  const t = rank({ live: { teams: { AAA: { def_rank: 1 } } }, snapshot: null });
  ok(t.length === 1 && !t[0].thin && t[0].games === null, "D7: live without GP is not treated as thin");
}

console.log(`\nsmoke-team-defense: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
