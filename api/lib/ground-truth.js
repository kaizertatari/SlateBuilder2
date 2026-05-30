// Pure composer. Takes raw outputs from nba-stats / espn helpers and produces
// the typed groundTruth payload + a list of missing required fields.
// No fetches here.

import { toEspnAbbr } from "./espn.js";
import { normalizeName } from "./string-utils.js";
import { computeWeightedL5 } from "./weighted-l5.js";
import { ftFloorBaseline } from "./framework.js";
import { parseInjuryRegions } from "./injury-regions.js";
import { detectMechanisms } from "./mechanisms.js";

export function composeGroundTruth(params) {
  const {
    player,
    propType,
    line,
    info,
    game,
    daysOut = 0,
    seasonType,
    seasonAvg,
    l5,
    splits,
    winProb,
    allInjuries,
    opponentDefense,
    primaryDefender,
    defRankByAbbr,
    league = "NBA",
    // Move 3 — regular-season H2H baseline; null on playoff games or
    // when the gamelog fetch returned no current-opponent matches.
    h2h = null,
    // Stage 4 — longer gamelog window (each game carries date + pts + minutes)
    // for the variance block (real σ) and the rest/B2B block. Null when the
    // extended pull was unavailable; the blocks then degrade to null.
    extendedGames = null,
  } = params || {};

  const playerAbbr = info?.team_abbr ?? null;
  const playerEspnAbbr = toEspnAbbr(playerAbbr, league);

  const homeAway = (playerEspnAbbr && game)
    ? (game.home.abbr === playerEspnAbbr ? "home"
      : game.away.abbr === playerEspnAbbr ? "away"
      : null)
    : null;

  const playerSide   = homeAway === "home" ? game?.home : homeAway === "away" ? game?.away : null;
  const opponentSide = homeAway === "home" ? game?.away : homeAway === "away" ? game?.home : null;

  const sliceInjuries = (espnTeamId) => {
    if (!allInjuries || !espnTeamId) return [];
    const group = allInjuries.find((g) => g.team_id === String(espnTeamId));
    return group?.injuries ?? [];
  };

  const ownInjuries = sliceInjuries(playerSide?.team_id);
  const oppInjuries = sliceInjuries(opponentSide?.team_id);

  const isListedInjured = ownInjuries.some(
    (i) => i.player && namesMatch(i.player, player)
  );

  const series = buildSeriesState({ game, playerSide, opponentSide, l5, seasonType });
  // Decorate the series state with opponent_abbr so the weighted-L5
  // helper can identify which L5 games belong to the current playoff
  // series without needing to thread it through separately.
  const seriesWithOpponent = series && opponentSide
    ? { ...series, opponent_abbr: opponentSide.abbr }
    : series;

  const winPctForPlayer = winProb
    ? (homeAway === "home" ? winProb.home_win_pct : winProb.away_win_pct)
    : null;

  const groundTruth = {
    player: info?.full_name ?? player,
    league,
    prop_type: propType,
    line: Number(line),
    game: game ? {
      date: game.date,
      state: game.state,
      days_out: daysOut,
      home_team: game.home.name,
      away_team: game.away.name,
    } : null,
    player_team: playerSide ? {
      espn_id: playerSide.team_id,
      abbr: playerSide.abbr,
      name: playerSide.name,
    } : null,
    opponent_team: opponentSide ? {
      espn_id: opponentSide.team_id,
      abbr: opponentSide.abbr,
      name: opponentSide.name,
    } : null,
    home_away: homeAway,
    season: seasonAvg ? {
      label: seasonAvg.season,
      type: seasonAvg.season_type,
      is_prior_season: !!seasonAvg.is_prior_season,
      averages: pickAverages(seasonAvg),
    } : null,
    l5: l5 ? {
      type: l5.season_type,
      n: l5.n,
      is_prior_season: !!l5.is_prior_season,
      games: l5.games,
      averages: enrichL5Averages(l5.averages),
      // v3.5 weighted baseline (recency × opponent/series × outlier). Null
      // when l5.games is empty; otherwise consumed by Rule 5a/5f/S-tier
      // baseline checks and the LLM via groundTruth.l5.weighted.
      //
      // Outlier reference: in playoff mode with a full 5-game playoff L5
      // sample, derive the outlier reference from the player's playoff
      // points directly (raw mean of l5.games). Below n=5 we fall back to
      // seasonPpg — a 1-4 game playoff sample is too noisy to anchor the
      // dampener against. See weighted-l5.js docstring for the rationale.
      weighted: computeWeightedL5({
        games: l5.games ?? [],
        seasonPpg: seasonAvg?.ppg ?? null,
        playoffPpg: (l5.season_type === "Playoffs" && (l5.n ?? 0) >= 5)
          ? playoffL5MeanPts(l5.games)
          : null,
        ownAbbr: playerAbbr,
        series: seriesWithOpponent,
        defRankByAbbr: defRankByAbbr ?? null,
      }),
    } : null,
    splits: splits ? {
      is_prior_season: !!splits.is_prior_season,
      source_season: splits.source_season ?? null,
      home: splits.home ? pickAverages(splits.home) : null,
      road: splits.road ? pickAverages(splits.road) : null,
    } : null,
    win_prob: winProb ? {
      player_team_pct: winPctForPlayer,
      opponent_pct: homeAway === "home" ? winProb.away_win_pct : winProb.home_win_pct,
      source: winProb.source,
    } : null,
    injuries: {
      player_team: ownInjuries,
      opponent: oppInjuries,
    },
    player_recent: {
      is_listed_injured: isListedInjured,
    },
    opponent_defense: opponentDefense
      ? { ...opponentDefense, primary_defender: primaryDefender ?? null }
      : (primaryDefender ? { primary_defender: primaryDefender } : null),
    series: seriesWithOpponent,
    // Move 3 — regular-season H2H baseline derived from a 50-game season
    // gamelog filtered to the current opponent. computeOverBufferCheck
    // blends this with the regular-mode baseline at BLEND_H2H_RATIO when
    // h2h.n meets H2H_MIN_GAMES. Null on playoff games (current-series
    // blend owns that path) or when no H2H games exist in-season.
    h2h: h2h && h2h.n > 0 ? h2h : null,
    // v3.5 variance addendum (Rule 5a). σ over the available scoring sample
    // — null when fewer than 8 game-level points are available (per spec).
    // l5.games carries per-game pts; once we wire a longer season window
    // upstream this populates without a ground-truth.js code change.
    variance: computeVarianceBlock(extendedGames ?? l5?.games),
    // Stage 4 — rest / schedule density from gamelog dates vs the upcoming
    // game date (rule-rest fatigue suppressor). Null when dates are missing.
    rest: computeRestBlock(game, extendedGames ?? l5?.games),
    // v3.5 Rule 5i — per-position FT floor lookup. info.position is filled
    // by nba-stats getCommonPlayerInfo when available; falls back to F.
    derived: {
      ft_floor_baseline: ftFloorBaseline(league, positionFromInfo(info)),
    },
    // Engine inputs: parsed injury regions (Rule 6 body-region modulation)
    // and detected UNDER mechanisms (1/2/3). Per-player regions key on
    // injury entry.player; rule modules look up the active player's name
    // through info.full_name.
    injury_regions: parseInjuryRegions([...(ownInjuries || []), ...(oppInjuries || [])]),
  };

  // Aggregate per-section prior-season fallback markers into one top-level
  // list so the framework prompt has one obvious place to read. Caps the
  // verdict at A-tier max (see framework body — DATA-PROVENANCE GUARD).
  const dataWarnings = [];
  if (seasonAvg?.is_prior_season) dataWarnings.push("prior_season_season_avg");
  if (l5?.is_prior_season) dataWarnings.push("prior_season_l5");
  if (splits?.is_prior_season) dataWarnings.push("prior_season_splits");
  groundTruth.data_warnings = dataWarnings.length > 0 ? dataWarnings : null;

  // Detect UNDER mechanisms after the rest of groundTruth is assembled —
  // detectMechanisms reads injuries, injury_regions, opponent_defense,
  // and info.full_name from the composed object.
  groundTruth.info = { full_name: info?.full_name ?? player, ...info };
  groundTruth.mechanisms = detectMechanisms(groundTruth);
  // Lift mech1's parsed minutes restriction onto the top-level field that
  // Rule 5i's FT-floor mechanism-1 override reads.
  if (groundTruth.mechanisms?.mech1?.restriction != null) {
    groundTruth.minutes_restriction = groundTruth.mechanisms.mech1.restriction;
  }

  const missing = [];
  if (!groundTruth.season)         missing.push("season_avg");
  if (!groundTruth.l5)             missing.push("l5_avg");
  if (!groundTruth.home_away)      missing.push("home_away");
  if (!groundTruth.opponent_team)  missing.push("opponent");
  if (needsWinProb(propType) && !groundTruth.win_prob) missing.push("win_prob");

  return { groundTruth, missing };
}

// Raw mean of pts across L5 games. Used as the playoff outlier reference
// when l5.season_type === "Playoffs" and n >= 5 — so the dampener judges
// playoff games against the player's playoff norm rather than their
// (often lower) regular-season norm. Returns null when no games carry a
// pts value, in which case the caller falls back to seasonPpg.
function playoffL5MeanPts(games) {
  if (!Array.isArray(games) || games.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const g of games) {
    const p = g?.pts;
    if (p == null) continue;
    sum += p;
    n++;
  }
  return n === 0 ? null : sum / n;
}

// FanDuel-style fantasy score per the user direction. Returns null when
// any of the four required inputs is missing — the framework should
// rather SKIP a Fantasy Score prop than evaluate it against a baseline
// inflated by a missing turnover penalty.
function fantasyScoreFanDuel({ ppg, rpg, apg, spg, bpg, topg }) {
  if (ppg == null || rpg == null || apg == null || topg == null) return null;
  return ppg + 1.2 * rpg + 1.5 * apg + 3 * (spg ?? 0) + 3 * (bpg ?? 0) - 1 * topg;
}

function enrichL5Averages(a) {
  if (!a) return a;
  const round1 = (n) => Number(n.toFixed(1));
  const ppg = a.ppg ?? 0;
  const rpg = a.rpg ?? 0;
  const apg = a.apg ?? 0;
  const spg = a.spg ?? null;
  const bpg = a.bpg ?? null;
  const topg = a.topg ?? null;
  const fs = fantasyScoreFanDuel({ ppg, rpg, apg, spg, bpg, topg });
  return {
    ...a,
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
    // Blocks + Steals as a single average (Blks+Stls prop). When either
    // is missing, default to 0 — the sum stays well-defined; the framework
    // doesn't get a misleading null.
    bs: round1((bpg ?? 0) + (spg ?? 0)),
    // Fantasy Score (FanDuel formula). Null when inputs are missing so
    // Rule 5a can SKIP cleanly instead of evaluating against a bad baseline.
    fs: fs != null ? round1(fs) : null,
  };
}

function pickAverages(s) {
  const ppg = s.ppg ?? 0;
  const rpg = s.rpg ?? 0;
  const apg = s.apg ?? 0;
  const spg = s.spg ?? null;
  const bpg = s.bpg ?? null;
  const topg = s.topg ?? null;
  const round1 = (n) => Number(n.toFixed(1));
  const fs = fantasyScoreFanDuel({ ppg, rpg, apg, spg, bpg, topg });
  return {
    games: s.games,
    minutes: s.minutes,
    ppg: s.ppg,
    rpg: s.rpg,
    apg: s.apg,
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    ra: round1(rpg + apg),
    fgm: s.fgm,
    fga: s.fga,
    fg_pct: s.fg_pct,
    fg3m: s.fg3m,
    fg3a: s.fg3a,
    fg3_pct: s.fg3_pct,
    ftm: s.ftm,
    fta: s.fta,
    ft_pct: s.ft_pct,
    // New prop baselines.
    bpg: s.bpg,
    spg: s.spg,
    topg: s.topg,
    bs: round1((bpg ?? 0) + (spg ?? 0)),
    fs: fs != null ? round1(fs) : null,
  };
}

// Normalize the stats.nba.com position string to the {G,F,C} bucket used
// by FRAMEWORK_SCALING.ft_floor_by_position. ESPN doesn't expose position
// reliably, and players.json doesn't carry it — so we may end up with
// null/empty inputs here. Falling back to null lets the framework default
// to F (spec §6 Rule 5i: "fall back to F when position unknown").
function positionFromInfo(info) {
  const raw = info?.position;
  if (!raw || typeof raw !== "string") return null;
  // Stats edge returns e.g. "Center", "Guard-Forward", "Forward-Center".
  // Read the LAST token so hybrid roles bucket toward their bigger side
  // (e.g., G-F → F, F-C → C).
  const upper = raw.toUpperCase();
  if (/CENTER/.test(upper) || /\bC\b/.test(upper)) return "C";
  if (/FORWARD/.test(upper) || /\bF\b/.test(upper)) return "F";
  if (/GUARD/.test(upper) || /\bG\b/.test(upper)) return "G";
  return null;
}

// v3.5 Rule 5a addendum input. σ requires ≥8 game samples by spec; with
// only L5 we punt to null. Once a longer per-game series is plumbed in,
// drop it into l5.games (or a sibling) and this returns the live σ
// without other code changes.
function computeVarianceBlock(games) {
  // Accepts a games array (Stage 4 extended window) or, defensively, an l5-ish
  // object. σ needs ≥8 game-level points; with fewer we punt to null (the
  // projection model then falls back to the slope-implied per-league σ).
  const arr = Array.isArray(games) ? games : (games?.games ?? []);
  const pts = arr.map((g) => g?.pts).filter((p) => p != null);
  if (pts.length < 8) return { ppg_stddev: null, n: pts.length };
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const variance = pts.reduce((a, p) => a + (p - mean) ** 2, 0) / pts.length;
  return { ppg_stddev: Number(Math.sqrt(variance).toFixed(2)), n: pts.length };
}

// Rest / schedule-density from gamelog dates relative to the upcoming game.
// rest_days = days since the most recent played game; back_to_back when the
// player played the day before; three_in_four when ≥2 prior games fall within
// the 3 days before tip (2 prior + tonight = 3 games in 4 nights).
function computeRestBlock(game, gamelogGames) {
  const gd = game?.date ? new Date(game.date) : null;
  const arr = Array.isArray(gamelogGames) ? gamelogGames : [];
  if (!gd || Number.isNaN(gd.getTime()) || !arr.length) return null;
  const DAY = 86400000;
  const priorDays = arr
    .map((g) => (g?.date ? new Date(g.date) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .map((d) => (gd.getTime() - d.getTime()) / DAY)
    .filter((diff) => diff > 0.25) // strictly before tip (guards same-day rows)
    .sort((a, b) => a - b);
  if (!priorDays.length) return null;
  return {
    rest_days: Math.round(priorDays[0]),
    back_to_back: priorDays[0] <= 1.25,
    three_in_four: priorDays.filter((diff) => diff <= 3).length >= 2,
  };
}

function needsWinProb(propType) {
  // Rule 5f (blowout) caps OVERs; Rule 5c gates assist props.
  return /\bOVER\b/i.test(propType) || /assist/i.test(propType);
}

function namesMatch(a, b) {
  return normalizeName(a) === normalizeName(b);
}

function leadingTeamAbbr({ playerWins, opponentWins, playerSide, opponentSide }) {
  if (playerWins > opponentWins) return playerSide?.abbr ?? null;
  if (opponentWins > playerWins) return opponentSide?.abbr ?? null;
  return null; // tied — no leader
}

function buildSeriesState({ game, playerSide, opponentSide, l5, seasonType }) {
  // Authoritative path: ESPN attaches series state to playoff scoreboard
  // events. Match by ESPN team_id (no abbreviation aliasing). Pre-formatted
  // summary string ("BOS leads series 3-1") comes straight from ESPN.
  const espn = game?.series;
  if (espn && espn.type === "playoff" && playerSide && opponentSide) {
    const playerComp = espn.competitors?.find(
      (c) => String(c.id) === String(playerSide.team_id)
    );
    const oppComp = espn.competitors?.find(
      (c) => String(c.id) === String(opponentSide.team_id)
    );
    const playerWins = playerComp?.wins ?? 0;
    const opponentWins = oppComp?.wins ?? 0;
    const gamesPlayed = playerWins + opponentWins;
    return {
      games_played: gamesPlayed,
      player_team_wins: playerWins,
      opponent_wins: opponentWins,
      next_game_number: gamesPlayed + 1,
      series_record: `${playerWins}-${opponentWins}`,
      series_summary: espn.summary ?? null,
      leading_team_abbr: leadingTeamAbbr({ playerWins, opponentWins, playerSide, opponentSide }),
      round: game.round ?? null,
      source: "espn_event",
    };
  }

  // Fallback: ESPN didn't tag the event with series data but we forced
  // seasonType=Playoffs upstream. Reconstruct from gamelog (less reliable
  // — capped at L5, anchored substring match).
  if (seasonType === "Playoffs" && l5?.games?.length && opponentSide) {
    const derived = deriveSeriesFromL5(l5.games, opponentSide.abbr);
    return {
      ...derived,
      leading_team_abbr: leadingTeamAbbr({
        playerWins: derived.player_team_wins,
        opponentWins: derived.opponent_wins,
        playerSide,
        opponentSide,
      }),
      source: "l5_fallback",
    };
  }

  return null;
}

// NBA team abbreviations are unique 3-letter strings, so we anchor the match
// to a word boundary on each side of the opponent abbr to avoid the rare
// risk of a substring overlap (e.g. an unrelated 3-letter sequence inside
// a future schema change).
function deriveSeriesFromL5(games, oppAbbr) {
  const upper = oppAbbr.toUpperCase();
  const re = new RegExp(`(^|[^A-Z])${upper}([^A-Z]|$)`);
  const vs = games.filter(
    (g) => g.matchup && re.test(g.matchup.toUpperCase())
  );
  let pw = 0, ow = 0;
  for (const g of vs) {
    if (g.result === "W") pw++;
    else if (g.result === "L") ow++;
  }
  return {
    games_played: vs.length,
    player_team_wins: pw,
    opponent_wins: ow,
    next_game_number: vs.length + 1,
    series_record: `${pw}-${ow}`,
    series_summary: null,
    round: null,
  };
}
