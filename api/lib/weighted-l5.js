// PrizePicks Model v3.5 — weighted L5 baseline computation.
//
// Combines three independent multipliers per game (recency, opponent
// quality OR series-game position, outlier dampener) and normalizes the
// resulting weights to 1.0. Used by Rules 5a/5f, the S-tier gate
// independent-signal count, and the L5-vs-season tiebreaker.
//
// Game-level reads (5b.ii shooting-slump, 4c multi-star counts) continue
// to use raw L5 averages — only the *baseline* moves to weighted.
//
// Returns the {averages, raw_vs_weighted_delta, outlier_present, mode}
// shape consumed by composeGroundTruth + verdict-verifier.

const RECENCY_RAMP = [0.30, 0.25, 0.20, 0.15, 0.10];

// Move 1 (current-series accuracy hybrid) — per-game weight modifier based
// on which opponent the game was against. Applies in playoff_series mode
// only; regular mode uses opponent-quality, playoff_raw_fallback gets a
// neutral 1.0 (no series signal available yet).
//
// CURRENT_OPP: 1.5 — game vs the team in tonight's series. The matchup-
//   specific signal (scheme, primary defender, pace) is most predictive
//   of tonight's production.
// OTHER_PLAYOFF: 1.0 — game vs a different playoff opponent this year.
//   Still postseason context, just a different scheme.
// REGULAR_SEASON: 0.7 — defined for future use if/when reg-season head-
//   to-heads are mixed into the playoff L5 sample (Move 3 in the design
//   doc). Today only postseason games enter the playoff L5 path, so this
//   constant doesn't fire yet — kept here so the calibration baseline
//   stays visible alongside its siblings.
const OPPONENT_MATCH_WEIGHTS = {
  CURRENT_OPP: 1.5,
  OTHER_PLAYOFF: 1.0,
  REGULAR_SEASON: 0.7,
};

// Move 2 — when 3+ L5 games are vs the current playoff opponent, compute
// a separate unweighted mean over JUST those games and surface it as
// l5.weighted.current_series_averages. Rule 5a blends it with the full
// weighted-L5 baseline at this ratio:
//   blended = BLEND_CURRENT_SERIES × current_series + (1 − ratio) × full
// 0.6 tilts toward matchup-specific signal while keeping the full-sample
// stability anchor. See _helpers.computeOverBufferCheck.
export const BLEND_CURRENT_SERIES_RATIO = 0.6;
const CURRENT_SERIES_MIN_GAMES = 3;

// Move 3 — regular-season H2H mini-baseline. computeH2HAverages takes a
// deeper gamelog (typically last 50 reg-season games), filters to games
// against the current opponent via matchup parsing, and returns an
// unweighted average over the subset. Rule 5a blends it with the
// regular-mode baseline (season or weighted_L5) at 50/50 when at least
// H2H_MIN_GAMES are available. Playoff_L5 path does NOT consume this;
// that's the current-series blend's job.
export const BLEND_H2H_RATIO = 0.5;
export const H2H_MIN_GAMES = 2;

// Opponent-quality multiplier — regular-season mode.
function opponentMultiplier(defRank) {
  if (defRank == null) return 1.00;
  if (defRank <= 5) return 1.15;
  if (defRank <= 15) return 1.00;
  if (defRank <= 25) return 0.90;
  return 0.80;
}

// Series-game multiplier — playoff mode replaces opponent quality with this.
// game_number is the ordinal position within the current series (1..N).
function seriesMultiplier(gameNumber) {
  if (gameNumber == null) return 1.00; // non-series leftover
  if (gameNumber <= 2) return 0.75;
  if (gameNumber <= 4) return 1.00;
  return 1.20;
}

// Outlier dampener vs season ppg. Pulls hot games down hard (0.60) and
// cold games down lightly (0.85); on-trend games are unchanged.
function outlierMultiplier(pts, seasonPpg) {
  if (seasonPpg == null || pts == null) return 1.00;
  if (pts > 1.5 * seasonPpg) return 0.60; // hot outlier
  if (pts < 0.50 * seasonPpg) return 0.85; // cold outlier
  return 1.00;
}

// Parse opponent abbr out of an L5 game's matchup string. ESPN gamelog
// matchups come back as "BOS @ MIA" or "BOS vs MIA" — opponent is the
// team that isn't the player's own. Filters out matchup connectors (VS,
// AT, @) and home-away prefixes so we don't mistake "vs" for a team abbr.
const MATCHUP_CONNECTOR_TOKENS = new Set(["VS", "AT", "V", "@"]);
function parseOpponentAbbr(matchup, ownAbbr) {
  if (!matchup) return null;
  const own = String(ownAbbr || "").toUpperCase();
  const tokens = String(matchup).toUpperCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const clean = t.replace(/[^A-Z]/g, "");
    if (clean.length < 2 || clean.length > 4) continue;
    if (clean === own) continue;
    if (MATCHUP_CONNECTOR_TOKENS.has(clean)) continue;
    return clean;
  }
  return null;
}

// Detect whether any L5 game is an outlier vs season ppg. Surfaced on
// l5.weighted.outlier_present so Rule 5a can widen the OVER buffer for
// "post-outlier window" picks.
function hasOutlier(games, seasonPpg) {
  if (seasonPpg == null) return false;
  return games.some((g) => {
    const pts = g.pts ?? null;
    if (pts == null) return false;
    return pts > 1.5 * seasonPpg || pts < 0.50 * seasonPpg;
  });
}

// Average the per-game values weighted by `weights`. Both arrays must be
// the same length; weights must already be normalized to sum 1.0.
function weightedMean(games, weights, key) {
  let sum = 0;
  let totalWeight = 0;
  for (let i = 0; i < games.length; i++) {
    const v = games[i]?.[key];
    if (v == null) continue;
    sum += v * weights[i];
    totalWeight += weights[i];
  }
  if (totalWeight === 0) return null;
  // Re-normalize when some games miss the field — keeps the average on the
  // same scale as a single-game value.
  return Number((sum / totalWeight).toFixed(2));
}

// Identify which L5 games are vs the current playoff opponent and assign
// series-game ordinals (oldest-first numbering). Returns an array aligned
// with the games[] input: each entry is the series-game number or null
// when the game isn't part of the current series.
function assignSeriesNumbers(games, opponentAbbr, ownAbbr) {
  if (!opponentAbbr) return games.map(() => null);
  const opp = String(opponentAbbr).toUpperCase();
  // games[] is newest-first per ESPN — invert to assign G1, G2, ... in
  // chronological order, then map back to the newest-first layout.
  const oldestFirst = [...games].reverse();
  let counter = 0;
  const numbersOldestFirst = oldestFirst.map((g) => {
    const parsed = parseOpponentAbbr(g?.matchup, ownAbbr);
    if (parsed === opp) {
      counter += 1;
      return counter;
    }
    return null;
  });
  return numbersOldestFirst.reverse();
}

/**
 * Compute weighted L5 averages per v3.5 spec section 7.
 *
 * @param {Object} params
 * @param {Array<Object>} params.games  L5 games (newest-first). Each game
 *   should carry per-game stats {pts, reb, ast, fgm, fga, ftm, fta, blk,
 *   stl, tov, minutes, pra, matchup}.
 * @param {number|null} params.seasonPpg  Regular-season points-per-game.
 *   Used as the outlier reference outside playoff mode, and as the playoff
 *   fallback when no playoffPpg is supplied. Null disables outlier dampening.
 * @param {number|null} params.playoffPpg  Current playoff PPG (typically
 *   the raw mean of l5.games when l5.season_type === "Playoffs" and
 *   l5.n >= 5). When non-null AND `series` is present, this becomes the
 *   outlier reference instead of `seasonPpg` — a player whose playoff
 *   usage shifts shouldn't be flagged as "anomalous" for performing at
 *   their playoff norm. Null = fall back to seasonPpg.
 * @param {string|null} params.ownAbbr  Player's own team abbreviation
 *   (used to parse opponent out of matchup strings).
 * @param {Object|null} params.series  Playoff series context, if any
 *   (groundTruth.series shape). Triggers playoff_series / playoff_raw_fallback
 *   modes.
 * @param {Object|null} params.defRankByAbbr  Map of team_abbr → def_rank
 *   from the current-season snapshot. Used for the regular-season opponent
 *   quality multiplier. Per-game lookups are a deliberate v3.5 limitation
 *   (uses current-season as a proxy).
 * @returns {{averages: Object, raw_vs_weighted_delta: Object, outlier_present: boolean, outlier_ref_type: string, mode: string}|null}
 *   Null when `games` is empty.
 */
export function computeWeightedL5({ games, seasonPpg, playoffPpg, ownAbbr, series, defRankByAbbr }) {
  if (!Array.isArray(games) || games.length === 0) return null;

  const isPlayoff = !!series;
  // Outlier reference: in playoff mode prefer the player's current playoff
  // PPG so an anomaly is judged against the player's playoff norm, not
  // their regular-season norm (which may diverge materially for stars
  // whose usage spikes in postseason). Falls back to seasonPpg when no
  // playoffPpg is provided.
  const outlierRef = (isPlayoff && playoffPpg != null) ? playoffPpg : seasonPpg;
  const outlierRefType = (isPlayoff && playoffPpg != null) ? "playoff_l5" : "regular_season";

  // Decide mode + per-game opponent multipliers up front so callers can
  // emit the correct diagnostic flag without re-deriving.
  //
  // `seriesNumbers` is hoisted so Move 1 (opponent_match weighting) and
  // Move 2 (current_series_averages) can both read which L5 games are
  // vs the current playoff opponent without re-parsing matchup strings.
  //
  // playoff_raw_fallback used to short-circuit to raw averages here. It
  // now flows through the standard weighted path with the series
  // multiplier neutralized — outlier dampening + recency still apply
  // because they're orthogonal to having a usable series sample. The
  // mode name is preserved so Axiom queries on l5_mode keep working.
  let mode;
  let perGameMultipliers;
  let seriesNumbers = null;
  let vsCurrentOpp = 0;
  if (isPlayoff) {
    const opponentAbbr = series?.opponent_abbr ?? series?.opponent_team_abbr ?? null;
    seriesNumbers = assignSeriesNumbers(games, opponentAbbr, ownAbbr);
    vsCurrentOpp = seriesNumbers.filter((x) => x != null).length;
    if (vsCurrentOpp < CURRENT_SERIES_MIN_GAMES) {
      mode = "playoff_raw_fallback";
      perGameMultipliers = games.map(() => 1.0);
    } else {
      mode = "playoff_series";
      perGameMultipliers = seriesNumbers.map((num) => seriesMultiplier(num));
    }
  } else {
    mode = "regular";
    perGameMultipliers = games.map((g) => {
      const oppAbbr = parseOpponentAbbr(g?.matchup, ownAbbr);
      const defRank = oppAbbr && defRankByAbbr ? defRankByAbbr[oppAbbr] ?? null : null;
      return opponentMultiplier(defRank);
    });
  }

  // perOpponentMatch — Move 1's per-game weight modifier. Only applies
  // in playoff_series mode (current-vs-other opponent signal is what it
  // captures). playoff_raw_fallback and regular mode get a neutral 1.0
  // because they don't have the series-vs-other distinction.
  const perOpponentMatch = (mode === "playoff_series" && seriesNumbers)
    ? seriesNumbers.map((num) =>
        num != null ? OPPONENT_MATCH_WEIGHTS.CURRENT_OPP : OPPONENT_MATCH_WEIGHTS.OTHER_PLAYOFF
      )
    : games.map(() => 1.0);

  // Composite weights: recency × (opponent OR series) × outlier × opponent_match.
  const rawWeights = games.map((g, i) => {
    const recency = RECENCY_RAMP[i] ?? 0;
    const groupMul = perGameMultipliers[i] ?? 1.0;
    const outMul = outlierMultiplier(g?.pts ?? null, outlierRef);
    const matchMul = perOpponentMatch[i] ?? 1.0;
    return recency * groupMul * outMul * matchMul;
  });
  const totalWeight = rawWeights.reduce((a, b) => a + b, 0) || 1;
  const weights = rawWeights.map((w) => w / totalWeight);

  // Compute weighted averages for the core stat fields. Composite stats
  // (pr/pa/ra/pra) are derived from the weighted ppg/rpg/apg so they stay
  // internally consistent with the headline averages.
  const ppg = weightedMean(games, weights, "pts") ?? 0;
  const rpg = weightedMean(games, weights, "reb") ?? 0;
  const apg = weightedMean(games, weights, "ast") ?? 0;
  const round1 = (v) => v == null ? null : Number(v.toFixed(1));
  const wBlk = weightedMean(games, weights, "blk");
  const wStl = weightedMean(games, weights, "stl");
  const wTov = weightedMean(games, weights, "tov");
  // Fantasy Score weighted from weighted underlying stats so the
  // composite stays consistent with the headline averages. Returns null
  // when tov is unknown — matches the Rule 5a baseline-missing semantics
  // used elsewhere (the framework SKIPs cleanly instead of evaluating
  // against an inflated FS).
  const wFs = (wTov == null)
    ? null
    : ppg + 1.2 * rpg + 1.5 * apg + 3 * (wStl ?? 0) + 3 * (wBlk ?? 0) - 1 * wTov;
  const averages = {
    ppg: round1(ppg),
    rpg: round1(rpg),
    apg: round1(apg),
    fgm: weightedMean(games, weights, "fgm"),
    fga: weightedMean(games, weights, "fga"),
    fg3a: weightedMean(games, weights, "fg3a"),
    ftm: weightedMean(games, weights, "ftm"),
    fta: weightedMean(games, weights, "fta"),
    blk: wBlk,
    stl: wStl,
    tov: wTov,
    minutes: weightedMean(games, weights, "minutes"),
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
    bs: round1((wBlk ?? 0) + (wStl ?? 0)),
    fs: wFs != null ? round1(wFs) : null,
  };

  const raw = rawAverages(games);
  const delta = {
    ppg: round1((averages.ppg ?? 0) - (raw.ppg ?? 0)),
    rpg: round1((averages.rpg ?? 0) - (raw.rpg ?? 0)),
    apg: round1((averages.apg ?? 0) - (raw.apg ?? 0)),
    pra: round1((averages.pra ?? 0) - (raw.pra ?? 0)),
  };

  // Move 2 — current-series mini-baseline. Computed in playoff_series
  // mode when vsCurrentOpp >= CURRENT_SERIES_MIN_GAMES (already the gate
  // separating playoff_series from playoff_raw_fallback). Unweighted mean
  // over the current-opponent subset; recency is already captured by the
  // full weighted-L5 baseline this gets blended against in _helpers.js.
  let current_series_averages = null;
  let current_series_n = 0;
  if (mode === "playoff_series" && seriesNumbers) {
    const subset = games.filter((_, i) => seriesNumbers[i] != null);
    current_series_n = subset.length;
    if (current_series_n >= CURRENT_SERIES_MIN_GAMES) {
      current_series_averages = rawAverages(subset);
    }
  }

  // Trimmed weighted averages — drop the single highest game (by target
  // field) and recompute the weighted mean. Rule 5a consults this on
  // OVER when the full baseline depends on one anomalous game; the pts-
  // based outlier_present flag misses Fantasy-Score-style anomalies
  // (game where reb+ast+stl carry the composite while pts stay normal),
  // so the drop-max trim works directly off each headline field instead.
  const trimmed_averages = computeTrimmedAverages(games, weights);

  return {
    averages,
    raw_vs_weighted_delta: delta,
    outlier_present: hasOutlier(games, outlierRef),
    outlier_ref_type: outlierRefType,
    mode,
    // null when not playoff_series or sample too small. Rule 5a only
    // blends when present.
    current_series_averages,
    current_series_n,
    // Drop-max trimmed weighted means per headline stat. Used by Rule 5a
    // to gate S-tier when one anomalous game is doing the heavy lifting.
    trimmed_averages,
  };
}

// Drop the single highest game by value(g) and compute the weighted
// mean of the rest. Returns null when fewer than 2 games carry a value
// (a single sample can't be meaningfully trimmed).
function trimmedWeightedMean(games, weights, valueFn) {
  const values = games.map((g) => valueFn(g));
  const withValue = values.filter((v) => v != null);
  if (withValue.length < 2) return null;
  let maxIdx = -1;
  let maxVal = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] != null && values[i] > maxVal) {
      maxVal = values[i];
      maxIdx = i;
    }
  }
  let sum = 0;
  let totalWeight = 0;
  for (let i = 0; i < games.length; i++) {
    if (i === maxIdx) continue;
    const v = values[i];
    if (v == null) continue;
    sum += v * weights[i];
    totalWeight += weights[i];
  }
  if (totalWeight === 0) return null;
  return Number((sum / totalWeight).toFixed(2));
}

function computeTrimmedAverages(games, weights) {
  const round1 = (v) => v == null ? null : Number(v.toFixed(1));
  const pts = (g) => g?.pts ?? null;
  const reb = (g) => g?.reb ?? null;
  const ast = (g) => g?.ast ?? null;
  const stl = (g) => g?.stl ?? null;
  const blk = (g) => g?.blk ?? null;
  const pra = (g) => (g?.pts != null && g?.reb != null && g?.ast != null) ? g.pts + g.reb + g.ast : null;
  const pr  = (g) => (g?.pts != null && g?.reb != null) ? g.pts + g.reb : null;
  const pa  = (g) => (g?.pts != null && g?.ast != null) ? g.pts + g.ast : null;
  const ra  = (g) => (g?.reb != null && g?.ast != null) ? g.reb + g.ast : null;
  const bs  = (g) => (g?.blk != null || g?.stl != null) ? (g.blk ?? 0) + (g.stl ?? 0) : null;
  const fs  = (g) => {
    if (g?.pts == null || g?.reb == null || g?.ast == null || g?.tov == null) return null;
    return g.pts + 1.2 * g.reb + 1.5 * g.ast + 3 * (g.stl ?? 0) + 3 * (g.blk ?? 0) - g.tov;
  };
  return {
    ppg: round1(trimmedWeightedMean(games, weights, pts)),
    rpg: round1(trimmedWeightedMean(games, weights, reb)),
    apg: round1(trimmedWeightedMean(games, weights, ast)),
    pra: round1(trimmedWeightedMean(games, weights, pra)),
    pr:  round1(trimmedWeightedMean(games, weights, pr)),
    pa:  round1(trimmedWeightedMean(games, weights, pa)),
    ra:  round1(trimmedWeightedMean(games, weights, ra)),
    bs:  round1(trimmedWeightedMean(games, weights, bs)),
    fs:  round1(trimmedWeightedMean(games, weights, fs)),
    blk: trimmedWeightedMean(games, weights, blk),
    stl: trimmedWeightedMean(games, weights, stl),
  };
}

// Plain mean over the games. Mirrors what ESPN's getLastNGames already
// produces, but recomputed here so the weighted module is self-contained
// (and so we can drive the raw_vs_weighted_delta without depending on the
// caller's enrichment path).
function rawAverages(games) {
  const round1 = (v) => v == null ? null : Number(v.toFixed(1));
  const avg = (key) => {
    let sum = 0;
    let count = 0;
    for (const g of games) {
      const v = g?.[key];
      if (v == null) continue;
      sum += v;
      count += 1;
    }
    return count === 0 ? null : sum / count;
  };
  const ppg = avg("pts") ?? 0;
  const rpg = avg("reb") ?? 0;
  const apg = avg("ast") ?? 0;
  const bpg = avg("blk");
  const spg = avg("stl");
  const topg = avg("tov");
  const fg3a = avg("fg3a");
  const fg3m = avg("fg3m");
  const fga = avg("fga");
  const fgm = avg("fgm");
  const ftm = avg("ftm");
  const fta = avg("fta");
  const ft_pct = avg("ft_pct");
  const minutes = avg("minutes");
  const fs = (topg == null)
    ? null
    : ppg + 1.2 * rpg + 1.5 * apg + 3 * (spg ?? 0) + 3 * (bpg ?? 0) - 1 * topg;
  return {
    ppg: round1(ppg),
    rpg: round1(rpg),
    apg: round1(apg),
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
    bs: round1((bpg ?? 0) + (spg ?? 0)),
    fs: fs != null ? round1(fs) : null,
    fg3m: round1(fg3m),
    fg3a: round1(fg3a),
    fgm: round1(fgm),
    fga: round1(fga),
    ftm: round1(ftm),
    fta: round1(fta),
    ft_pct: round1(ft_pct),
    minutes: round1(minutes),
  };
}

/**
 * Compute regular-season H2H averages for a player vs the current
 * opponent. Filters a deeper gamelog (typically last 50 reg-season
 * games) to games against `opponentAbbr` by parsing each game's
 * `matchup` string, then averages over the subset.
 *
 * Returns { averages, n, opponent_abbr } or { averages: null, n: 0 }
 * when no H2H games exist. Callers must apply their own minimum-sample
 * gate (H2H_MIN_GAMES) — this helper doesn't enforce it.
 *
 * Designed for the regular-season blend path only; playoff_L5 has its
 * own current-series mechanism via computeWeightedL5.
 *
 * @param {Object} params
 * @param {Array<Object>} params.games   Reg-season gamelog (per-game shape
 *   from espnStats.getLastNGames). Each game must carry `matchup` for
 *   opponent identification + the underlying stat keys for rawAverages.
 * @param {string|null} params.ownAbbr   Player's team abbr (used to
 *   discriminate the opponent token from the player's own team in the
 *   matchup string).
 * @param {string|null} params.opponentAbbr  Tonight's opponent (matchup
 *   filter target). Null/empty → returns { averages: null, n: 0 }.
 */
export function computeH2HAverages({ games, ownAbbr, opponentAbbr }) {
  if (!Array.isArray(games) || games.length === 0) {
    return { averages: null, n: 0, opponent_abbr: null };
  }
  if (!opponentAbbr) return { averages: null, n: 0, opponent_abbr: null };
  const opp = String(opponentAbbr).toUpperCase();
  const h2hGames = games.filter((g) => parseOpponentAbbr(g?.matchup, ownAbbr) === opp);
  if (h2hGames.length === 0) {
    return { averages: null, n: 0, opponent_abbr: opp };
  }
  return {
    averages: rawAverages(h2hGames),
    n: h2hGames.length,
    opponent_abbr: opp,
  };
}
