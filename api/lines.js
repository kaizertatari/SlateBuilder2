// API endpoint to serve scraped PrizePicks lines.
// Query params:
//   ?player=LeBron%20James  — filter by player name (supports partial match)
//   ?stat=Points              — filter by stat type
//   ?opponent=LAL             — filter by opponent abbreviation
//   ?game=LAL@BOS             — filter by game key
//
// Usage: GET /api/lines

import { readLines } from "./lib/lines-store.js";

export const runtime = "nodejs";

export async function GET(req) {
  const url = new URL(req.url);
  const playerFilter = url.searchParams.get("player");
  const statFilter = url.searchParams.get("stat");
  const opponentFilter = url.searchParams.get("opponent");
  const gameFilter = url.searchParams.get("game");

  let lines;
  try {
    lines = await readLines();
  } catch (err) {
    return Response.json(
      { error: `Failed to read lines data: ${err.message}` },
      { status: 404 }
    );
  }

  // Filter by game if requested
  let result = { ...lines };

  if (gameFilter && lines.games) {
    const game = lines.games[gameFilter];
    result.games = game ? { [gameFilter]: game } : {};
    // Also filter by_player to only include players in this game
    if (game) {
      const gamePlayers = new Set(game.props.map((p) => p.player_key || p.player));
      const filteredByPlayer = {};
      for (const [player, props] of Object.entries(lines.by_player || {})) {
        if (gamePlayers.has(player)) {
          filteredByPlayer[player] = props.filter(
            (p) => p.opponent === gameFilter.split("@")[1] || p.opponent === gameFilter.split("@")[0]
          );
        }
      }
      result.by_player = filteredByPlayer;
    }
  }
  // Filter by player if requested
  else if (playerFilter && lines.by_player) {
    const normalizedFilter = playerFilter.toLowerCase();
    const filtered = {};
    for (const [player, props] of Object.entries(lines.by_player)) {
      if (player.toLowerCase().includes(normalizedFilter)) {
        filtered[player] = props;
      }
    }
    result.by_player = filtered;
    // Clear games since we're filtering by player
    result.games = {};
  }

  // Apply additional filters (stat, opponent) to by_player results
  if ((statFilter || opponentFilter) && result.by_player) {
    for (const player of Object.keys(result.by_player)) {
      let props = result.by_player[player];
      if (statFilter) {
        props = props.filter(
          (p) => p.stat_type?.toLowerCase() === statFilter.toLowerCase()
        );
      }
      if (opponentFilter) {
        props = props.filter(
          (p) => p.opponent?.toUpperCase() === opponentFilter.toUpperCase()
        );
      }
      if (props.length === 0) {
        delete result.by_player[player];
      } else {
        result.by_player[player] = props;
      }
    }
  }

  return Response.json({
    fetched_at: lines.fetched_at,
    filters: {
      player: playerFilter || null,
      stat: statFilter || null,
      opponent: opponentFilter || null,
      game: gameFilter || null,
    },
    data: {
      by_player: result.by_player || {},
      games: result.games || {},
    },
    total_props: Object.values(result.by_player || {}).reduce(
      (sum, props) => sum + props.length,
      0
    ),
    total_players: Object.keys(result.by_player || {}).length,
  });
}
