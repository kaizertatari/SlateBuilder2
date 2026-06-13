// POST /api/build-slate — the market-true slate builder.
//
// Prices the filtered PrizePicks board against the DK+FD no-vig consensus
// (data/odds.json) and assembles the single best +EV slate, or abstains.
//
// Why market-only (no engine ground-truth fan-out): the calibration audit
// showed the engine's box-score confidence is ~noise on standard lines, while
// the de-vigged sharp market is the actual signal — and it needs no per-player
// ESPN/bdl fetch, so this endpoint is fast (one odds.json read). Engine
// box-score gating can be layered later for props the market doesn't cover.
//
// Body: {
//   league?: "WNBA"|"NBA", statTypes?: string[], oddsTypes?: string[],
//   games?: string[], direction?: "OVER"|"UNDER",
//   targetMultiplier?: number (3), mode?: "power"|"flex" ("power"),
//   size?: number (3), maxPerGame?: number (1)
// }

import { rateLimit } from "./_lib/rate-limit.js";
import { runWithRequestContext } from "./_lib/request-context.js";
import { readLines } from "./_lib/lines-store.js";
import { STATS, mapPrizePicksStatType, SLATE_CALIBRATED_LEAGUES, SLATE_PENDING_LEAGUES } from "./_lib/prop-types.js";
import { ALL_ODDS_TYPES } from "./_lib/select-lines.js";
import { lookupMarket, setOdds } from "./_lib/odds.js";
import { readOdds } from "./_lib/odds-store.js";
import { buildSlate } from "./_lib/slate-builder.js";
import { logSlateLegs } from "./_lib/verdict-logger.js";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

/**
 * Price the board against the market and emit slate candidates. Pure — takes
 * the lines snapshot + reads the loaded odds via lookupMarket. Each candidate
 * carries market_fair_at_line (the bet side's de-vigged consensus prob at the
 * PrizePicks line) so buildSlate scores EV on market-true probability.
 *
 * @returns {{ candidates: Object[], matchedMarket: number, considered: number }}
 */
export function collectMarketCandidates(linesData, { league = null, allowedLeagues = null, allowedStats, oddsTypes = null, games = null, direction = null } = {}) {
  const statSet = allowedStats instanceof Set ? allowedStats : new Set(allowedStats || STATS);
  const oddsSet = Array.isArray(oddsTypes) && oddsTypes.length ? new Set(oddsTypes) : null;
  const gameSet = Array.isArray(games) && games.length ? new Set(games) : null;
  // Calibration allow-list: even with no explicit `league` filter, never price
  // a league that isn't slate-enabled (e.g. WC via the no-league API path).
  const leagueAllow = allowedLeagues instanceof Set ? allowedLeagues : null;

  const candidates = [];
  let considered = 0;
  let matchedMarket = 0;
  for (const [player, props] of Object.entries(linesData.by_player || {})) {
    for (const p of props) {
      const propLeague = p.league ?? "NBA";
      if (league && propLeague !== league) continue;
      if (leagueAllow && !leagueAllow.has(propLeague)) continue;
      const ot = (p.odds_type || "standard").toLowerCase();
      if (oddsSet && !oddsSet.has(ot)) continue;
      const stat = mapPrizePicksStatType(p.stat_type);
      if (!stat || !statSet.has(stat)) continue;
      const game = `${p.opponent || "?"}@${p.player_team || "?"}`;
      if (gameSet && !gameSet.has(game)) continue;
      considered++;
      const m = lookupMarket({ player, stat, line: p.line, league: p.league ?? league });
      if (!m) continue; // market-driven: only bet what the market prices
      matchedMarket++;
      const overP = m.fair_over; // consensus at this PrizePicks line
      // PrizePicks goblin (discount) & demon (boost) lines are OVER-only — you
      // can't bet their UNDER, and the payout boost/discount applies to the
      // OVER. Only standard lines support the market-favored side.
      let dir;
      if (ot === "goblin" || ot === "demon") {
        if (direction && direction !== "OVER") continue;
        dir = "OVER";
      } else {
        dir = direction || (overP >= 0.5 ? "OVER" : "UNDER");
      }
      const fairForSide = dir === "OVER" ? overP : 1 - overP;
      candidates.push({
        player,
        stat_type: stat,
        direction: dir,
        line: p.line,
        odds_type: ot,
        market_fair_at_line: Number(fairForSide.toFixed(4)),
        no_vig_prob: overP,
        market_line_delta: m.line_delta,
        books: m.books,
        game,
        // Join keys carried from the lines snapshot so the priced leg can be
        // logged as a gradeable verdict (verdict-logger.logSlateLegs): the
        // grader settles on game_start_time + espn_id (basketball) or
        // game_start_time + league=WC (soccer, FBref-by-name).
        league: propLeague,
        game_start_time: p.start_time ?? null,
        espn_id: p.espn_id ?? null,
        nba_id: p.nba_id ?? null,
      });
    }
  }
  return { candidates, matchedMarket, considered };
}

export async function POST(req) {
  const reqId = randomUUID().slice(0, 8);
  return runWithRequestContext({ reqId }, () => handlePost(req, reqId));
}

async function handlePost(req, reqId) {
  try {
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const limit = rateLimit(`build-slate:${ip}`, { windowMs: 60_000, max: 20 });
    if (!limit.ok) {
      return Response.json({ error: "Rate limit exceeded. Try again shortly." }, { status: 429, headers: { "Retry-After": String(Math.ceil((limit.retryAfterMs ?? 0) / 1000)) } });
    }

    const body = await req.json().catch(() => ({}));
    const { league: rawLeague, statTypes, oddsTypes: rawOdds, games, direction } = body;
    const targetMultiplier = Number(body.targetMultiplier) > 0 ? Number(body.targetMultiplier) : 3;
    const mode = body.mode === "flex" ? "flex" : "power";
    const size = Number.isInteger(body.size) ? body.size : 3;
    const maxPerGame = Number.isInteger(body.maxPerGame) ? body.maxPerGame : 1;

    if (direction && !["OVER", "UNDER"].includes(direction)) {
      return Response.json({ error: "direction must be 'OVER' or 'UNDER'" }, { status: 400 });
    }

    // Calibration gate. A league whose standard-line calibration isn't
    // validated yet (WC, mid-tournament) still gets PRICED + its legs LOGGED
    // for calibration telemetry — we just don't publish a slate, returning a
    // clear "pending" abstain instead of fake-+EV picks. (Pricing the pending
    // league here is exactly what accrues the data that lets us un-gate it.)
    const reqLeague = rawLeague ? String(rawLeague).toUpperCase() : null;
    const isPending = !!(reqLeague && SLATE_PENDING_LEAGUES[reqLeague]);
    const calibratedLeagues = new Set(SLATE_CALIBRATED_LEAGUES);
    const league = reqLeague && (calibratedLeagues.has(reqLeague) || isPending) ? reqLeague : null;
    // Pricing allow-list: a pending league prices only itself (telemetry);
    // otherwise restrict to the calibrated set so the no-league path can't
    // price an un-enabled league.
    const allowedLeagues = isPending ? new Set([reqLeague]) : calibratedLeagues;
    // Default to STANDARD lines only: their payout is exact (3-pick Power = 5×)
    // and they're where the ≥3× target lives. goblin/demon payout multipliers
    // are approximate (LINE_TYPE_FACTOR) and fabricate EV, so they're opt-in
    // until real PrizePicks per-pick multipliers are scraped (Stage 3).
    const oddsTypes = Array.isArray(rawOdds) ? rawOdds.map((t) => String(t).toLowerCase()).filter((t) => ALL_ODDS_TYPES.includes(t)) : ["standard"];
    const allowedStats = Array.isArray(statTypes) && statTypes.length ? new Set(statTypes) : new Set(STATS);

    let linesData;
    try { linesData = await readLines(); }
    catch { return Response.json({ error: "No lines data. Run: npm run refresh-prizepicks." }, { status: 404 }); }

    // Fresh odds from the blob (falls back to bundled data/odds.json), warmed
    // into the sync lookupMarket cache before pricing.
    const odds = await readOdds();
    setOdds(odds);
    const { candidates, matchedMarket, considered } = collectMarketCandidates(linesData, { league, allowedLeagues, allowedStats, oddsTypes, games, direction });

    // Telemetry: log every priced leg as a gradeable verdict (market path),
    // fire-and-forget. This is the ONLY place the de-vig prob the builder bets
    // on gets recorded — the daily grader settles these and calibrate-market
    // validates them. Covers pending leagues too (their slate stays withheld).
    logSlateLegs(candidates, { source: "build-slate" });

    if (isPending) {
      return Response.json({
        request_id: reqId,
        league: reqLeague,
        lines_fetched_at: linesData.fetched_at ?? null,
        odds_fetched_at: odds?.fetched_at ?? null,
        odds_sources: odds?.sources ?? null,
        abstained: true,
        calibration_pending: true,
        reason: `${reqLeague} slates are paused pending calibration (target ${SLATE_PENDING_LEAGUES[reqLeague]})`,
        slate: null,
        considered: candidates.length,
        best_rejected: null,
        params: null,
        props_examined: considered,
        props_priced: matchedMarket,
      }, { headers: { "X-Cache": "MISS" } });
    }

    const result = buildSlate(candidates, { targetMultiplier, mode, size, maxPerGame });

    return Response.json({
      request_id: reqId,
      league,
      lines_fetched_at: linesData.fetched_at ?? null,
      odds_fetched_at: odds?.fetched_at ?? null,
      odds_sources: odds?.sources ?? null,
      ...result, // { abstained, reason, slate, considered (priced pool), best_rejected, params }
      props_examined: considered, // board props matching the filters
      props_priced: matchedMarket, // of those, how many the market could price
    }, { headers: { "X-Cache": "MISS" } });
  } catch (error) {
    return Response.json({ request_id: reqId, error: error.message }, { status: 500 });
  }
}
