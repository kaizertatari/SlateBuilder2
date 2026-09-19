// Walk-forward backtest of the EPL player model on this season's data.
// For each round R ≥ 2: fit on rounds < R only, predict every player who
// played in round R (conditioned on his ACTUAL minutes, so this grades the
// rate + opponent model, not the minutes model), and score against the
// outcome. The minutes model is graded separately (P(start) Brier).
//
// Methods compared on identical predictions:
//   model        full model (shares × two-way team totals, NB dispersion)
//   no-opp       model with the opponent factor switched off
//   no-team      model with both team factors switched off (share × league avg)
//   player-p90   player's raw per-90 average (role average if < 90 minutes)
//   role-p90     role's pooled per-90 average
//
// Scores: CRPS (whole-distribution, lower = better) and, at the half-integer
// line nearest the model mean (the line PrizePicks would plausibly post),
// log loss and Brier for P(over). Tiny early-season samples — read the
// direction, not the decimals.
//
// Usage: npm run backtest-epl-model  [-- --from 2] [-- --k-floor 5]

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fitModel, projectPlayer, roleFromPositionId } from "../api/_lib/epl/model.js";
import { mixtureCrps, lineProbs } from "../api/_lib/epl/distributions.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATS = [
  "shots", "sot", "key_passes", "passes_att", "crosses_att", "dribbles_att",
  "tackles", "clearances", "fouls", "fouled", "goals", "assists", "saves",
];
const METHODS = ["model", "no-opp", "no-team", "player-p90", "role-p90"];

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const FROM_ROUND = fromIdx >= 0 ? Number(args[fromIdx + 1]) : 2;
const kIdx = args.indexOf("--k-floor");
const K_FLOOR = kIdx >= 0 ? Number(args[kIdx + 1]) : undefined; // default: model's TEAM_SHRINK_FLOOR

const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

function ablate(model, { opp = false, team = false }) {
  const m = structuredClone(model);
  for (const tf of Object.values(m.team_factors)) {
    if (opp || team) tf.def = {};
    if (team) tf.att = {};
  }
  return m;
}

// Raw per-90 baselines from the training rows.
function rawRates(snapshot, beforeRound, model) {
  const ids = new Set(snapshot.matches.filter((m) => m.round < beforeRound).map((m) => m.match_id));
  const byPlayer = new Map();
  const byRole = new Map();
  for (const r of snapshot.player_matches) {
    if (!ids.has(r.match_id) || !(r.minutes > 0)) continue;
    const role = model.players[r.player_id]?.role ?? roleFromPositionId(r.position_id) ?? "CM";
    for (const [map, key] of [[byPlayer, r.player_id], [byRole, role]]) {
      const a = map.get(key) ?? { min: 0, sums: {} };
      a.min += r.minutes;
      for (const s of STATS) {
        const v = s === "goals" ? r.goals : s === "assists" ? r.assists : r[s];
        a.sums[s] = (a.sums[s] ?? 0) + (v ?? 0);
      }
      map.set(key, a);
    }
  }
  const per90 = (a, s) => (a && a.min > 0 ? (a.sums[s] / a.min) * 90 : 0);
  return {
    player: (pid, role, s) => {
      const a = byPlayer.get(pid);
      return a && a.min >= 90 ? per90(a, s) : per90(byRole.get(role), s);
    },
    role: (role, s) => per90(byRole.get(role), s),
  };
}

async function main() {
  const snapshot = JSON.parse(await fs.readFile(path.join(ROOT, "data/epl-matches.json"), "utf8"));
  const rounds = [...new Set(snapshot.matches.map((m) => m.round))].sort((a, b) => a - b).filter((r) => r >= FROM_ROUND);
  const matchById = new Map(snapshot.matches.map((m) => [m.match_id, m]));

  const score = {}; // stat → method → { n, crps, ll, brier }
  const calib = {}; // bucket → { n, pred, hit }  (model, all stats)
  const startEval = { n: 0, brierModel: 0, brierRaw: 0, brierLast: 0 };
  let predictions = 0;

  for (const R of rounds) {
    const model = fitModel(snapshot, { beforeRound: R, ...(K_FLOOR != null ? { teamShrinkFloor: K_FLOOR } : {}) });
    const variants = { model, "no-opp": ablate(model, { opp: true }), "no-team": ablate(model, { team: true }) };
    const raw = rawRates(snapshot, R, model);
    const targetIds = new Set(snapshot.matches.filter((m) => m.round === R).map((m) => m.match_id));
    const targetRows = snapshot.player_matches.filter((r) => targetIds.has(r.match_id));

    // Minutes model: P(start) for every modelled player whose team plays in R.
    for (const r of targetRows) {
      const p = model.players[r.player_id];
      if (!p || p.team_id !== r.team_id) continue;
      const y = r.started ? 1 : 0;
      startEval.n++;
      startEval.brierModel += (p.minutes.p_start - y) ** 2;
      startEval.brierRaw += (p.starts / Math.max(1, model.trained_matches > 0 ? countTeamMatches(model, snapshot, R, p.team_id) : 1) - y) ** 2;
      const last = lastStarted(snapshot, R, r.player_id, p.team_id);
      startEval.brierLast += (last - y) ** 2;
    }

    for (const r of targetRows) {
      if (!(r.minutes > 0)) continue;
      const p = model.players[r.player_id];
      if (!p) continue; // debutant: no training data
      const m = matchById.get(r.match_id);
      const home = m.home.team_id === r.team_id;
      const opp = home ? m.away.team_id : m.home.team_id;
      const venue = home ? "home" : "away";
      const proj = Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, projectPlayer(v, { playerId: r.player_id, opponentTeamId: opp, venue, minutes: { minutes: r.minutes } })]));

      for (const s of STATS) {
        const mp = proj.model.props[s];
        if (!mp) continue;
        const y = r[s] ?? 0;
        const muModel = (mp.per90 * r.minutes) / 90;
        const line = Math.max(0.5, Math.floor(muModel) + 0.5);
        const over = y > line ? 1 : 0;
        const dists = {
          model: { mu: muModel, r: mp.r },
          "no-opp": { mu: (proj["no-opp"].props[s].per90 * r.minutes) / 90, r: mp.r },
          "no-team": { mu: (proj["no-team"].props[s].per90 * r.minutes) / 90, r: mp.r },
          "player-p90": { mu: (raw.player(r.player_id, p.role, s) * r.minutes) / 90, r: Infinity },
          "role-p90": { mu: (raw.role(p.role, s) * r.minutes) / 90, r: Infinity },
        };
        for (const meth of METHODS) {
          const d = dists[meth];
          const a = ((score[s] ??= {})[meth] ??= { n: 0, crps: 0, ll: 0, brier: 0 });
          const pOver = clampP(lineProbs(line, d.mu, d.r).over);
          a.n++;
          a.crps += mixtureCrps(y, [{ p: 1, mu: d.mu, r: d.r }]);
          a.ll += -(over ? Math.log(pOver) : Math.log(1 - pOver));
          a.brier += (pOver - over) ** 2;
          if (meth === "model") {
            const b = Math.min(4, Math.floor(pOver * 5));
            const c = (calib[b] ??= { n: 0, pred: 0, hit: 0 });
            c.n++;
            c.pred += pOver;
            c.hit += over;
          }
        }
        predictions++;
      }
    }
  }

  console.log(`EPL model walk-forward backtest — rounds ${rounds.join(", ")} (fit on earlier rounds only), ${predictions} player-stat predictions\n`);
  const pad = (s, n) => String(s).padStart(n);
  console.log(`${"stat".padEnd(13)}${pad("n", 6)}   CRPS: ${METHODS.map((m) => pad(m, 10)).join("")}   logloss@line: ${METHODS.slice(0, 3).map((m) => pad(m, 8)).join("")}${pad("p90", 8)}`);
  const totals = Object.fromEntries(METHODS.map((m) => [m, { n: 0, crps: 0, ll: 0 }]));
  for (const s of STATS) {
    const row = score[s];
    if (!row) continue;
    const n = row.model.n;
    const best = METHODS.reduce((b, m) => (row[m].crps < row[b].crps ? m : b), "model");
    const crps = METHODS.map((m) => pad((row[m].crps / n).toFixed(3) + (m === best ? "*" : " "), 10)).join("");
    const ll = [...METHODS.slice(0, 3), "player-p90"].map((m) => pad((row[m].ll / n).toFixed(3), 8)).join("");
    console.log(`${s.padEnd(13)}${pad(n, 6)}         ${crps}                 ${ll}`);
    for (const m of METHODS) {
      totals[m].n += n;
      totals[m].crps += row[m].crps / n; // stat-averaged (passes' scale would dominate a raw sum)
      totals[m].ll += row[m].ll;
    }
  }
  const nStats = Object.keys(score).length;
  console.log(`\nMean over stats — CRPS (scale-free rank):`);
  const ranked = METHODS.map((m) => [m, totals[m].crps / nStats]).sort((a, b) => a[1] - b[1]);
  for (const [m, v] of ranked) console.log(`  ${m.padEnd(11)} ${v.toFixed(3)}   logloss@line ${(totals[m].ll / totals[m].n).toFixed(4)}`);

  console.log(`\nModel calibration, P(over) at the line nearest its mean (all stats):`);
  for (const b of Object.keys(calib).sort()) {
    const c = calib[b];
    console.log(`  predicted ${(b * 20).toString().padStart(2)}–${((+b + 1) * 20).toString().padStart(3)}%: n=${String(c.n).padStart(5)}  mean predicted ${((c.pred / c.n) * 100).toFixed(1)}%  realized ${((c.hit / c.n) * 100).toFixed(1)}%`);
  }

  console.log(`\nMinutes model — P(start) Brier (lower = better), n=${startEval.n}:`);
  console.log(`  model (recency-weighted) ${(startEval.brierModel / startEval.n).toFixed(4)}   season start rate ${(startEval.brierRaw / startEval.n).toFixed(4)}   started last match ${(startEval.brierLast / startEval.n).toFixed(4)}`);
}

function countTeamMatches(model, snapshot, R, teamId) {
  return snapshot.matches.filter((m) => m.round < R && (m.home.team_id === teamId || m.away.team_id === teamId)).length;
}

function lastStarted(snapshot, R, playerId, teamId) {
  const prev = snapshot.matches
    .filter((m) => m.round < R && (m.home.team_id === teamId || m.away.team_id === teamId))
    .sort((a, b) => String(b.kickoff_utc).localeCompare(String(a.kickoff_utc)))[0];
  if (!prev) return 0.5;
  const row = snapshot.player_matches.find((r) => r.match_id === prev.match_id && r.player_id === playerId);
  return row?.started ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
