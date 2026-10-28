// Shared Axiom query helpers for the calibration + backtest tooling.
// Mirrors the query/join approach in scripts/grade-outcomes.mjs (two pulls,
// JS join — APL's join is fussier and the dataset is small).

const QUERY_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";

export const joinKey = (e) =>
  [e.player ?? "", e.prop_type ?? "", Number(e.line), e.direction ?? "", e.game_start_time ?? ""].join("|");

// Axiom returns at most 50,000 rows per query, whatever `| limit` asks for —
// a bigger result is silently truncated (2026-10-28: the 7-day grader window
// held 74k verdicts, mostly NFL sweeps, and the newest NBA verdicts never
// graded). Query in time windows (queryAxiomWindowed) and treat exactly
// AXIOM_ROW_CAP rows as truncation.
export const AXIOM_ROW_CAP = 50000;

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
  if (rows.length === AXIOM_ROW_CAP) {
    console.warn(`⚠️  Axiom returned exactly ${AXIOM_ROW_CAP} rows (${start} → ${end ?? "now"}) — the result is TRUNCATED. Narrow the query or use queryAxiomWindowed.`);
  }
  return rows;
}

/**
 * Run `apl` (a dataset + filters, WITHOUT `| limit`) over [start, end) in
 * day-sized windows so no single query reaches Axiom's 50,000-row cap. Each
 * window is pinned with an exact `_time` filter (no overlap, no gaps). A
 * window that still comes back with exactly AXIOM_ROW_CAP rows is split in
 * half and re-queried, down to `minWindowMs`; if it is still capped there,
 * the rows are kept and a truncation warning is printed.
 *
 * @param {string} token
 * @param {string} apl       e.g. `['props_verdict'] | where event_type == "verdict"`
 * @param {{ start:string, end?:string, tail?:string, windowMs?:number, minWindowMs?:number }} opts
 *   tail  APL appended after the time filter, e.g. `| project player, line`
 */
export async function queryAxiomWindowed(token, apl, { start, end, tail = "", windowMs = 86400000, minWindowMs = 3600000 } = {}) {
  const t0 = Date.parse(start);
  const t1 = end ? Date.parse(end) : Date.now() + 86400000;
  const run = async (a, b) => {
    const s = new Date(a).toISOString(), e = new Date(b).toISOString();
    const q = `${apl} | where _time >= datetime(${s}) and _time < datetime(${e}) ${tail} | limit ${AXIOM_ROW_CAP}`;
    // Large windows (a busy NFL sweep day of full rows) occasionally drop the
    // connection mid-response — retry with backoff before giving up.
    let data;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(QUERY_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ apl: q, startTime: s, endTime: e }),
        });
        if (!res.ok) throw new Error(`Axiom query HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
        data = await res.json();
        break;
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
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
    if (rows.length === AXIOM_ROW_CAP) {
      if (b - a > minWindowMs) {
        const mid = a + Math.floor((b - a) / 2);
        return [...(await run(a, mid)), ...(await run(mid, b))];
      }
      console.warn(`⚠️  Axiom returned exactly ${AXIOM_ROW_CAP} rows for ${s} → ${e} even at the minimum window — the result is TRUNCATED.`);
    }
    return rows;
  };
  const out = [];
  for (let a = t0; a < t1; a += windowMs) out.push(...(await run(a, Math.min(a + windowMs, t1))));
  return out;
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
  // Windowed: the full history is far past Axiom's 50,000-row cap. Start just
  // beyond the 30-day retention so nothing still held is missed.
  const start = new Date(Date.now() - 40 * 86400000).toISOString();
  const verdicts = await queryAxiomWindowed(token, `${D} | where event_type=="verdict"`, { start });
  const outcomes = await queryAxiomWindowed(token, `${D} | where event_type=="outcome"`, {
    start,
    tail: "| project player, prop_type, line, direction, game_start_time, hit_or_miss, actual_value",
  });
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
