// Honest backtest of the slate builder over Axiom graded history.
//
// Replays buildSlate day-by-day and reports realized ROI, the abstain rate,
// and bust rate — contrasted against a naive "always bet the top-N by
// confidence" baseline. Also rebuilds calibration on a train split and
// reports out-of-sample ROI, and checks the +EV-or-abstain policy against the
// operator's real PrizePicks entries.
//
// READ THE CAVEATS the script prints. With only a few hundred graded props the
// numbers are noisy and the in-sample run is optimistic. This harness is the
// measurement rig that will tell us — as the daily grader accrues data —
// WHEN the engine has a real, bettable edge. It is not a profitability promise.
//
//   node scripts/backtest-slates.mjs                 # target 3x, power, size 3
//   node scripts/backtest-slates.mjs --target 2 --mode flex
//   node scripts/backtest-slates.mjs --holdout 0.3   # train/test split fraction

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvLocal } from "./_env.mjs";
import { fetchJoinedVerdicts, settledBettable } from "./_axiom.mjs";
import { buildShrunkTable } from "./build-calibration.mjs";
import { buildSlate } from "../api/lib/slate-builder.js";
import { setCalibrationTable } from "../api/lib/calibration.js";
import { flexMultiplier } from "../api/lib/prizepicks-payouts.js";

loadEnvLocal();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = { target: 3, mode: "power", size: 3, holdout: 0.3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") o.target = Number(argv[++i]);
    else if (a === "--mode") o.mode = argv[++i];
    else if (a === "--size") o.size = Number(argv[++i]);
    else if (a === "--holdout") o.holdout = Number(argv[++i]);
  }
  return o;
}

const canonicalStat = (p) => String(p || "").replace(/\s+(OVER|UNDER)\s*$/i, "").trim();
const dayOf = (r) => String(r.game_start_time || "").slice(0, 10);
const legKey = (l) => `${l.player}|${l.stat_type || canonicalStat(l.prop_type)}|${Number(l.line)}|${l.direction}`;

function candFromRow(r) {
  return {
    player: r.player,
    stat_type: canonicalStat(r.prop_type),
    direction: r.direction,
    line: r.line,
    odds_type: r.odds_type,
    confidence: r.confidence,
    verdict: r.verdict,
    // Sharp-market prob (Stage 1) — null until market-aware verdicts are
    // ingested AND _axiom.mjs projects these fields (see TODO there). buildSlate
    // prefers it over confidence calibration when present.
    market_fair_at_line: r.market_fair_at_line ?? null,
    market_line_delta: r.market_line_delta ?? null,
    // Approx game key: same opponent + day ⇒ same game (prevents same-team
    // stacking; cross-team same-game legs may slip through — see README note).
    game: `${r.opponent || "?"}|${dayOf(r)}`,
    hit_or_miss: r.hit_or_miss,
  };
}

function groupByDay(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = dayOf(r);
    if (!d) continue;
    (m.get(d) ?? m.set(d, []).get(d)).push(candFromRow(r));
  }
  return m;
}

// Grade a built slate against actual outcomes for that day.
function gradeSlate(slate, hitMap) {
  const legs = slate.legs;
  const hits = legs.filter((l) => hitMap.get(legKey(l)) === "hit").length;
  let ret;
  if (slate.mode === "flex") ret = flexMultiplier(legs, hits).multiplier;
  else ret = hits === legs.length ? slate.win_multiplier : 0;
  return { ret, roi: ret - 1, bust: hits === 0, win: ret > 0, hits, n: legs.length };
}

function replay(daysMap, options) {
  let bet = 0, abst = 0, staked = 0, ret = 0, busts = 0, wins = 0, bestEv = -Infinity;
  for (const [, cands] of daysMap) {
    const r = buildSlate(cands, options);
    if (r.best_rejected && r.best_rejected.ev > bestEv) bestEv = r.best_rejected.ev;
    if (r.abstained) { abst++; continue; }
    const hitMap = new Map(cands.map((c) => [legKey(c), c.hit_or_miss]));
    const g = gradeSlate(r.slate, hitMap);
    bet++; staked += 1; ret += g.ret; if (g.bust) busts++; if (g.win) wins++;
  }
  const net = ret - staked;
  return { days: daysMap.size, bet, abst, staked, ret, net, busts, wins, bestEv,
    roi: staked ? net / staked : 0 };
}

// Naive baseline: every day, bet the top-N by confidence (distinct games), no
// calibration, no EV gate, no abstain. Power scoring.
function baseline(daysMap, { size }) {
  let bet = 0, staked = 0, ret = 0, busts = 0, wins = 0;
  const POWER = { 2: 3, 3: 5, 4: 10, 5: 20, 6: 37.5 };
  for (const [, cands] of daysMap) {
    const sorted = [...cands].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const picked = []; const games = new Set(); const props = new Set();
    for (const c of sorted) {
      const pk = `${c.player}|${c.stat_type}`;
      if (games.has(c.game) || props.has(pk)) continue;
      games.add(c.game); props.add(pk); picked.push(c);
      if (picked.length === size) break;
    }
    if (picked.length < size) continue;
    const hitMap = new Map(cands.map((c) => [legKey(c), c.hit_or_miss]));
    const hits = picked.filter((l) => hitMap.get(legKey(l)) === "hit").length;
    const r = hits === size ? POWER[size] : 0;
    bet++; staked += 1; ret += r; if (hits === 0) busts++; if (r > 0) wins++;
  }
  const net = ret - staked;
  return { bet, staked, ret, net, busts, wins, roi: staked ? net / staked : 0 };
}

const fmt = (r) => `bet ${r.bet}/${r.days ?? "?"} | net ${r.net >= 0 ? "+" : ""}${r.net.toFixed(2)}u | ROI ${(r.roi * 100).toFixed(1)}% | ${r.wins}W ${r.busts} busts`;

async function personalHistoryCheck(options) {
  let entries;
  try {
    entries = JSON.parse(await fs.readFile(path.join(ROOT, "data/prizepicks-entries.json"), "utf8"));
  } catch { return; }
  const settled = (entries.entries || []).filter((e) => e.status === "won" || e.status === "lost");
  if (!settled.length) return;
  let wouldBet = 0, wouldAbstain = 0, avoidedNet = 0, betNet = 0, skippedSize = 0;
  for (const e of settled) {
    const legs = e.legs.filter((l) => l.result === "win" || l.result === "loss");
    const n = legs.length;
    if (n < 2 || n > 6) { skippedSize++; continue; }
    const mode = e.type === "flex" ? "flex" : "power";
    const cands = legs.map((l, i) => ({
      player: l.player, stat_type: l.stat_type, direction: (l.pick || "over").toUpperCase(),
      line: l.line, odds_type: l.odds_type, game: `leg${i}`, // unique → no diversification block
    }));
    // Only gate on EV sign (target 0) — would the builder bet this ticket?
    const r = buildSlate(cands, { mode, size: n, maxPerGame: 99, targetMultiplier: 0, minEdge: 0 });
    const realized = (e.payout || 0) - (e.wager || 0);
    if (r.abstained) { wouldAbstain++; avoidedNet += realized; }
    else { wouldBet++; betNet += realized; }
  }
  console.log("\n=== PERSONAL-HISTORY POLICY CHECK (approx: uses odds_type base rates; your tickets had no engine confidence) ===");
  console.log(`  settled entries graded: ${wouldBet + wouldAbstain} (${skippedSize} skipped for size)`);
  console.log(`  builder would BET: ${wouldBet}   would ABSTAIN: ${wouldAbstain}`);
  console.log(`  realized net it would have AVOIDED (abstained tickets): ${avoidedNet >= 0 ? "+" : ""}$${avoidedNet.toFixed(2)}`);
  console.log(`  realized net on tickets it would have BET: ${betNet >= 0 ? "+" : ""}$${betNet.toFixed(2)}`);
}

async function main() {
  const token = process.env.AXIOM_TOKEN;
  const dataset = process.env.AXIOM_DATASET || "props_verdict";
  if (!token) { console.error("AXIOM_TOKEN not set — cannot backtest."); process.exit(1); }
  const opts = parseArgs(process.argv.slice(2));
  const options = { targetMultiplier: opts.target, mode: opts.mode, size: opts.size, maxPerGame: 1 };

  console.log("=== backtest-slates ===");
  console.log(`Target ${opts.target}× | mode ${opts.mode} | size ${opts.size} | diversify max 1/game`);

  const { joined } = await fetchJoinedVerdicts(token, dataset);
  // Production candidates always carry a real odds_type from the scrape, so the
  // backtest must too — exclude null/"unknown" (single-prop /api/analyze) legs,
  // whose calibration is inflated and would manufacture fake +EV here.
  const allSettled = settledBettable(joined);
  const settled = allSettled.filter((r) => ["goblin", "standard", "demon"].includes(String(r.odds_type || "").toLowerCase()));
  const daysMap = groupByDay(settled);
  console.log(`\n${settled.length} settled bettable legs across ${daysMap.size} days (dropped ${allSettled.length - settled.length} unknown-odds_type legs).`);
  console.log("CAVEATS: in-sample calibration (optimistic); tiny sample; void/push legs excluded;");
  console.log("approx game key; historical analyzed-set ≠ a full daily board. Treat as directional.\n");

  // In-sample (uses committed data/calibration.json)
  setCalibrationTable(null);
  const ins = replay(daysMap, options);
  console.log("IN-SAMPLE  builder : " + fmt(ins));
  if (ins.bet === 0) console.log(`           → abstained every day. Best daily slate EV seen: ${(ins.bestEv * 100).toFixed(1)}% (≤0 ⇒ correctly no bet).`);

  // Naive baseline
  const base = baseline(daysMap, { size: opts.size });
  console.log("BASELINE   top-N   : " + fmt({ ...base, days: daysMap.size }));

  // Out-of-sample train/test split by day
  const days = [...daysMap.keys()].sort();
  const cut = Math.floor(days.length * (1 - opts.holdout));
  const trainDays = new Set(days.slice(0, cut));
  const testDays = days.slice(cut);
  if (testDays.length && trainDays.size) {
    const trainRows = settled.filter((r) => trainDays.has(dayOf(r)));
    const testMap = new Map(testDays.map((d) => [d, daysMap.get(d)]));
    setCalibrationTable(buildShrunkTable(trainRows));
    const oos = replay(testMap, options);
    setCalibrationTable(null);
    console.log(`OOS (test ${testDays.length}d) builder: ` + fmt(oos) + "  [noisy — small test set]");
  } else {
    console.log("OOS: not enough days to split.");
  }

  await personalHistoryCheck(options);

  console.log("\nBottom line: if the builder abstains and the baseline loses, the framework is");
  console.log("doing its job — protecting bankroll until the engine shows real ≥target edge.");
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
