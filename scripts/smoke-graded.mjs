// Smoke for the durable graded store (scripts/_graded.mjs): join selection,
// month bucketing, idempotent merge, regrade replacement, read-back.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinGraded, mergeIntoStore, readGraded, monthOf } from "./_graded.mjs";

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

const base = { player: "A Player", prop_type: "Points OVER", line: 10.5, direction: "OVER", league: "WNBA" };
const ko = "2026-09-20T23:00Z";
const verdicts = [
  { ...base, game_start_time: ko, _time: "2026-09-20T18:00:00Z", event_type: "verdict", tier: "B", _sysTime: "x" },
  { ...base, game_start_time: ko, _time: "2026-09-20T22:00:00Z", event_type: "verdict", tier: "A", model_prob: null },
  { ...base, game_start_time: ko, _time: "2026-09-21T00:30:00Z", event_type: "verdict", tier: "S" },
  { ...base, line: 12.5, game_start_time: ko, _time: "2026-09-21T00:30:00Z", event_type: "verdict", tier: "B" },
  { ...base, league: "EPL", game_start_time: "2026-10-01T14:00Z", _time: "2026-10-01T12:00:00Z", event_type: "verdict", tier: "SKIP" },
];
const outcomes = [
  { ...base, game_start_time: ko, _time: "2026-09-22T09:00:00Z", event_type: "outcome", hit_or_miss: "hit", actual_value: 14 },
  { ...base, line: 12.5, game_start_time: ko, _time: "2026-09-22T09:00:00Z", event_type: "outcome", hit_or_miss: "miss", actual_value: 11 },
  { ...base, league: "EPL", game_start_time: "2026-10-01T14:00Z", _time: "2026-10-02T09:00:00Z", event_type: "outcome", hit_or_miss: "void" },
  { ...base, line: 99.5, game_start_time: ko, _time: "2026-09-22T09:00:00Z", event_type: "outcome", hit_or_miss: "hit" },
];

const rows = joinGraded(verdicts, outcomes);
const r1 = rows.find((r) => r.line === 10.5 && r.league === "WNBA");
check("joins 3 of 4 outcomes (orphan dropped)", rows.length === 3);
check("picks latest pre-kickoff verdict (A, not post-kickoff S)", r1?.tier === "A");
check("drops nulls, _sysTime, event_type", !("model_prob" in r1) && !("_sysTime" in r1) && !("event_type" in r1));
check("keeps verdict time as logged_at", r1?.logged_at === "2026-09-20T22:00:00Z");
check("nests outcome with graded_at", r1?.outcome?.hit_or_miss === "hit" && r1.outcome.graded_at === "2026-09-22T09:00:00Z");
check("outcome omits join fields", !("player" in r1.outcome) && !("line" in r1.outcome));
check("post-kickoff-only verdict flagged", rows.find((r) => r.line === 12.5)?.logged_after_kickoff === true);
check("monthOf buckets by UTC game month", monthOf(ko) === "2026-09" && monthOf("bad") === null);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graded-smoke-"));
try {
  const a = mergeIntoStore(rows, { dir });
  check("first merge adds all rows", a.files.reduce((s, f) => s + f.added, 0) === 3);
  check("files split by league/month", fs.existsSync(path.join(dir, "WNBA", "2026-09.jsonl")) && fs.existsSync(path.join(dir, "EPL", "2026-10.jsonl")));
  const b = mergeIntoStore(rows, { dir });
  check("re-merge is idempotent", b.files.every((f) => f.added === 0 && f.replaced === 0));
  const regraded = joinGraded(verdicts, [{ ...outcomes[0], _time: "2026-09-23T09:00:00Z", hit_or_miss: "push", actual_value: 10.5 }]);
  const c = mergeIntoStore(regraded, { dir });
  check("newer grade replaces stored row", c.files[0].replaced === 1);
  const stale = joinGraded(verdicts, [{ ...outcomes[0], _time: "2026-09-21T09:00:00Z" }]);
  check("older grade never overwrites", mergeIntoStore(stale, { dir }).files[0].replaced === 0);
  const back = readGraded({ dir });
  check("read-back returns every row once", back.length === 3);
  check("read-back carries the regrade", back.find((r) => r.line === 10.5 && r.league === "WNBA")?.outcome.hit_or_miss === "push");
  check("league + sinceMonth filters", readGraded({ dir, league: "EPL" }).length === 1 && readGraded({ dir, sinceMonth: "2026-10" }).length === 1);
  const dryDir = path.join(dir, "dry");
  mergeIntoStore(rows, { dir: dryDir, dry: true });
  check("dry run writes nothing", !fs.existsSync(dryDir));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nsmoke-graded: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
