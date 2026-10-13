// Durable graded-results store: data/graded/<league>/<YYYY-MM>.jsonl.
//
// Axiom keeps 30 days, and a graded result needs BOTH its verdict and its
// outcome event alive to be joined. export-graded.mjs copies each joined pair
// here so calibration can span seasons. One JSON object per line, one line per
// join key (player|prop|line|direction|game_start_time), bucketed by the
// game's UTC month. Rows are only ever added or replaced by a newer grade —
// never deleted — so re-running the export is idempotent.
//
// Row shape: the verdict's non-null fields (Axiom `_time` → `logged_at`) plus
//   outcome: { hit_or_miss, actual_value, ..., graded_at }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinKey, latestBeforeKickoff } from "../api/_lib/epl/grading.js";

export const GRADED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "graded");

const DROP = new Set(["_sysTime", "_time", "event_type"]);
const JOIN_FIELDS = ["player", "prop_type", "line", "direction", "game_start_time"];

const present = (x) => x != null && x !== "";

function compact(e, drop) {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (present(v) && !drop.has(k)) out[k] = v;
  return out;
}

/** Store key: league + the shared verdict↔outcome join key. */
export const rowKey = (r) => `${r.league ?? ""}|${joinKey(r)}`;

/** game_start_time → "YYYY-MM" (UTC), or null when unparseable. */
export function monthOf(gameStart) {
  const t = Date.parse(gameStart);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : null;
}

/**
 * Join verdict + outcome events into store rows. Per key, the verdict is the
 * latest one logged before kickoff (the line as it was bettable); keys with
 * only post-kickoff verdicts fall back to the latest and are flagged
 * `logged_after_kickoff`. Outcomes with no surviving verdict are dropped.
 */
export function joinGraded(verdicts, outcomes) {
  const pre = new Map(latestBeforeKickoff(verdicts).map((v) => [rowKey(v), v]));
  const any = new Map();
  for (const v of verdicts) {
    const k = rowKey(v);
    const prev = any.get(k);
    if (!prev || Date.parse(v._time) > Date.parse(prev._time)) any.set(k, v);
  }
  const latestOutcome = new Map();
  for (const o of outcomes) {
    const k = rowKey(o);
    const prev = latestOutcome.get(k);
    if (!prev || Date.parse(o._time) > Date.parse(prev._time)) latestOutcome.set(k, o);
  }
  const rows = [];
  for (const [k, o] of latestOutcome) {
    const v = pre.get(k) ?? any.get(k);
    if (!v) continue;
    const row = { ...compact(v, DROP), logged_at: v._time };
    if (!pre.has(k)) row.logged_after_kickoff = true;
    const outcome = compact(o, new Set([...DROP, ...JOIN_FIELDS, "league"]));
    outcome.graded_at = o._time;
    row.outcome = outcome;
    rows.push(row);
  }
  return rows;
}

const fileFor = (dir, league, month) => path.join(dir, String(league || "UNKNOWN"), `${month}.jsonl`);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

const sortRows = (rows) =>
  rows.sort((a, b) => String(a.game_start_time).localeCompare(String(b.game_start_time)) || rowKey(a).localeCompare(rowKey(b)));

/**
 * Merge rows into the store. A stored row is replaced only by a strictly newer
 * grade (outcome.graded_at). Returns per-file counts; writes nothing when dry.
 */
export function mergeIntoStore(rows, { dir = GRADED_DIR, dry = false } = {}) {
  const byFile = new Map();
  let skipped = 0;
  for (const r of rows) {
    const m = monthOf(r.game_start_time);
    if (!m) { skipped++; continue; }
    const f = fileFor(dir, r.league, m);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(r);
  }
  const report = [];
  for (const [file, incoming] of byFile) {
    const stored = new Map(readJsonl(file).map((r) => [rowKey(r), r]));
    let added = 0, replaced = 0;
    for (const r of incoming) {
      const k = rowKey(r);
      const prev = stored.get(k);
      if (!prev) { stored.set(k, r); added++; }
      else if (Date.parse(r.outcome?.graded_at) > Date.parse(prev.outcome?.graded_at)) { stored.set(k, r); replaced++; }
    }
    if (!dry && (added || replaced)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, sortRows([...stored.values()]).map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
    report.push({ file: path.relative(dir, file), added, replaced, total: stored.size });
  }
  return { files: report.sort((a, b) => a.file.localeCompare(b.file)), skipped };
}

/** Read stored rows, optionally for one league and/or from a game month on. */
export function readGraded({ dir = GRADED_DIR, league, sinceMonth } = {}) {
  if (!fs.existsSync(dir)) return [];
  const leagues = league ? [league] : fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
  const rows = [];
  for (const lg of leagues) {
    const ldir = path.join(dir, lg);
    if (!fs.existsSync(ldir)) continue;
    for (const f of fs.readdirSync(ldir).filter((x) => x.endsWith(".jsonl")).sort()) {
      if (sinceMonth && f.slice(0, 7) < sinceMonth) continue;
      rows.push(...readJsonl(path.join(ldir, f)));
    }
  }
  return rows;
}
