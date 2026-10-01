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
// fairProbAtLine turns each slope into a σ (0.4/slope) and prices off-book
// lines from a fitted distribution; lookupMarket caps the gap in σ units.
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

// Per-stat σ implied by the slope table (slope ≈ φ(0)/σ ≈ 0.4/σ).
export function sigmaForStat(stat, league) {
  return 0.4 / slopeFor(stat, league);
}

// Low-count stats priced as Poisson instead of normal: a normal curve is a
// poor fit to a 0–5 count (a 2.5 → 1.5 move on threes is one whole outcome).
const POISSON_STATS = new Set(["3-Pointers Made"]);

// Standard normal CDF — Abramowitz & Stegun 26.2.17 (|error| < 7.5e-8).
// Local copy: projection.js imports this module, so importing it back would
// make a cycle.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

// Inverse of normCdf by bisection (inputs are clamped probabilities, so ±8 is
// ample and 60 halvings is far below the CDF's own error).
function normInv(p) {
  let lo = -8, hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// P(X > line) for X ~ Poisson(λ). Over a half-point line that is
// P(X ≥ floor(line)+1); a whole-number line ignores the push.
function poissonOver(lambda, line) {
  const k = Math.floor(line) + 1;
  let term = Math.exp(-lambda), cdf = 0;
  for (let i = 0; i < k; i++) { cdf += term; term *= lambda / (i + 1); }
  return 1 - cdf;
}

// λ such that poissonOver(λ, line) = p (monotone increasing in λ).
function poissonLambdaFor(p, line) {
  let lo = 1e-6, hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (poissonOver(mid, line) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Shift a book's fair P(over) from its posted line to a target line.
 * Fits a distribution to the book's quote and reads it at the target:
 *   • normal (σ from the slope table): μ = bookLine + σ·Φ⁻¹(fair), then
 *     P(over target) = 1 − Φ((target − μ)/σ);
 *   • Poisson for low-count stats (POISSON_STATS): λ solved from the quote.
 * For small moves this matches the old linear shift (slope = φ(0)/σ); unlike
 * it, it stays sane for goblin/demon lines several points off the book.
 * Clamped to [0.02, 0.98]. Returns fairOver unchanged when lines match.
 * `league` selects the per-league σ; absent → WNBA (back-compat).
 */
export function fairProbAtLine({ fairOver, bookLine, targetLine, stat, league }) {
  if (typeof fairOver !== "number") return null;
  if (typeof targetLine !== "number" || typeof bookLine !== "number") return fairOver;
  if (targetLine === bookLine) return fairOver;
  const p = Math.max(0.02, Math.min(0.98, fairOver));
  let shifted;
  if (POISSON_STATS.has(stat)) {
    shifted = poissonOver(poissonLambdaFor(p, bookLine), targetLine);
  } else {
    const sigma = sigmaForStat(stat, league);
    const mu = bookLine + sigma * normInv(p);
    shifted = 1 - normCdf((targetLine - mu) / sigma);
  }
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
  // When a league is supplied, require a league-consistent entry: NBA & WNBA
  // share one odds.json keyed by player name, so an exact cross-league name
  // collision is otherwise possible. The fallback only admits LEAGUE-LESS
  // entries (legacy/test odds) — never an entry tagged with a different
  // league, which would price the wrong player's market.
  const entry = (hit.props || []).find((p) => p.stat === stat && (league == null || p.league == null || p.league === league))
    || (hit.props || []).find((p) => p.stat === stat && p.league == null);
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
  // RELIABILITY GUARD: fairProbAtLine fits a distribution to the book's quote,
  // so goblin/demon lines a few points off the book are priced (the old linear
  // shift discarded them — ~every goblin had no market vote). The fitted σ is
  // league-level, not per-player, so trust still fades with distance: discard
  // a quote when the PP line sits more than MAX_SIGMA_GAP σ from the book
  // line. Stage 5 — WNBA is a softer market (a bigger gap is more often
  // staleness edge), so it tolerates a wider gap. Tunable.
  const lg = String(entry.league ?? league ?? "").toUpperCase();
  const MAX_SIGMA_GAP = lg === "WNBA" ? 1.25 : 0.9; // ≈8.8pt / 7.7pt on points
  const maxGap = MAX_SIGMA_GAP * sigmaForStat(stat, entry.league ?? league);
  const target = typeof line === "number" ? line : entry.line;
  const usable = [];
  for (const s of sources) {
    if (typeof s.fair_over !== "number" || typeof s.line !== "number") continue;
    if (typeof target === "number" && Math.abs(target - s.line) > maxGap) continue;
    const shifted = fairProbAtLine({ fairOver: s.fair_over, bookLine: s.line, targetLine: typeof target === "number" ? target : s.line, stat, league: entry.league ?? league });
    if (shifted == null) continue;
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

/**
 * Game-script (Vegas) lookup for a player — the Stage-2 feed. Finds the
 * player's game via their scraped odds entry (DK tags each entry with its
 * `team` + `game` key, in DK's own abbreviations, so no ESPN↔DK abbr mapping
 * is needed), then reads that game's total + spread from the `games` block.
 *
 * Returns the player's TEAM implied total and spread:
 *   team_total = (game_total − team_spread) / 2   (team_spread < 0 ⇒ favored)
 *
 * Null when no odds are loaded, the player isn't covered, or only FanDuel
 * covered them (FD-only entries carry no game/team meta) — so the game-script
 * rule no-ops cleanly, exactly like rule-market-edge does without a market.
 *
 * @returns {null | { game_total, team_total, opp_total, team_spread, league, game }}
 */
export function lookupVegas({ player, league = null } = {}) {
  if (!_odds) loadOdds();
  const hit = _normIndex?.[normalizeName(player)];
  if (!hit) return null;
  const games = _odds?.games || {};
  // Require a league-consistent entry that carries DK game/team meta; the
  // fallback only admits league-less entries (legacy/test odds) — same
  // cross-league guard as lookupMarket.
  const tagged = (hit.props || []).find((p) => p.game && p.team && (league == null || p.league == null || p.league === league))
    || (hit.props || []).find((p) => p.game && p.team && p.league == null);
  if (!tagged) return null;
  const g = games[tagged.game];
  if (!g || typeof g.game_total !== "number") return null;
  const teamSpread = tagged.team === g.home ? g.home_spread
    : tagged.team === g.away ? g.away_spread
    : null;
  if (typeof teamSpread !== "number") return null;
  const teamTotal = (g.game_total - teamSpread) / 2;
  return {
    game_total: g.game_total,
    team_total: Number(teamTotal.toFixed(1)),
    opp_total: Number((g.game_total - teamTotal).toFixed(1)),
    team_spread: teamSpread,
    league: tagged.league ?? league ?? null,
    game: tagged.game,
  };
}
