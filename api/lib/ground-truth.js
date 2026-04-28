// Pure composer. Takes raw outputs from nba-stats / espn helpers and produces
// the typed groundTruth payload + a list of missing required fields.
// No fetches here.

import { toEspnAbbr } from "./espn.js";

export function composeGroundTruth({
  player,
  propType,
  line,
  info,           // commonPlayerInfo (NBA stats)
  game,           // ESPN game (or null)
  daysOut = 0,   // 0 = today, 1+ = upcoming game found via lookahead
  seasonType,    // "Regular Season" | "Playoffs"
  seasonAvg,     // Regular-season averages, used as stable baseline
  l5,            // Last 5 in current seasonType
  splits,        // Home/Away splits (regular season)
  winProb,       // ESPN predictor result
  allInjuries,   // ESPN league-wide injury list
}) {
  const playerAbbr = info?.team_abbr ?? null;
  const playerEspnAbbr = toEspnAbbr(playerAbbr);

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

  const series = (seasonType === "Playoffs" && l5?.games && opponentSide)
    ? deriveSeries(l5.games, opponentSide.abbr)
    : null;

  const winPctForPlayer = winProb
    ? (homeAway === "home" ? winProb.home_win_pct : winProb.away_win_pct)
    : null;

  const groundTruth = {
    player,
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
      averages: pickAverages(seasonAvg),
    } : null,
    l5: l5 ? {
      type: l5.season_type,
      n: l5.n,
      games: l5.games,
      averages: enrichL5Averages(l5.averages),
    } : null,
    splits: splits ? {
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
    series,
  };

  const missing = [];
  if (!groundTruth.season)         missing.push("season_avg");
  if (!groundTruth.l5)             missing.push("l5_avg");
  if (!groundTruth.home_away)      missing.push("home_away");
  if (!groundTruth.opponent_team)  missing.push("opponent");
  if (needsWinProb(propType) && !groundTruth.win_prob) missing.push("win_prob");

  return { groundTruth, missing };
}

function enrichL5Averages(a) {
  if (!a) return a;
  const round1 = (n) => Number(n.toFixed(1));
  const ppg = a.ppg ?? 0;
  const rpg = a.rpg ?? 0;
  const apg = a.apg ?? 0;
  return {
    ...a,
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
  };
}

function pickAverages(s) {
  const ppg = s.ppg ?? 0;
  const rpg = s.rpg ?? 0;
  const apg = s.apg ?? 0;
  const round1 = (n) => Number(n.toFixed(1));
  return {
    games: s.games,
    minutes: s.minutes,
    ppg: s.ppg,
    rpg: s.rpg,
    apg: s.apg,
    pra: round1(ppg + rpg + apg),
    pr: round1(ppg + rpg),
    pa: round1(ppg + apg),
    fg_pct: s.fg_pct,
    fg3m: s.fg3m,
    fg3_pct: s.fg3_pct,
    ft_pct: s.ft_pct,
  };
}

function needsWinProb(propType) {
  // Rule 5f (blowout) caps OVERs; Rule 5c gates assist props.
  return /\bOVER\b/i.test(propType) || /assist/i.test(propType);
}

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[.'’\-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a, b) {
  return normalize(a) === normalize(b);
}

function deriveSeries(games, oppAbbr) {
  const upper = oppAbbr.toUpperCase();
  const vs = games.filter(
    (g) => g.matchup && g.matchup.toUpperCase().includes(upper)
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
  };
}
