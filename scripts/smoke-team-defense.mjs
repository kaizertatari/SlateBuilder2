// Smoke for opponent-defense coverage: team-id maps, ESPN↔stats abbr
// aliases, and the this-season/last-season blend in team-defense.js. No network.
//   node scripts/smoke-team-defense.mjs
import { readFileSync } from "node:fs";
import { resolveDefenseTable, DEF_BLEND_K } from "../api/_lib/team-defense.js";
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

// D) Blend: this season (live or current snapshot) with last season (NBA),
//    w = gp/(gp+K), last season re-centred on the current league mean.
const K = DEF_BLEND_K;
const cur = (gp) => ({ AAA: { def_rating: 112, gp }, BBB: { def_rating: 108, gp } });
const last = { AAA: { def_rating: 100 }, BBB: { def_rating: 110 } };
const live = (gp) => ({ teams: cur(gp), fetched_at: "2026-10-18T00:00:00Z" });
const prevSnap = { season: "2025-26", fetched_at: "2026-05-23T00:00:00Z", seasons: { "Regular Season": last } };
const resolve = (o) => resolveDefenseTable({ seasonType: "Regular Season", seasonLabel: "2026-27", league: "NBA", ...o });
const near = (a, b) => Math.abs(a - b) < 0.011;
{
  const t = resolve({ live: live(1), snapshot: prevSnap });
  const w = 1 / (1 + K);
  ok(t.source === "live+prior" && t.as_of === "2026-10-18T00:00:00Z", "D1: live + last season → live+prior");
  ok(near(t.teams.AAA.weight, w), `D1: weight after 1 game = ${w.toFixed(3)}`);
  ok(near(t.teams.AAA.def_rating, w * 112 + (1 - w) * 105), "D1: AAA blended with re-centred prior (105)");
  ok(t.teams.AAA.def_rank === 1, "D1: 1 game in, last season's ordering still wins");
}
{
  const t = resolve({ live: live(K), snapshot: prevSnap });
  ok(near(t.teams.BBB.weight, 0.5) && near(t.teams.BBB.def_rating, 111.5), "D2: at K games → 50/50");
}
{
  const t = resolve({ live: live(6 * K), snapshot: prevSnap });
  ok(t.teams.BBB.def_rank === 1 && t.teams.BBB.weight > 0.8, "D3: deep into the season this season's ordering wins");
}
{
  const t = resolve({ live: null, snapshot: prevSnap });
  ok(t.source === "prior" && t.season === "2025-26" && t.teams.AAA.weight === 0, "D4: preseason / live down → last season only");
}
{
  const snap = { season: "2026-27", fetched_at: "2026-11-01T00:00:00Z", seasons: { "Regular Season": cur(8) }, prior_season: { season: "2025-26", teams: last } };
  const t = resolve({ live: null, snapshot: snap });
  ok(t.source === "snapshot+prior" && near(t.teams.AAA.weight, 8 / (8 + K)), "D5: live down mid-season → current snapshot blended with its prior_season block");
}
{
  const t = resolve({ live: live(3), snapshot: { season: "2025", seasons: { "Regular Season": last } }, seasonLabel: "2026", league: "WNBA" });
  ok(t.source === "live" && t.teams.AAA.weight === 1, "D6: WNBA never blends last season");
}
{
  const t = resolve({ live: null, snapshot: { season: "2025", seasons: { "Regular Season": last } }, seasonLabel: "2026", league: "WNBA" });
  ok(t === null, "D7: WNBA with only last season → no table");
}
{
  const t = resolve({ live: null, snapshot: { season: "2026", seasons: { "Regular Season": cur(44) } }, seasonLabel: "2026", league: "WNBA" });
  ok(t.source === "snapshot" && t.teams.AAA.def_rank === 2, "D8: WNBA live down → current snapshot");
}
{
  const t = resolve({ live: { teams: { ...cur(5), NEW: { def_rating: 109, gp: 5 } } }, snapshot: prevSnap });
  ok(t.teams.NEW.weight === 1, "D9: team without a last-season row uses this season only");
}
{
  const t = resolve({ live: { teams: { AAA: { def_rating: 112 }, BBB: { def_rating: 108 } } }, snapshot: prevSnap });
  ok(t.teams.AAA.weight === 1, "D10: live without GP is trusted fully");
}
{
  // Opening week: BBB hasn't played, so live lists only AAA (curMean 112,
  // priorMean 105 → BBB's prior re-centres to 117).
  const t = resolve({ live: { teams: { AAA: { def_rating: 112, gp: 1 } } }, snapshot: prevSnap });
  ok(t.teams.BBB && t.teams.BBB.weight === 0 && t.teams.BBB.gp === 0, "D11: team yet to play keeps its last-season row");
  ok(near(t.teams.BBB.def_rating, 117) && t.teams.BBB.def_rank === 2, "D11: its prior is re-centred on the live mean");
}

console.log(`\nsmoke-team-defense: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
