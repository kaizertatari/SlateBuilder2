// Shared Axiom query helpers for the calibration + backtest tooling.
// Mirrors the query/join approach in scripts/grade-outcomes.mjs (two pulls,
// JS join — APL's join is fussier and the dataset is small).

const QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

export const joinKey = (e) =>
  [e.player ?? "", e.prop_type ?? "", Number(e.line), e.direction ?? "", e.game_start_time ?? ""].join("|");

export async function queryAxiom(token, apl, { start = "2024-01-01T00:00:00Z", end } = {}) {
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ apl, startTime: start, endTime: end ?? new Date(Date.now() + 86400000).toISOString() }),
  });
  if (!res.ok) throw new Error(`Axiom query HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const data = await res.json();
  const t = data?.tables?.[0];
  if (!t?.fields || !t?.columns) return [];
  const fields = t.fields.map((f) => f.name);
  const n = t.columns[0]?.length ?? 0;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = {};
    for (let c = 0; c < fields.length; c++) r[fields[c]] = t.columns[c][i];
    rows.push(r);
  }
  return rows;
}

/**
 * Pull verdicts + outcomes and join them in JS. Returns one row per graded
 * verdict with hit_or_miss/actual_value attached. Includes SKIP/void rows —
 * callers filter to what they need.
 */
export async function fetchJoinedVerdicts(token, dataset) {
  const D = `['${dataset}']`;
  // Pull FULL verdict rows (no `| project`). Axiom's schema is data-driven and
  // throws "invalid field" if you name a column it hasn't ingested, and the
  // Stage 1–5 signal fields (no_vig_prob, market_*, game_total/team_*, model_*,
  // rest_*, usage_*) appear over time. Full rows are schema-proof and the
  // dataset is small, so the backtest + calibration can read every signal field
  // as it lands — no projection to keep in sync, no invalid-field break.
  const verdicts = await queryAxiom(
    token,
    `${D} | where event_type=="verdict" | limit 100000`,
  );
  const outcomes = await queryAxiom(
    token,
    `${D} | where event_type=="outcome" | project player, prop_type, line, direction, game_start_time, hit_or_miss, actual_value | limit 100000`,
  );
  // Dedupe verdicts by join key (keep latest _time).
  const vByKey = new Map();
  for (const v of verdicts) {
    const k = joinKey(v);
    const prev = vByKey.get(k);
    if (!prev || new Date(v._time) > new Date(prev._time)) vByKey.set(k, v);
  }
  const joined = [];
  for (const o of outcomes) {
    const v = vByKey.get(joinKey(o));
    if (v) joined.push({ ...v, hit_or_miss: o.hit_or_miss, actual_value: o.actual_value });
  }
  return { joined, verdictCount: vByKey.size, outcomeCount: outcomes.length };
}

// Betting-relevant + settled (hit/miss). Drops SKIP, pre-filtered, void/push.
export function settledBettable(joined) {
  return joined.filter(
    (r) => !r.pre_filtered && r.verdict && r.verdict !== "SKIP" && (r.hit_or_miss === "hit" || r.hit_or_miss === "miss"),
  );
}
