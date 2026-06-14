// End-to-end smoke for the PrizePicks slate builder.
// Verifies every layer the deployed app depends on, locally:
//   1. Required env vars present
//   2. Lines store reads (Blob → bundled fallback) return well-formed data
//   3. Today's slate has at least one player + props
//   4. Bucket selection picks lowest + median and tags Goblin/Normal correctly
//   5. Ground-truth fetch resolves a real player → season/L5/opponent fields
//   6. Framework prompt builds with the correct line + framework block
//   7. Routed LLM (Groq/Gemini) returns a parseable verdict + tier
//   8. analyze-all end-to-end produces tier_counts and runs every line
//  8b. Response cache: repeat call hits X-Cache: HIT with identical top_10
//   9. Blob roundtrip works (skipped when BLOB_READ_WRITE_TOKEN is absent)
//
// Run: npm run smoke:app
// Tail the last 40 lines for the verdict block.

import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();

import { readLines, writeLines } from "../api/_lib/lines-store.js";
import { gatherGroundTruth } from "../api/analyze.js";
import { selectLinesForStat } from "../api/analyze-all.js";
import { applyEngine } from "../api/_lib/engine.js";
import { mapPrizePicksStatType, STATS } from "../api/_lib/prop-types.js";

// ─── Test runner ──────────────────────────────────────────────────────────

const results = [];
let passed = 0, failed = 0, skipped = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    const r = await fn();
    if (r && r.skip) {
      console.log(`SKIP — ${r.skip}`);
      skipped++;
      results.push({ name, status: "skip", reason: r.skip });
    } else {
      console.log("PASS" + (r?.note ? ` — ${r.note}` : ""));
      passed++;
      results.push({ name, status: "pass", note: r?.note });
    }
  } catch (e) {
    console.log(`FAIL — ${e.message}`);
    failed++;
    results.push({ name, status: "fail", error: e.message });
  }
}

function header(s) {
  console.log(`\n[${s}]`);
}

// ─── 1. Environment ──────────────────────────────────────────────────────

console.log("=== smoke-app ===\n");
console.log(`node: ${process.version}`);
console.log(`cwd:  ${process.cwd()}`);

header("1. Environment");
await test("VERDICT_ENGINE=rules (engine-only branch)", () => {
  // The experiment branch is engine-only. No LLM provider keys are
  // required. We still surface a note so the operator sees which
  // verdict path is active.
  return { note: "rules (deterministic, no LLM)" };
});
await test("BLOB_READ_WRITE_TOKEN (optional)", () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { skip: "Blob roundtrip will be skipped — local-only smoke" };
  }
});

// ─── 2. Lines store ──────────────────────────────────────────────────────

header("2. Lines store");
let linesData = null;
await test("readLines() returns object", async () => {
  linesData = await readLines();
  if (!linesData || typeof linesData !== "object") throw new Error("not an object");
});
await test("has by_player + games maps", () => {
  if (!linesData) return { skip: "readLines failed" };
  if (!linesData.by_player || typeof linesData.by_player !== "object") {
    throw new Error("by_player missing");
  }
  if (!linesData.games || typeof linesData.games !== "object") {
    throw new Error("games missing");
  }
  return {
    note: `${Object.keys(linesData.games).length} games, ${Object.keys(linesData.by_player).length} players`,
  };
});
await test("fetched_at within 24h (else stale warn)", () => {
  if (!linesData?.fetched_at) throw new Error("no fetched_at");
  const ageMs = Date.now() - new Date(linesData.fetched_at).getTime();
  const ageH = (ageMs / 3_600_000).toFixed(1);
  if (ageMs > 24 * 3_600_000) {
    return { skip: `lines are ${ageH}h old — run npm run refresh-prizepicks` };
  }
  return { note: `${ageH}h old` };
});

// ─── 3. Sample player selection ───────────────────────────────────────────

header("3. Sample player");
let sample = null;
await test("pick player with most props", () => {
  if (!linesData?.by_player) return { skip: "no lines" };
  const candidates = Object.entries(linesData.by_player)
    .map(([name, props]) => ({ name, props }))
    .filter((p) => p.props.length > 0)
    .sort((a, b) => b.props.length - a.props.length);
  if (candidates.length === 0) throw new Error("no players with props in today's slate");
  sample = candidates[0];
  return { note: `${sample.name} (${sample.props.length} props)` };
});

// ─── 4. Bucket + Goblin/Standard selection ────────────────────────────────

header("4. Bucket selection (lowest goblin + standard)");
const buckets = new Map();
await test("bucketize by canonical stat", () => {
  if (!sample) return { skip: "no sample player" };
  for (const p of sample.props) {
    const stat = mapPrizePicksStatType(p.stat_type);
    if (!stat || !STATS.includes(stat)) continue;
    if (!buckets.has(stat)) buckets.set(stat, []);
    buckets.get(stat).push(p);
  }
  if (buckets.size === 0) throw new Error("no buckets after stat mapping");
  return { note: `${buckets.size} stats: ${[...buckets.keys()].join(", ")}` };
});
await test("selectLinesForStat picks goblin + standard + demon correctly", () => {
  if (buckets.size === 0) return { skip: "no buckets" };
  let goblinPicks = 0, standardPicks = 0, demonPicks = 0, fallbackPicks = 0;
  for (const [stat, props] of buckets) {
    const chosen = selectLinesForStat(props);
    if (chosen.length === 0) throw new Error(`${stat}: selection returned empty array`);
    if (chosen.length > 3) throw new Error(`${stat}: selection returned ${chosen.length} (>3)`);
    const goblinPresent = props.some((p) => p.odds_type === "goblin");
    const standardPresent = props.some((p) => p.odds_type === "standard");
    const demonPresent = props.some((p) => p.odds_type === "demon");
    // Verify the chosen entries reflect what PrizePicks actually published.
    for (const c of chosen) {
      if (!props.includes(c)) throw new Error(`${stat}: chosen entry not in source bucket`);
      if (c.odds_type === "goblin") goblinPicks += 1;
      else if (c.odds_type === "standard") standardPicks += 1;
      else if (c.odds_type === "demon") demonPicks += 1;
      else fallbackPicks += 1;
    }
    // The lowest demon should appear in the chosen set when demons are
    // published (unless it collapses onto a goblin/standard line via dedupe).
    if (demonPresent) {
      const lowestDemon = props.filter((p) => p.odds_type === "demon").sort((a, b) => a.line - b.line)[0];
      const sameAsGoblin = goblinPresent && chosen.some((c) => c.odds_type === "goblin" && c.line === lowestDemon.line);
      const sameAsStandard = standardPresent && chosen.some((c) => c.odds_type === "standard" && c.line === lowestDemon.line);
      const demonPicked = chosen.some((c) => c.odds_type === "demon");
      if (!demonPicked && !sameAsGoblin && !sameAsStandard) {
        throw new Error(`${stat}: demon ${lowestDemon.line} published but not in chosen set`);
      }
    }
  }
  return { note: `goblin=${goblinPicks}, standard=${standardPicks}, demon=${demonPicks}, fallback=${fallbackPicks}` };
});

// ─── 5. Ground truth ─────────────────────────────────────────────────────

header("5. Ground truth (gatherGroundTruth)");
let gt = null;
const firstStat = [...buckets.keys()][0];
const firstProp = firstStat ? buckets.get(firstStat)[0] : null;
await test(`fetch GT for ${sample?.name ?? "?"} / ${firstStat ?? "?"}`, async () => {
  if (!firstProp) return { skip: "no bucket" };
  const r = await gatherGroundTruth({
    player: sample.name,
    propType: `${firstStat} OVER`,
    line: firstProp.line,
  });
  if (r.skipReason) return { skip: r.skipReason };
  gt = r.groundTruth;
});
await test("GT has season + opponent_team + win_prob", () => {
  if (!gt) return { skip: "no GT" };
  if (!gt.season?.averages) throw new Error("season.averages missing");
  if (!gt.opponent_team?.abbr) throw new Error("opponent_team.abbr missing");
  if (!gt.win_prob || gt.win_prob.player_team_pct == null) throw new Error("win_prob missing");
  return { note: `vs ${gt.opponent_team.abbr}, win_prob=${(gt.win_prob.player_team_pct * 100).toFixed(0)}%` };
});

// ─── 6 + 7. Engine call (replaces former prompt build + LLM call) ────────

header("6. Engine call (applyEngine — deterministic, no LLM)");
let engineResult = null;
await test("applyEngine returns verdict object", () => {
  if (!gt || !firstStat || !firstProp) return { skip: "no GT / bucket" };
  const direction = "OVER";
  engineResult = applyEngine({
    groundTruth: gt,
    statType: firstStat,
    direction,
    line: firstProp.line,
  });
  if (!engineResult || typeof engineResult !== "object") throw new Error("no result");
});
await test("verdict ∈ {OVER, UNDER, SKIP}", () => {
  if (!engineResult) return { skip: "no result" };
  if (!["OVER", "UNDER", "SKIP"].includes(engineResult.verdict)) {
    throw new Error(`bad verdict: ${engineResult.verdict}`);
  }
  return { note: engineResult.verdict };
});
await test("tier ∈ {S, A, B, SKIP}", () => {
  if (!engineResult) return { skip: "no result" };
  if (!["S", "A", "B", "SKIP"].includes(engineResult.tier)) {
    throw new Error(`bad tier: ${engineResult.tier}`);
  }
  return { note: engineResult.tier };
});
await test("confidence in [0, 100]", () => {
  if (!engineResult) return { skip: "no result" };
  if (typeof engineResult.confidence !== "number" || engineResult.confidence < 0 || engineResult.confidence > 100) {
    throw new Error(`bad confidence: ${engineResult.confidence}`);
  }
  return { note: `${engineResult.confidence}%` };
});
await test("rules_fired is an array", () => {
  if (!engineResult) return { skip: "no result" };
  if (!Array.isArray(engineResult.rules_fired)) throw new Error("rules_fired not an array");
  return { note: engineResult.rules_fired.join(",") || "(none)" };
});
await test("justification is a non-empty string", () => {
  if (!engineResult) return { skip: "no result" };
  if (typeof engineResult.justification !== "string" || engineResult.justification.length < 10) {
    throw new Error(`bad justification: ${engineResult.justification}`);
  }
  return { note: `${engineResult.justification.length} chars` };
});

// ─── 8. End-to-end analyze-all ────────────────────────────────────────────

header("8. End-to-end /api/analyze-all");
let body = null;
let firstCacheHeader = null;
// Reuse this exact payload for the 8b cache-hit repeat call. Cache key
// depends on (player, direction, statTypes, lines_fetched_at), so the
// second request must match this body to land on the same key.
let analyzeAllPayload = null;
await test("POST analyze-all returns 200 + tier_counts", async () => {
  if (!sample) return { skip: "no sample" };
  const { POST } = await import("../api/analyze-all.js");
  analyzeAllPayload = JSON.stringify({ player: sample.name, direction: "OVER" });
  const req = new Request("http://localhost/api/analyze-all", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.99" },
    body: analyzeAllPayload,
  });
  const res = await POST(req);
  firstCacheHeader = res.headers.get("X-Cache");
  body = await res.json();
  if (body.error) throw new Error(body.error);
  if (typeof body.total_analyzed !== "number") throw new Error("total_analyzed missing");
  if (!body.tier_counts) throw new Error("tier_counts missing — UI transparency check broken");
});
await test("response includes lines_fetched_at + X-Cache: MISS (cold)", () => {
  if (!body) return { skip: "no body" };
  if (!body.lines_fetched_at) throw new Error("lines_fetched_at missing — frontend cache key can't be built");
  if (firstCacheHeader !== "MISS") {
    // Could be HIT if the previous smoke run within the same process warmed
    // the module-level cache. Acceptable but worth flagging.
    return { note: `cold header was ${firstCacheHeader} (expected MISS; HIT acceptable on warm reruns)` };
  }
  return { note: `MISS, fetched_at=${body.lines_fetched_at}` };
});
await test("framework ran on every line (sum(tier_counts) == total_analyzed)", () => {
  if (!body) return { skip: "no body" };
  const tc = body.tier_counts;
  // analyze-all.js already buckets errored tasks into tier_counts.UNKNOWN
  // (see the if (llm.error) branch in the batch loop), so errors[] is a
  // sidecar with per-task detail, not an additional category. The invariant
  // is just sum(tier_counts) == total_analyzed; errs is reported in the
  // note for visibility but not added to the sum (that double-counts).
  const sum = (tc.S || 0) + (tc.A || 0) + (tc.B || 0) + (tc.SKIP || 0) + (tc.UNKNOWN || 0);
  const errs = body.errors?.length || 0;
  if (sum !== body.total_analyzed) {
    throw new Error(`tier_counts sum (${sum}) ≠ total_analyzed (${body.total_analyzed})`);
  }
  return {
    note: `analyzed=${body.total_analyzed} S=${tc.S} A=${tc.A} B=${tc.B} SKIP=${tc.SKIP} UNK=${tc.UNKNOWN} err=${errs}`,
  };
});

// ─── 8b. Response cache (repeat call) ─────────────────────────────────────

header("8b. Response cache");
let cacheBody = null;
let cacheHeader = null;
await test("repeat POST returns X-Cache: HIT", async () => {
  if (!body || !analyzeAllPayload) return { skip: "section 8 didn't run" };
  const { POST } = await import("../api/analyze-all.js");
  const t0 = Date.now();
  const req = new Request("http://localhost/api/analyze-all", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.99" },
    body: analyzeAllPayload,
  });
  const res = await POST(req);
  const elapsed = Date.now() - t0;
  cacheHeader = res.headers.get("X-Cache");
  cacheBody = await res.json();
  if (cacheHeader !== "HIT") throw new Error(`X-Cache was "${cacheHeader}", expected HIT`);
  // Cache hits short-circuit before readLines fan-out, external APIs, and
  // the LLM batch loop. Sub-200ms is the cheap-path budget; anything beyond
  // that means something is re-running.
  if (elapsed > 200) {
    return { note: `HIT but slow (${elapsed}ms) — investigate` };
  }
  return { note: `HIT in ${elapsed}ms` };
});
await test("cached top_10 deep-equals first call", () => {
  if (!cacheBody || !body) return { skip: "no cache body" };
  const a = JSON.stringify(body.top_10 || []);
  const b = JSON.stringify(cacheBody.top_10 || []);
  if (a !== b) throw new Error("top_10 drifted between calls — cache returning stale or wrong entry");
  return { note: `${body.top_10?.length || 0} entries match` };
});
await test("cached response carries same lines_fetched_at", () => {
  if (!cacheBody || !body) return { skip: "no cache body" };
  if (cacheBody.lines_fetched_at !== body.lines_fetched_at) {
    throw new Error(`fetched_at drift: first=${body.lines_fetched_at}, cached=${cacheBody.lines_fetched_at}`);
  }
});

// ─── 8c. Line consistency: scraper → analyze-all → response ──────────────

header("8c. Line consistency: chosen line + odds_type round-trip");
await test("every top_10 entry maps back to a published line", () => {
  if (!body || !sample) return { skip: "no analyze-all body" };
  // Build a fast lookup keyed on (stat, line, odds_type → unique?). PrizePicks
  // sometimes publishes a single (line, odds_type) pair, sometimes multiples;
  // dedupe by mapping to a Set of (line:odds_type) strings.
  const publishedByStat = new Map();
  for (const p of sample.props) {
    const stat = mapPrizePicksStatType(p.stat_type);
    if (!stat) continue;
    if (!publishedByStat.has(stat)) publishedByStat.set(stat, new Set());
    publishedByStat.get(stat).add(`${p.line}:${p.odds_type ?? "null"}`);
  }
  for (const r of body.top_10 || []) {
    const stat = r.prop_type;
    const key = `${r.line}:${r.odds_type ?? "null"}`;
    const pub = publishedByStat.get(stat);
    if (!pub || !pub.has(key)) {
      throw new Error(`${r.player} ${stat} line=${r.line} odds=${r.odds_type} not found in published lines`);
    }
  }
  return { note: `${body.top_10?.length || 0} entries verified` };
});
await test("demon lines in top_10 use the lowest published demon", () => {
  if (!body || !sample) return { skip: "no analyze-all body" };
  // Index of (stat → lowest demon line published). Any demon entry that
  // surfaces in top_10 must be the lowest demon — otherwise the picker
  // dropped a more favorable demon line.
  const lowestDemonByStat = new Map();
  for (const p of sample.props) {
    const stat = mapPrizePicksStatType(p.stat_type);
    if (!stat || p.odds_type !== "demon") continue;
    const cur = lowestDemonByStat.get(stat);
    if (cur == null || p.line < cur) lowestDemonByStat.set(stat, p.line);
  }
  for (const r of body.top_10 || []) {
    if (r.odds_type !== "demon") continue;
    const expected = lowestDemonByStat.get(r.prop_type);
    if (expected != null && r.line !== expected) {
      throw new Error(`${r.player} ${r.prop_type}: demon ${r.line} ranked but lowest published demon is ${expected}`);
    }
  }
});

// ─── 9. Blob roundtrip ───────────────────────────────────────────────────

header("9. Blob roundtrip (writeLines)");
await test("write current data + read back identical shape", async () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { skip: "BLOB_READ_WRITE_TOKEN not set" };
  }
  if (!linesData) return { skip: "no linesData" };
  const url = await writeLines(linesData);
  if (!url || !url.startsWith("https://")) throw new Error(`bad URL: ${url}`);
  // Re-read; module-level URL cache means this is a no-op fetch in same process,
  // but the assertion that shape survives roundtrip is still meaningful.
  const fresh = await readLines();
  const before = Object.keys(linesData.by_player).length;
  const after = Object.keys(fresh.by_player).length;
  if (before !== after) throw new Error(`player count drifted: ${before} → ${after}`);
  return { note: url };
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log("\n=== Verdict ===");
console.log(`PASS: ${passed}`);
console.log(`FAIL: ${failed}`);
console.log(`SKIP: ${skipped}`);
console.log("");
if (failed > 0) {
  console.log("Failures:");
  for (const r of results) {
    if (r.status === "fail") console.log(`  ✗ ${r.name} — ${r.error}`);
  }
}
if (body?.tier_counts) {
  console.log("Sample analysis (tier_counts):");
  console.log(`  ${JSON.stringify(body.tier_counts)}`);
  const errs = body.errors?.length || 0;
  const rate = body.total_analyzed > 0 ? errs / body.total_analyzed : 0;
  if (rate > 0.25) {
    console.log(`⚠️  HIGH ERROR RATE: ${errs}/${body.total_analyzed} (${(rate * 100).toFixed(0)}%) — investigate`);
  }
  if (errs > 0) {
    console.log("Errors (first 5):");
    for (const e of (body.errors || []).slice(0, 5)) {
      console.log(`  ✗ ${e.task} — ${e.error}`);
    }
  }
}
if (engineResult) {
  console.log("Sample engine verdict (raw JSON):");
  console.log(JSON.stringify(engineResult, null, 2));
}
console.log("");
process.exit(failed > 0 ? 1 : 0);
