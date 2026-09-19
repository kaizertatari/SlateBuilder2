// Premier League team style report from data/epl-matches.json (run
// refresh-epl-data first). Per-match averages for what each team DOES and
// what it ALLOWS — the opponent/playstyle inputs the EPL player model uses:
//
//   Poss%     own possession
//   xG / xGA  non-penalty xG for / against
//   Sh / ShA  shots for / against;  SoTA = shots on target against (drives
//             the opposing keeper's Saves)
//   Pass/PassA passes attempted for / against (drives Passes Attempted)
//   Tilt%     own share of opposition-half passes (territory)
//   PPDA~     opponent own-half passes ÷ own (tackles + interceptions + fouls);
//             lower = more pressing. Approximation: FotMob doesn't zone
//             defensive actions, so this is not the canonical 60%-pitch PPDA.
//   CrA       crosses attempted AGAINST (drives the defenders' Clearances)
//   Tkl / Clr own tackles / clearances made
//   Fls / FlsD fouls committed / drawn
//
// Early-season samples are tiny (4–5 matches): read the ranks as hypotheses.
// The model shrinks every one of these toward the league average.
//
// Usage: npm run epl-team-report  [-- --sort xga]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const COLS = [
  ["Poss%", (t) => t.possession, 0],
  ["xG", (t) => t.npxg, 2],
  ["xGA", (t, o) => o.npxg, 2],
  ["Sh", (t) => t.shots, 1],
  ["ShA", (t, o) => o.shots, 1],
  ["SoTA", (t, o) => o.sot, 1],
  ["Pass", (t) => t.passes_att, 0],
  ["PassA", (t, o) => o.passes_att, 0],
  ["Tilt%", (t, o) => ratio(t.opp_half_passes, (t.opp_half_passes ?? 0) + (o.opp_half_passes ?? 0), 100), 0],
  ["PPDA~", (t, o) => ratio(o.own_half_passes, (t.tackles ?? 0) + (t.interceptions ?? 0) + (t.fouls ?? 0)), 1],
  ["CrA", (t, o) => o.crosses_att, 1],
  ["Tkl", (t) => t.tackles, 1],
  ["Clr", (t) => t.clearances, 1],
  ["Fls", (t) => t.fouls, 1],
  ["FlsD", (t, o) => o.fouls, 1],
];

function ratio(a, b, scale = 1) {
  return a == null || !b ? null : (a / b) * scale;
}

async function main() {
  const args = process.argv.slice(2);
  const sortIdx = args.indexOf("--sort");
  const sortKey = sortIdx >= 0 ? String(args[sortIdx + 1]).toLowerCase() : "xg";

  const data = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-matches.json"), "utf8"));
  const reg = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-players.json"), "utf8"));

  const acc = new Map(); // team_id → { mp, sums[] , counts[] }
  const league = { sums: COLS.map(() => 0), counts: COLS.map(() => 0) };
  for (const m of data.matches) {
    for (const [side, other] of [["home", "away"], ["away", "home"]]) {
      const tid = m[side].team_id;
      const t = m.team_stats[side];
      const o = m.team_stats[other];
      const a = acc.get(tid) ?? { mp: 0, gf: 0, ga: 0, sums: COLS.map(() => 0), counts: COLS.map(() => 0) };
      a.mp += 1;
      a.gf += m[side].score ?? 0;
      a.ga += m[other].score ?? 0;
      COLS.forEach(([, fn], i) => {
        const v = fn(t, o);
        if (v == null || !Number.isFinite(v)) return;
        a.sums[i] += v;
        a.counts[i] += 1;
        league.sums[i] += v;
        league.counts[i] += 1;
      });
      acc.set(tid, a);
    }
  }

  const rows = [...acc.entries()].map(([tid, a]) => ({
    team: reg.teams?.[tid]?.abbr ?? reg.teams?.[tid]?.short ?? tid,
    mp: a.mp,
    gd: `${a.gf}-${a.ga}`,
    vals: a.sums.map((s, i) => (a.counts[i] ? s / a.counts[i] : null)),
  }));
  const sortCol = COLS.findIndex(([h]) => h.toLowerCase().replace(/[%~]/g, "") === sortKey.replace(/[%~]/g, ""));
  const si = sortCol >= 0 ? sortCol : 1;
  rows.sort((x, y) => (y.vals[si] ?? -Infinity) - (x.vals[si] ?? -Infinity));

  const fmt = (v, d) => (v == null ? "—" : v.toFixed(d));
  const header = ["Team", "MP", "GF-GA", ...COLS.map(([h]) => h)];
  const table = [header, ...rows.map((r) => [r.team, String(r.mp), r.gd, ...r.vals.map((v, i) => fmt(v, COLS[i][2]))])];
  const leagueAvg = ["LEAGUE", "", "", ...league.sums.map((s, i) => fmt(league.counts[i] ? s / league.counts[i] : null, COLS[i][2]))];
  table.push(leagueAvg);
  const widths = header.map((_, c) => Math.max(...table.map((r) => String(r[c]).length)));
  const line = (r) => r.map((cell, c) => (c === 0 ? String(cell).padEnd(widths[c]) : String(cell).padStart(widths[c]))).join("  ");

  console.log(`EPL ${data.season} team styles — ${data.matches.length} matches, per-match averages (sorted by ${COLS[si][0]})\n`);
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of table.slice(1, -1)) console.log(line(r));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  console.log(line(leagueAvg));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
