// Sharp-odds layer: American-odds de-vig math + runtime lookup of the
// scraped sportsbook market (data/odds.json).
//
// The whole point of Stage 1 (see ENGINE_ACCURACY_PLAN.md): standard
// PrizePicks lines are ~efficient, so the engine can't out-project them from
// box scores. The edge is detecting when a PrizePicks line disagrees with the
// sharp market. This module turns a book's two-way (Over/Under) American odds
// into a vig-free fair P(over), which the engine compares against the
// PrizePicks line. v1 uses DraftKings only (single-book de-vig); the
// consensus helper takes a list so FanDuel can join later without API changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeName } from "./string-utils.js";

// DK ships American odds with a Unicode minus (− U+2212), en/em dashes, etc.
// Normalize before parsing so "−123" → -123.
export function parseAmerican(s) {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const cleaned = String(s).replace(/[−–—]/g, "-").replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== "" ? n : null;
}

// American odds → implied probability (INCLUDING vig).
export function impliedProb(american) {
  const a = parseAmerican(american);
  if (a == null || a === 0) return null;
  return a < 0 ? -a / (-a + 100) : 100 / (a + 100);
}

// Two-way de-vig: fair P(over) = impliedOver / (impliedOver + impliedUnder).
// Removes the book's hold by normalizing the two implied probs to sum to 1.
export function devigTwoWay(overAmerican, underAmerican) {
  const o = impliedProb(overAmerican);
  const u = impliedProb(underAmerican);
  if (o == null || u == null) return null;
  const denom = o + u;
  if (denom <= 0) return null;
  return o / denom;
}

// Per-stat ΔP(over) per 1.0 of line, from a normal approximation
// (dP/dx ≈ φ(0)/σ ≈ 0.4/σ) with rough per-game σ PER LEAGUE. Used to translate
// a book's fair P(over) — posted at the BOOK's line — to the PrizePicks line
// when they differ (~41% of props). APPROXIMATE: NBA σ runs larger than WNBA's
// (more possessions, higher lines), so NBA slopes are ~15-20% smaller. Refine
// per-league, or scrape DK alternate lines for an exact ladder (Stage-3).
// Reliable only for small shifts (the MAX_PROB_SHIFT guard discards the rest).
const PER_LEAGUE_STAT_SLOPE = {
  WNBA: {
    Points: 0.057,
    Rebounds: 0.114,
    Assists: 0.16,
    "3-Pointers Made": 0.30,
    PRA: 0.04,
    PR: 0.05,
    PA: 0.05,
    RA: 0.089,
  },
  NBA: {
    Points: 0.047,
    Rebounds: 0.105,
    Assists: 0.143,
    "3-Pointers Made": 0.267,
    PRA: 0.035,
    PR: 0.044,
    PA: 0.044,
    RA: 0.08,
  },
};
const DEFAULT_SLOPE = 0.05;

// Resolve the line-shift slope for a stat in a league. Unknown/absent league →
// WNBA (the v1 default; keeps league-less test/legacy odds entries stable).
export function slopeFor(stat, league) {
  const table = PER_LEAGUE_STAT_SLOPE[String(league || "WNBA").toUpperCase()] ?? PER_LEAGUE_STAT_SLOPE.WNBA;
  return table[stat] ?? DEFAULT_SLOPE;
}

/**
 * Shift a book's fair P(over) from its posted line to a target line.
 * Lowering the line raises P(over): shifted = fair + slope·(bookLine − target).
 * Clamped to [0.02, 0.98]. Returns fairOver unchanged when lines match.
 * `league` selects the per-league σ; absent → WNBA (back-compat).
 */
export function fairProbAtLine({ fairOver, bookLine, targetLine, stat, league }) {
  if (typeof fairOver !== "number") return null;
  if (typeof targetLine !== "number" || typeof bookLine !== "number") return fairOver;
  const slope = slopeFor(stat, league);
  const shifted = fairOver + slope * (bookLine - targetLine);
  return Math.max(0.02, Math.min(0.98, shifted));
}

// Average fair P(over) across books. v1 typically has one (DK); structured for
// multi-book consensus once FanDuel/others are added.
export function consensusFairProb(perBookFair) {
  const xs = (perBookFair || []).filter((x) => typeof x === "number" && x > 0 && x < 1);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─── Runtime store ───────────────────────────────────────────────────────────

let _odds = null;
let _normIndex = null;

function indexByNorm(data) {
  const idx = {};
  for (const [player, props] of Object.entries(data?.by_player || {})) {
    idx[normalizeName(player)] = { player, props };
  }
  return idx;
}

export function setOdds(data) {
  _odds = data;
  _normIndex = data ? indexByNorm(data) : null;
}

export function loadOdds() {
  if (_odds) return _odds;
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/odds.json");
    _odds = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    _odds = { by_player: {}, games: {} };
  }
  _normIndex = indexByNorm(_odds);
  return _odds;
}

/**
 * Look up the sharp market for a (player, stat) and report the fair P(over)
 * and how the book's line compares to the PrizePicks line.
 *
 * @returns {null | {
 *   fair_over: number,      // de-vigged P(over) at the BOOK's line
 *   book_line: number,      // the book's posted line
 *   line_delta: number|null,// pp line − book line (signed)
 *   over_american: number, under_american: number, books: number, source: string
 * }}
 */
export function lookupMarket({ player, stat, line, league = null }) {
  if (!_odds) loadOdds();
  const hit = _normIndex?.[normalizeName(player)];
  if (!hit) return null;
  // When a league is supplied, prefer a league-consistent entry: NBA & WNBA
  // share one odds.json keyed by player name, so an exact cross-league name
  // collision is otherwise possible. Fall back to any stat match (league-less
  // legacy/test odds, or when the caller doesn't know the league).
  const entry = (hit.props || []).find((p) => p.stat === stat && (league == null || p.league == null || p.league === league))
    || (hit.props || []).find((p) => p.stat === stat);
  if (!entry) return null;

  // Per-book sources. Back-compat: a flat entry (older schema / injected test
  // odds) counts as a single source.
  const sources = Array.isArray(entry.sources) && entry.sources.length
    ? entry.sources
    : (typeof entry.fair_over === "number"
        ? [{ book: entry.book ?? _odds.source ?? "book", line: entry.line, over_american: entry.over_american, under_american: entry.under_american, fair_over: entry.fair_over }]
        : []);
  if (!sources.length) return null;

  // Shift EACH book's fair P(over) to the requested line, then average → a
  // no-vig CONSENSUS at the line. (Returning fair-at-line keeps consumers
  // simple: no second shift downstream.)
  //
  // RELIABILITY GUARD: the linear line-shift only holds for small moves. If a
  // PrizePicks line sits far from a book's main line (a demon/goblin line, e.g.
  // a 24.5 points line vs a 16.5 book line), extrapolating the de-vig that far
  // yields garbage (→ a fake 98% UNDER). Only use a book's quote when the shift
  // moves probability ≤ MAX_PROB_SHIFT; if no book is close enough, return null
  // (we can't price this line without alternate-line ladders — Stage 3).
  const MAX_PROB_SHIFT = 0.08; // ~1pt on points; bigger PP-vs-book gaps are likely stale/mismatched, not edge (need alt-line ladders to price — Stage 3)
  const target = typeof line === "number" ? line : entry.line;
  const usable = [];
  for (const s of sources) {
    if (typeof s.fair_over !== "number" || typeof s.line !== "number") continue;
    const shifted = fairProbAtLine({ fairOver: s.fair_over, bookLine: s.line, targetLine: typeof target === "number" ? target : s.line, stat, league: entry.league ?? league });
    if (shifted == null) continue;
    if (typeof target === "number" && Math.abs(shifted - s.fair_over) > MAX_PROB_SHIFT) continue;
    usable.push({ s, shifted });
  }
  if (!usable.length) return null;
  const consensus = usable.reduce((a, u) => a + u.shifted, 0) / usable.length;
  const repLine = usable.reduce((a, u) => a + u.s.line, 0) / usable.length;

  return {
    fair_over: Number(consensus.toFixed(4)), // consensus, already AT the requested line
    book_line: Number(repLine.toFixed(2)),
    line_delta: typeof line === "number" ? Number((line - repLine).toFixed(2)) : null,
    books: usable.length,
    sources: usable.map((u) => u.s),
    source: usable.map((u) => u.s.book).join("+"),
    league: entry.league ?? league ?? null,
  };
}
