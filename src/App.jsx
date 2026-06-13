import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import playersData from "../data/players.json";
import { STATS, STATS_BY_LEAGUE, mapPrizePicksStatType } from "../api/_lib/prop-types.js";
import { selectLinesForStat } from "../api/_lib/select-lines.js";
import { readNewestCached, writeCached, clearStaleForPlayer, buildKey } from "./lib/result-cache.js";

const TIER_ORDER = { S: 0, A: 1, B: 2, SKIP: 3 };

// Tier visual style is derived in one place so the table cell, justification
// block, and tier_counts row stay in lockstep when colors are tweaked.
const TIER_STYLE = {
  S: { color: "#FFD700", bg: "#2a2200", border: "#FFD70044" },
  A: { color: "#00FF88", bg: "#002218", border: "#00FF8844" },
  B: { color: "#4488FF", bg: "#001a33", border: "#4488FF44" },
};

const ODDS_TYPES = ["goblin", "standard", "demon"];
const DIRECTIONS = ["OVER", "UNDER"];

const selectStyle = {
  background: "#0a1420",
  color: "#c8d8e8",
  border: "1px solid #1e3040",
  padding: "10px 12px",
  fontFamily: "'Courier New', monospace",
  fontSize: 12,
  flex: 1,
  minWidth: 180,
  appearance: "none",
  cursor: "pointer",
  outline: "none",
};

// Split the player roster by league once at module load. The toggle filters
// to the active league's list; the autocomplete never crosses leagues, which
// avoids name-collision edge cases between an NBA and WNBA player who
// happen to share a name.
const PLAYERS_BY_LEAGUE = (() => {
  const grouped = { NBA: [], WNBA: [] };
  for (const [name, info] of Object.entries(playersData)) {
    const league = info?.league ?? "NBA";
    if (!grouped[league]) grouped[league] = [];
    grouped[league].push(name);
  }
  for (const list of Object.values(grouped)) list.sort();
  return grouped;
})();

const LEAGUES = ["NBA", "WNBA", "WC"];

const REFRESH_STATUS_COLORS = {
  success: { fg: "#00FF88", bg: "#002218", border: "#00FF8844" },
  "no-data": { fg: "#FFC107", bg: "#221a00", border: "#FFC10744" },
  error: { fg: "#FF6666", bg: "#220000", border: "#FF666644" },
};

function formatLinesFetchedAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(d).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

export default function App() {
  // Default to WNBA: it's slate-calibrated and reliably has a multi-game board,
  // so the builder produces a slate out of the box. (NBA is calibrated too but
  // off-season/Finals nights often have a single game → diversification can't
  // fill a slate; WC is paused pending calibration — SLATE_PENDING_LEAGUES.)
  const [league, setLeague] = useState("WNBA");
  // Multi-player selection. Order preserved so the chip row is stable;
  // togglePlayer is the single mutation site so duplicates can't accrete.
  const [players, setPlayers] = useState([]);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHighlight, setPlayerHighlight] = useState(0);
  const [selectedStats, setSelectedStats] = useState([...STATS_BY_LEAGUE.WNBA]);
  // Direction filter — pre-analysis. Both selected = backend fans out to
  // OVER + UNDER (omits the direction field in the body); single selected
  // pins the request to one side. Empty = blocked at submit time.
  const [selectedDirections, setSelectedDirections] = useState([...DIRECTIONS]);
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // Slate metadata fetched from /api/lines on mount + league change. Drives
  // the Game filter dropdown and constrains the player picker to the roster
  // of players who actually have lines published in the selected games.
  const [linesData, setLinesData] = useState(null);
  // Canonical game keys (alpha-sorted abbr pair, e.g. "BOS|LAL"). Empty
  // selection = no filter (all players visible).
  const [selectedGames, setSelectedGames] = useState([]);
  const [gamesOpen, setGamesOpen] = useState(false);
  // Date filter — narrows the Games list (and through it the player picker
  // and slate builder) to slates on the chosen local dates. Keys are local
  // YYYY-MM-DD strings derived from prop start_time; useful because the
  // snapshot can span several days (WC group stage / NBA Finals post
  // early). Empty selection = no filter.
  const [selectedDates, setSelectedDates] = useState([]);
  const [datesOpen, setDatesOpen] = useState(false);
  // Odds-type filter for the displayed top picks. Default: all three.
  const [selectedOdds, setSelectedOdds] = useState([...ODDS_TYPES]);
  const [oddsOpen, setOddsOpen] = useState(false);

  // Refs for the four open dropdowns. Wired up to a single document-level
  // mousedown listener below so clicking outside any open dropdown closes
  // it — without this, the only way to dismiss Games/Odds/Stats was to
  // click the chevron again.
  const playerRef = useRef(null);
  const gamesRef = useRef(null);
  const datesRef = useRef(null);
  const oddsRef = useRef(null);
  const directionsRef = useRef(null);
  const statsRef = useRef(null);
  // {completed, total} during a multi-player run so the user can see
  // progress as each per-player request lands. null when idle.
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // "HIT" when served from sessionStorage or when server returned X-Cache:HIT.
  // "MISS" on a fresh network analysis. null on first render / between calls.
  // For multi-player runs this reflects the worst case — if any player
  // missed, we report MISS.
  const [cacheStatus, setCacheStatus] = useState(null);
  // Slate freshness — ISO string from /api/lines, /api/refresh-lines, or
  // the first analyze response (whichever populates last wins).
  const [linesFetchedAt, setLinesFetchedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // { kind: "success" | "no-data" | "error", message: string } | null
  const [refreshStatus, setRefreshStatus] = useState(null);

  // ── Slate builder state ──
  // targetMultiplier = minimum win multiplier the slate must reach (the
  // dashboard "what to aim for" knob). mode = Power (all hit) / Flex (partial).
  const [targetMultiplier, setTargetMultiplier] = useState(3);
  const [slateMode, setSlateMode] = useState("power");
  const [slate, setSlate] = useState(null); // /api/build-slate response
  const [buildingSlate, setBuildingSlate] = useState(false);
  const [slateError, setSlateError] = useState(null);

  // League-scoped stat catalog: basketball leagues share one list; WC shows
  // only the soccer stats. selectedStats resets on league change.
  const leagueStats = STATS_BY_LEAGUE[league] ?? STATS;
  const allStatsSelected = selectedStats.length === leagueStats.length;
  const allOddsSelected = selectedOdds.length === ODDS_TYPES.length;
  const allDirectionsSelected = selectedDirections.length === DIRECTIONS.length;

  // Close any open dropdown when the user clicks outside its container.
  // The `playerOpen` state is also closed by the input's onBlur, which is
  // kept as a backup for keyboard-driven dismissal (Tab/Esc); the click-
  // outside handler is what catches mouse dismissal on the other three.
  useEffect(() => {
    function handleMouseDown(e) {
      const tuples = [
        [playerOpen, playerRef, setPlayerOpen],
        [gamesOpen, gamesRef, setGamesOpen],
        [datesOpen, datesRef, setDatesOpen],
        [oddsOpen, oddsRef, setOddsOpen],
        [directionsOpen, directionsRef, setDirectionsOpen],
        [statsOpen, statsRef, setStatsOpen],
      ];
      for (const [isOpen, ref, close] of tuples) {
        if (isOpen && ref.current && !ref.current.contains(e.target)) {
          close(false);
        }
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [playerOpen, gamesOpen, datesOpen, oddsOpen, directionsOpen, statsOpen]);

  // Fetch the PrizePicks slate so we can populate the Game filter and
  // constrain the player picker to players who actually have lines tonight.
  // The endpoint reads from blob (or bundled fallback) — cheap. Extracted so
  // the REFRESH LINES handler can re-pull it; otherwise the games/players list
  // stays stale until a full page reload.
  const loadLines = useCallback(async () => {
    try {
      const r = await fetch("/api/lines");
      const d = r.ok ? await r.json() : null;
      setLinesData(d || null);
      if (d?.fetched_at) setLinesFetchedAt(d.fetched_at);
    } catch {
      setLinesData(null);
    }
  }, []);

  useEffect(() => {
    // loadLines() only setStates after an awaited fetch (not synchronously),
    // so the set-state-in-effect rule is a false positive here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLines();
  }, [loadLines]);

  // Derive the unique games list for the active league. The scraper writes
  // two game entries per matchup (one per team perspective: "BOS@LAL" and
  // "LAL@BOS"). Collapse to one canonical entry per pair using an alpha-sort
  // key, then preserve the raw gameKeys + player set so filters can fan out.
  const availableGames = useMemo(() => {
    const games = linesData?.data?.games || {};
    const byCanonical = new Map();
    for (const [gameKey, info] of Object.entries(games)) {
      if (!info || info.league !== league) continue;
      const cleanKey = gameKey.replace(/^(WNBA|WC):/, "");
      const parts = cleanKey.split("@");
      if (parts.length !== 2) continue;
      const [a, b] = parts;
      const canonical = [a, b].sort().join("|");
      let entry = byCanonical.get(canonical);
      if (!entry) {
        entry = { canonical, label: `${a} @ ${b}`, gameKeys: [], players: new Set(), start_ms: null };
        byCanonical.set(canonical, entry);
      }
      entry.gameKeys.push(gameKey);
      for (const prop of info.props || []) {
        const name = prop.player_key || prop.player;
        if (name) entry.players.add(name);
        // Earliest prop start_time = the game's kickoff/tipoff. Drives the
        // Date filter; stays null when the scrape carried no start_time.
        const ms = prop.start_time ? Date.parse(prop.start_time) : NaN;
        if (Number.isFinite(ms) && (entry.start_ms == null || ms < entry.start_ms)) {
          entry.start_ms = ms;
        }
      }
    }
    // Resolve each game to its LOCAL kickoff date (viewer's timezone) —
    // key for filtering, label for display.
    const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const out = [...byCanonical.values()];
    for (const g of out) {
      if (g.start_ms != null) {
        const d = new Date(g.start_ms);
        const m = d.getMonth() + 1;
        g.date = `${d.getFullYear()}-${String(m).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        g.dateLabel = `${WEEKDAYS[d.getDay()]} ${m}/${d.getDate()}`;
      } else {
        g.date = null;
        g.dateLabel = null;
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [linesData, league]);

  // Per-league badge counts for the League toggle. NBA/WNBA come from the
  // players.json roster; WC players aren't in players.json (the roster IS the
  // lines snapshot), so count unique slate names — same source the picker uses.
  const leagueCounts = useMemo(() => {
    const counts = {};
    for (const l of LEAGUES) counts[l] = PLAYERS_BY_LEAGUE[l]?.length ?? 0;
    const games = linesData?.data?.games || {};
    const wcPlayers = new Set();
    for (const info of Object.values(games)) {
      if (info?.league !== "WC") continue;
      for (const prop of info.props || []) {
        const name = prop.player_key || prop.player;
        if (name) wcPlayers.add(name);
      }
    }
    counts.WC = wcPlayers.size;
    return counts;
  }, [linesData]);

  // Distinct local dates across the league's games, chronological, each with
  // its game count. Drives the Date dropdown.
  const availableDates = useMemo(() => {
    const byDate = new Map();
    for (const g of availableGames) {
      if (!g.date) continue;
      const cur = byDate.get(g.date);
      if (cur) cur.count += 1;
      else byDate.set(g.date, { key: g.date, label: g.dateLabel, count: 1 });
    }
    return [...byDate.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [availableGames]);

  // Games surviving the Date filter — the pool every downstream consumer
  // (Games dropdown, player picker, slate-builder fan-out) draws from.
  // Dateless games (no start_time in the scrape) only show unfiltered.
  const dateFilteredGames = useMemo(() => {
    if (selectedDates.length === 0) return availableGames;
    return availableGames.filter((g) => g.date && selectedDates.includes(g.date));
  }, [availableGames, selectedDates]);

  // Players visible in the picker — narrowed to selected games when at
  // least one game is picked. Empty selection means "no game filter".
  const leaguePlayers = useMemo(() => {
    // WC (soccer) players aren't in players.json — the roster IS the lines
    // snapshot, so derive the picker list from the slate's games.
    const all = league === "WC"
      ? [...new Set(dateFilteredGames.flatMap((g) => [...g.players]))].sort()
      : PLAYERS_BY_LEAGUE[league] ?? [];
    // With dates narrowed but no explicit game picks, the date pool IS the
    // game filter; explicit game picks narrow further within it.
    if (selectedGames.length === 0 && selectedDates.length === 0) return all;
    const allowed = new Set();
    for (const g of dateFilteredGames) {
      if (selectedGames.length === 0 || selectedGames.includes(g.canonical)) {
        for (const p of g.players) allowed.add(p);
      }
    }
    return all.filter((name) => allowed.has(name));
  }, [league, selectedGames, selectedDates, dateFilteredGames]);

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    // Show every league+game-filtered player. Each row carries its own
    // checkbox so selected players stay in the list (parity with the
    // Stats/Odds multi-selects).
    if (!q) return leaguePlayers;
    return leaguePlayers.filter((p) => p.toLowerCase().includes(q));
  }, [playerQuery, leaguePlayers]);

  // Live preview of how much work this Analyze click will dispatch.
  // Counts are derived from the in-memory PrizePicks slate by running the
  // same selectLinesForStat used server-side, so numbers stay accurate
  // even when filters narrow non-trivially (e.g. demon-only on a stat
  // bucket without a demon → 0 lines). Stats/odds/players counts are
  // simple lengths. propBuckets = distinct (player, stat) pairs that
  // would build a task. linesToAnalyze = engine task count (props × the
  // selected odds types after the per-bucket dedupe).
  const filterStats = useMemo(() => {
    const byPlayer = linesData?.data?.by_player || {};
    const statSet = new Set(selectedStats);
    let propBuckets = 0;
    let linesToAnalyze = 0;
    for (const playerName of players) {
      const rawProps = byPlayer[playerName] || [];
      // Group props for this player by canonical stat name. Cross-league
      // entries are filtered by the backend; we don't bother here because
      // the picker already scopes to one league.
      const buckets = new Map();
      for (const prop of rawProps) {
        const stat = mapPrizePicksStatType(prop.stat_type);
        if (!stat || !statSet.has(stat)) continue;
        let arr = buckets.get(stat);
        if (!arr) {
          arr = [];
          buckets.set(stat, arr);
        }
        arr.push(prop);
      }
      for (const [, propsForStat] of buckets) {
        // Each selected direction may pick a different subset of lines
        // from the same bucket (UNDER strips demon, OVER doesn't, etc.).
        // Count a bucket once if ANY direction yields lines; sum lines
        // across all selected directions for the engine task estimate.
        let bucketCounted = false;
        for (const dir of selectedDirections) {
          const chosen = selectLinesForStat(propsForStat, dir, selectedOdds);
          if (chosen.length === 0) continue;
          if (!bucketCounted) {
            propBuckets += 1;
            bucketCounted = true;
          }
          linesToAnalyze += chosen.length;
        }
      }
    }
    return {
      players: players.length,
      games: selectedGames.length,
      gamesTotal: dateFilteredGames.length,
      dates: selectedDates.length,
      datesTotal: availableDates.length,
      stats: selectedStats.length,
      statsTotal: leagueStats.length,
      odds: selectedOdds.length,
      oddsTotal: ODDS_TYPES.length,
      directions: selectedDirections.length,
      directionsTotal: DIRECTIONS.length,
      propBuckets,
      linesToAnalyze,
    };
  }, [linesData, players, selectedStats, selectedOdds, selectedDirections, selectedGames, selectedDates, dateFilteredGames, availableDates, leagueStats]);

  // top_10 narrowed by the Odds filter. Display-only — tier_counts above
  // still reflects the full analyzed pool so the operator can see the
  // distribution they're filtering against.
  const displayedTop10 = useMemo(() => {
    const list = results?.top_10 ?? [];
    if (list.length === 0) return [];
    if (allOddsSelected) return list;
    const allowed = new Set(selectedOdds);
    return list.filter((r) => allowed.has(r.odds_type));
  }, [results, selectedOdds, allOddsSelected]);

  const handleLeagueChange = (next) => {
    if (next === league) return;
    setLeague(next);
    setSelectedStats([...(STATS_BY_LEAGUE[next] ?? STATS)]);
    setPlayers([]);
    setPlayerQuery("");
    setPlayerOpen(false);
    setPlayerHighlight(0);
    setSelectedGames([]);
    setSelectedDates([]);
    setResults(null);
    setError(null);
    setCacheStatus(null);
    setSlate(null);
    setSlateError(null);
  };

  const toggleGame = (canonical) => {
    setSelectedGames((cur) =>
      cur.includes(canonical) ? cur.filter((g) => g !== canonical) : [...cur, canonical]
    );
    // Clear the chip row when narrowing — the user is reshuffling the
    // available pool, and stale selections from games they're now hiding
    // would silently survive into the request body.
    setPlayers((cur) => {
      if (cur.length === 0) return cur;
      const next = canonical;
      const stillSelected = selectedGames.includes(next)
        ? selectedGames.filter((g) => g !== next)
        : [...selectedGames, next];
      if (stillSelected.length === 0) return cur;
      const allowed = new Set();
      for (const g of dateFilteredGames) {
        if (stillSelected.includes(g.canonical)) {
          for (const p of g.players) allowed.add(p);
        }
      }
      return cur.filter((p) => allowed.has(p));
    });
  };

  // Date filter toggle. Narrowing dates also prunes game selections (and
  // their player chips) that the new date set hides — same reasoning as
  // toggleGame: stale selections must not silently survive into the
  // request body.
  const toggleDate = (key) => {
    const next = selectedDates.includes(key)
      ? selectedDates.filter((d) => d !== key)
      : [...selectedDates, key];
    setSelectedDates(next);
    const visible = next.length === 0
      ? availableGames
      : availableGames.filter((g) => g.date && next.includes(g.date));
    const visibleKeys = new Set(visible.map((g) => g.canonical));
    setSelectedGames((cur) => cur.filter((c) => visibleKeys.has(c)));
    setPlayers((cur) => {
      if (cur.length === 0 || next.length === 0) return cur;
      const allowed = new Set();
      for (const g of visible) for (const p of g.players) allowed.add(p);
      return cur.filter((p) => allowed.has(p));
    });
  };

  const toggleOdds = (odds) => {
    setSelectedOdds((cur) =>
      cur.includes(odds) ? cur.filter((o) => o !== odds) : [...cur, odds]
    );
  };

  const toggleAllOdds = () => {
    setSelectedOdds(allOddsSelected ? [] : [...ODDS_TYPES]);
  };

  const toggleDirection = (dir) => {
    setSelectedDirections((cur) =>
      cur.includes(dir) ? cur.filter((d) => d !== dir) : [...cur, dir]
    );
  };

  const toggleAllDirections = () => {
    setSelectedDirections(allDirectionsSelected ? [] : [...DIRECTIONS]);
  };

  const removePlayer = (name) => {
    setPlayers((cur) => cur.filter((p) => p !== name));
  };

  // Multi-select toggle for the player dropdown rows. Keeps the dropdown
  // open and the search query intact so the user can keep
  // checking/unchecking without losing their place — matches Stats/Odds
  // behavior.
  const togglePlayer = (name) => {
    setPlayers((cur) =>
      cur.includes(name) ? cur.filter((p) => p !== name) : [...cur, name]
    );
  };

  // True when every currently-visible player (league + game filtered) is
  // already in the chip list. Drives the SELECT ALL / DESELECT ALL toggle
  // copy and checkbox state.
  const allLeaguePlayersSelected =
    leaguePlayers.length > 0 && leaguePlayers.every((p) => players.includes(p));

  const toggleAllPlayers = () => {
    if (allLeaguePlayersSelected) {
      // Deselect every chip that belongs to the current league+game pool.
      // Chips from other leagues/games (rare — only possible if the user
      // changes filters after picking) are preserved.
      const pool = new Set(leaguePlayers);
      setPlayers((cur) => cur.filter((p) => !pool.has(p)));
    } else {
      setPlayers((cur) => Array.from(new Set([...cur, ...leaguePlayers])));
    }
    setPlayerQuery("");
    setPlayerHighlight(0);
  };

  const handlePlayerKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setPlayerOpen(true);
      setPlayerHighlight((h) => Math.min(h + 1, filteredPlayers.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setPlayerHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (playerOpen && filteredPlayers[playerHighlight]) {
        e.preventDefault();
        // Toggle to match the checkbox click behavior — Enter on an
        // already-selected highlighted row unchecks it.
        togglePlayer(filteredPlayers[playerHighlight]);
      }
    } else if (e.key === "Escape") {
      setPlayerOpen(false);
      setPlayerQuery("");
    } else if (e.key === "Backspace" && playerQuery === "" && players.length > 0) {
      // Backspace on empty input removes the most recently added chip.
      e.preventDefault();
      removePlayer(players[players.length - 1]);
    }
  };

  const toggleStat = (stat) => {
    setSelectedStats((cur) =>
      cur.includes(stat) ? cur.filter((s) => s !== stat) : [...cur, stat]
    );
  };

  const toggleAllStats = () => {
    setSelectedStats(allStatsSelected ? [] : [...leagueStats]);
  };

  // Fetch (or load from cache) a single player's analyze-all response.
  // Returns { data, cacheStatus } or throws on hard error.
  //
  // Direction handling: backend treats the `direction` field as optional
  // and fans out to OVER+UNDER when absent. When the user has both
  // directions selected we omit the field; when exactly one is selected
  // we pin the request. The cache key encodes the resolved direction
  // (single value or "BOTH" via normalizeDirection) so cache hits stay
  // scoped to the filter that produced them.
  const analyzeOne = useCallback(async (playerName) => {
    const directionParam = selectedDirections.length === 1 ? selectedDirections[0] : undefined;
    const cached = readNewestCached(playerName, selectedStats, directionParam, selectedOdds);
    if (cached) {
      return { data: cached.data, cacheStatus: "HIT" };
    }
    const body = {
      player: playerName,
      statTypes: selectedStats,
      league,
      oddsTypes: selectedOdds,
    };
    if (directionParam) body.direction = directionParam;

    const response = await fetch("/api/analyze-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (data.error) throw new Error(`${playerName}: ${data.error}`);
    if (!response.ok) throw new Error(data.error || "Request failed");

    if (data.lines_fetched_at) {
      const key = buildKey(playerName, data.lines_fetched_at, selectedStats, directionParam, selectedOdds);
      writeCached(key, data);
      clearStaleForPlayer(key, playerName);
    }
    return { data, cacheStatus: response.headers.get("X-Cache") || "MISS" };
  }, [selectedStats, selectedOdds, selectedDirections, league]);

  const analyzeAll = useCallback(async () => {
    if (players.length === 0) {
      setError("Select at least one player.");
      return;
    }
    if (selectedStats.length === 0) {
      setError("Select at least one stat type.");
      return;
    }
    if (selectedOdds.length === 0) {
      setError("Select at least one odds type (Goblin/Standard/Demon).");
      return;
    }
    if (selectedDirections.length === 0) {
      setError("Select at least one direction (OVER/UNDER).");
      return;
    }

    setError(null);
    setResults(null);
    setCacheStatus(null);
    setProgress({ completed: 0, total: players.length });
    setAnalyzing(true);

    try {
      // Fan out per-player in parallel. Each request is one engine batch
      // server-side; merging happens client-side so the existing /api/
      // analyze-all signature stays unchanged.
      const settled = await Promise.all(
        players.map((p) =>
          analyzeOne(p)
            .then((r) => {
              setProgress((cur) => cur && { ...cur, completed: cur.completed + 1 });
              return { player: p, ok: true, ...r };
            })
            .catch((err) => {
              setProgress((cur) => cur && { ...cur, completed: cur.completed + 1 });
              return { player: p, ok: false, error: err.message };
            })
        )
      );

      const successes = settled.filter((s) => s.ok);
      const failures = settled.filter((s) => !s.ok);

      if (successes.length === 0) {
        throw new Error(failures.map((f) => f.error).join(" | "));
      }

      // Merge each player's response into one combined view. tier_counts
      // sums; top_10 concatenates then re-sorts (tier rank, then conf desc)
      // and slices to 10. errors/skipped concatenate.
      const merged = {
        total_analyzed: 0,
        total_s_a: 0,
        tier_counts: { S: 0, A: 0, B: 0, SKIP: 0, UNKNOWN: 0 },
        top_10: [],
        skipped: [],
        errors: [],
        lines_fetched_at: successes[0].data.lines_fetched_at ?? null,
      };
      for (const s of successes) {
        const d = s.data;
        merged.total_analyzed += d.total_analyzed || 0;
        merged.total_s_a += d.total_s_a || 0;
        if (d.tier_counts) {
          for (const k of Object.keys(merged.tier_counts)) {
            merged.tier_counts[k] += d.tier_counts[k] || 0;
          }
        }
        if (Array.isArray(d.top_10)) merged.top_10.push(...d.top_10);
        if (Array.isArray(d.skipped)) merged.skipped.push(...d.skipped.map((x) => ({ ...x, _player: s.player })));
        if (Array.isArray(d.errors)) merged.errors.push(...d.errors);
      }
      // Network-level failures show up alongside the server's per-task errors.
      for (const f of failures) merged.errors.push({ task: f.player, error: f.error });

      // Re-rank the combined top picks across all players.
      merged.top_10.sort((a, b) => {
        const ta = TIER_ORDER[a.tier] ?? 9;
        const tb = TIER_ORDER[b.tier] ?? 9;
        if (ta !== tb) return ta - tb;
        return (b.confidence || 0) - (a.confidence || 0);
      });
      merged.top_10 = merged.top_10.slice(0, 10);

      setResults(merged);
      if (merged.lines_fetched_at) setLinesFetchedAt(merged.lines_fetched_at);
      // If ALL players hit cache we report HIT; any miss → MISS.
      const anyMiss = successes.some((s) => s.cacheStatus !== "HIT");
      setCacheStatus(anyMiss ? "MISS" : "HIT");
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setAnalyzing(false);
      setProgress(null);
    }
  }, [players, selectedStats, selectedOdds, selectedDirections, analyzeOne]);

  // Build the best +EV slate from the filtered board via /api/build-slate.
  // Board-level (not per-player): the market consensus prices every prop, so
  // this is one fast request. v1 uses STANDARD lines (exact 5× payout) — we
  // don't pass oddsTypes, so the endpoint defaults to standard; goblin/demon
  // payouts are approximate and would fabricate EV. The Games filter carries
  // over (mapped from canonical "A|B" back to the scrape's away@home keys).
  const buildSlateNow = useCallback(async () => {
    setSlateError(null);
    setSlate(null);
    // A paused league (WC) still round-trips to /api/build-slate: the server
    // prices + logs its legs for calibration telemetry, then returns the
    // "pending" abstain, which the abstain card renders (calibration_pending).
    setBuildingSlate(true);
    try {
      // Date filter constrains the board even without explicit game picks;
      // explicit picks narrow further within the date-filtered pool.
      const pool = selectedGames.length
        ? dateFilteredGames.filter((g) => selectedGames.includes(g.canonical))
        : selectedDates.length
        ? dateFilteredGames
        : null;
      const gameKeys = pool
        ? pool.flatMap((g) => g.gameKeys.map((k) => k.replace(/^(WNBA|WC):/, "")))
        : null;
      const body = { league, statTypes: selectedStats, targetMultiplier, mode: slateMode, size: 3 };
      if (gameKeys && gameKeys.length) body.games = gameKeys;

      const res = await fetch("/api/build-slate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Request failed");
      setSlate(data);
      if (data.lines_fetched_at) setLinesFetchedAt(data.lines_fetched_at);
    } catch (e) {
      setSlateError(`Error: ${e.message}`);
    } finally {
      setBuildingSlate(false);
    }
  }, [league, selectedStats, selectedGames, selectedDates, dateFilteredGames, targetMultiplier, slateMode]);

  // Trigger a live PrizePicks refresh via the existing /api/refresh-lines
  // endpoint. Locally (residential IP) this scrapes + writes the blob; on
  // deployed Vercel (cloud IP) the endpoint returns 502 because the scrape
  // would return 0 props — surfaced as "no-data" so the UI doesn't pretend
  // a refresh happened. The result cache (result-cache.js) keys on
  // fetched_at, so a new timestamp invalidates prior entries automatically.
  const refreshLines = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshStatus(null);
    try {
      // import.meta.env values are inlined at build time. A stray non-Latin-1
      // char (smart quote, em/en-dash, zero-width space from a bad paste into
      // the env var) makes fetch() throw "String contains non ISO-8859-1 code
      // point" before the request is sent — HTTP header values must be Latin-1.
      const token = (import.meta.env.VITE_REFRESH_TOKEN ?? "").trim();
      if (/[\u0100-\uffff]/.test(token)) {
        throw new Error(
          "VITE_REFRESH_TOKEN contains a non-ASCII character — re-enter it as plain ASCII (no smart quotes/dashes) and redeploy.",
        );
      }
      const response = await fetch("/api/refresh-lines", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        if (body.fetched_at) setLinesFetchedAt(body.fetched_at);
        setRefreshStatus({
          kind: "success",
          message: `Refreshed — ${body.total_props ?? "?"} props across ${body.total_players ?? "?"} players.`,
        });
        // Re-pull the slate so newly-refreshed games/players appear without a
        // page reload. (Blob edge cache is 60s, so a brand-new game may take up
        // to a minute to surface.)
        loadLines();
      } else if (response.status === 502) {
        setRefreshStatus({
          kind: "no-data",
          message: "No fresh data available (PrizePicks likely IP-blocked this host).",
        });
      } else {
        setRefreshStatus({
          kind: "error",
          message: body.error || `Refresh failed (HTTP ${response.status}).`,
        });
      }
    } catch (err) {
      setRefreshStatus({ kind: "error", message: `Refresh failed: ${err.message}` });
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, loadLines]);

  // Auto-clear the refresh status banner so it doesn't linger.
  useEffect(() => {
    if (!refreshStatus) return undefined;
    const t = setTimeout(() => setRefreshStatus(null), 4000);
    return () => clearTimeout(t);
  }, [refreshStatus]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#080c0f",
      fontFamily: "'Courier New', monospace",
      color: "#c8d8e8",
      padding: "24px 16px",
    }}>
      <div style={{ maxWidth: 680, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 32, borderBottom: "1px solid #1e3040", paddingBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 11, letterSpacing: 4, color: "#4488aa", marginBottom: 4 }}>
                {league} PRIZEPICKS
              </div>
              <div style={{ fontSize: 22, fontWeight: "bold", color: "#ffffff", letterSpacing: 1 }}>
                SLATE BUILDER
              </div>
              <div style={{ fontSize: 11, color: "#446688", marginTop: 4 }}>
                BEST 3-LEG +EV SLATE · DK/FD NO-VIG CONSENSUS
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <div style={{ fontSize: 10, letterSpacing: 1, color: "#446688", whiteSpace: "nowrap" }}>
                LINES{" "}
                <span style={{ color: linesFetchedAt ? "#88aacc" : "#664444" }}>
                  {formatLinesFetchedAt(linesFetchedAt) || "—"}
                </span>
              </div>
              <button
                onClick={refreshLines}
                disabled={refreshing}
                style={{
                  background: refreshing ? "#1a2a3a" : "#0066cc",
                  color: refreshing ? "#446688" : "#ffffff",
                  border: `1px solid ${refreshing ? "#1e3040" : "#0088ff"}`,
                  padding: "6px 14px",
                  fontFamily: "'Courier New', monospace",
                  fontSize: 10,
                  fontWeight: "bold",
                  letterSpacing: 2,
                  cursor: refreshing ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                  whiteSpace: "nowrap",
                }}
              >
                {refreshing ? "REFRESHING..." : "REFRESH LINES"}
              </button>
            </div>
          </div>
          {refreshStatus && (
            <div
              style={{
                marginTop: 10,
                padding: "6px 10px",
                fontSize: 11,
                border: `1px solid ${REFRESH_STATUS_COLORS[refreshStatus.kind].border}`,
                background: REFRESH_STATUS_COLORS[refreshStatus.kind].bg,
                color: REFRESH_STATUS_COLORS[refreshStatus.kind].fg,
              }}
            >
              {refreshStatus.message}
            </div>
          )}
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>

          {/* League Toggle */}
          <div role="tablist" aria-label="League" style={{ display: "flex", gap: 0, border: "1px solid #1e3040" }}>
            {LEAGUES.map((l) => {
              const active = l === league;
              const count = leagueCounts[l] ?? 0;
              return (
                <button
                  key={l}
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleLeagueChange(l)}
                  style={{
                    flex: 1,
                    background: active ? "#0066cc" : "#0a1420",
                    color: active ? "#ffffff" : "#446688",
                    border: "none",
                    padding: "10px 12px",
                    fontFamily: "'Courier New', monospace",
                    fontSize: 12,
                    letterSpacing: 2,
                    fontWeight: active ? "bold" : "normal",
                    cursor: "pointer",
                  }}
                >
                  {l} ({count})
                </button>
              );
            })}
          </div>

          {/* Player Multi-Select — chips above, search below */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div ref={playerRef} style={{ position: "relative", flex: 1, minWidth: 180 }}>
              {players.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  {players.map((p) => (
                    <span
                      key={p}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        background: "#0066cc",
                        color: "#ffffff",
                        padding: "4px 8px",
                        fontSize: 11,
                        letterSpacing: 0.5,
                        border: "1px solid #0088ff",
                      }}
                    >
                      {p}
                      <button
                        type="button"
                        onClick={() => removePlayer(p)}
                        aria-label={`Remove ${p}`}
                        style={{
                          background: "transparent",
                          color: "#ffffff",
                          border: "none",
                          padding: 0,
                          margin: 0,
                          cursor: "pointer",
                          fontSize: 14,
                          lineHeight: 1,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                type="text"
                value={playerQuery}
                onChange={(e) => {
                  setPlayerQuery(e.target.value);
                  setPlayerOpen(true);
                  setPlayerHighlight(0);
                }}
                onFocus={() => {
                  setPlayerOpen(true);
                }}
                onBlur={() => {
                  setPlayerOpen(false);
                }}
                onKeyDown={handlePlayerKeyDown}
                placeholder={players.length > 0 ? "— ADD ANOTHER PLAYER —" : "— SEARCH PLAYER —"}
                role="combobox"
                aria-expanded={playerOpen}
                aria-controls="player-listbox"
                aria-activedescendant={
                  playerOpen && filteredPlayers[playerHighlight]
                    ? `player-opt-${playerHighlight}`
                    : undefined
                }
                style={{ ...selectStyle, flex: undefined, minWidth: undefined, width: "100%", boxSizing: "border-box" }}
              />
              {playerOpen && leaguePlayers.length > 0 && (
                <ul
                  id="player-listbox"
                  role="listbox"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 2px)",
                    left: 0,
                    right: 0,
                    maxHeight: 280,
                    overflowY: "auto",
                    background: "#0a1420",
                    border: "1px solid #1e3040",
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    zIndex: 10,
                  }}
                >
                  {/* SELECT ALL row — always visible so the user can both
                      add every visible player and deselect them later. The
                      toggle scope is the current league + game filter, so
                      pairing this with a Game pick is the realistic path
                      (selecting all 180 NBA players at once will still
                      tip the 20/min rate limit even after the bump). */}
                  <li
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleAllPlayers();
                    }}
                    style={{
                      padding: "8px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: allLeaguePlayersSelected ? "#0066cc22" : "transparent",
                      borderBottom: "1px solid #1e3040",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={allLeaguePlayersSelected}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    <strong>
                      {allLeaguePlayersSelected
                        ? `DESELECT ALL (${leaguePlayers.length})`
                        : `SELECT ALL (${leaguePlayers.length})`}
                    </strong>
                  </li>

                  {filteredPlayers.length === 0 ? (
                    <li
                      style={{
                        padding: "8px 12px",
                        fontSize: 11,
                        color: "#446688",
                        fontStyle: "italic",
                      }}
                    >
                      (no players match)
                    </li>
                  ) : (
                    filteredPlayers.map((p, i) => {
                      const checked = players.includes(p);
                      const highlighted = i === playerHighlight;
                      // Highlight (keyboard nav) overrides selection tint
                      // so the focused row stays visible regardless of
                      // checkbox state. Selected-but-not-focused rows use
                      // the same #0066cc22 tint as the other multi-selects.
                      const bg = highlighted
                        ? "#0066cc"
                        : checked
                        ? "#0066cc22"
                        : "transparent";
                      const fg = highlighted ? "#ffffff" : "#c8d8e8";
                      return (
                        <li
                          key={p}
                          id={`player-opt-${i}`}
                          role="option"
                          aria-selected={checked}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            togglePlayer(p);
                          }}
                          onMouseEnter={() => setPlayerHighlight(i)}
                          style={{
                            padding: "8px 12px",
                            fontSize: 12,
                            cursor: "pointer",
                            background: bg,
                            color: fg,
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            readOnly
                            style={{ cursor: "pointer" }}
                          />
                          {p}
                        </li>
                      );
                    })
                  )}
                </ul>
              )}
            </div>
          </div>

          {/* Date Multi-Select — narrows the Games list (and through it the
              player picker + slate builder) to slates on the chosen local
              dates. The snapshot can span several days (WC group stage /
              NBA Finals post early). Empty selection = all dates. */}
          <div ref={datesRef} style={{ position: "relative" }}>
            <div
              onClick={() => setDatesOpen(!datesOpen)}
              style={{
                ...selectStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12 }}>
                {availableDates.length === 0
                  ? "— NO DATES AVAILABLE —"
                  : selectedDates.length === 0
                  ? "ALL DATES"
                  : selectedDates.length === 1
                  ? availableDates.find((d) => d.key === selectedDates[0])?.label || "1 DATE"
                  : `${selectedDates.length} DATES SELECTED`}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {datesOpen ? "▲" : "▼"}
              </span>
            </div>
            {datesOpen && availableDates.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  background: "#0a1420",
                  border: "1px solid #1e3040",
                  padding: "8px 0",
                  zIndex: 10,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {availableDates.map((d) => (
                  <label
                    key={d.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: selectedDates.includes(d.key) ? "#0066cc22" : "transparent",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleDate(d.key);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedDates.includes(d.key)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    <span style={{ flex: 1 }}>{d.label}</span>
                    <span style={{ fontSize: 10, color: "#446688" }}>
                      {d.count} {d.count === 1 ? "GAME" : "GAMES"}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Game Multi-Select — pulled from /api/lines on mount, narrowed
              by the Date filter. Filters the player picker to players who
              have lines in the selected games. Empty selection = no filter
              (all date-visible players). */}
          <div ref={gamesRef} style={{ position: "relative" }}>
            <div
              onClick={() => setGamesOpen(!gamesOpen)}
              style={{
                ...selectStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12 }}>
                {dateFilteredGames.length === 0
                  ? "— NO GAMES AVAILABLE —"
                  : selectedGames.length === 0
                  ? "ALL GAMES"
                  : selectedGames.length === 1
                  ? dateFilteredGames.find((g) => g.canonical === selectedGames[0])?.label || "1 GAME"
                  : `${selectedGames.length} GAMES SELECTED`}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {gamesOpen ? "▲" : "▼"}
              </span>
            </div>
            {gamesOpen && dateFilteredGames.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  background: "#0a1420",
                  border: "1px solid #1e3040",
                  padding: "8px 0",
                  zIndex: 10,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {dateFilteredGames.map((g) => (
                  <label
                    key={g.canonical}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: selectedGames.includes(g.canonical) ? "#0066cc22" : "transparent",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleGame(g.canonical);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedGames.includes(g.canonical)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    <span style={{ flex: 1 }}>{g.label}</span>
                    {g.dateLabel && (
                      <span style={{ fontSize: 10, color: "#446688" }}>{g.dateLabel}</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Odds Multi-Select — display filter on the result rows. Default
              all three selected (goblin + standard + demon). Empty
              selection = hide all results (same as unchecking everything
              on the stats picker). tier_counts ignores this filter. */}
          <div ref={oddsRef} style={{ position: "relative" }}>
            <div
              onClick={() => setOddsOpen(!oddsOpen)}
              style={{
                ...selectStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12 }}>
                {selectedOdds.length === 0
                  ? "— SELECT ODDS —"
                  : allOddsSelected
                  ? "ALL ODDS"
                  : selectedOdds.map((o) => o.toUpperCase()).join(", ")}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {oddsOpen ? "▲" : "▼"}
              </span>
            </div>
            {oddsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  background: "#0a1420",
                  border: "1px solid #1e3040",
                  padding: "8px 0",
                  zIndex: 10,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    background: allOddsSelected ? "#0066cc22" : "transparent",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleAllOdds();
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allOddsSelected}
                    readOnly
                    style={{ cursor: "pointer" }}
                  />
                  <strong>SELECT ALL</strong>
                </label>
                {ODDS_TYPES.map((o) => (
                  <label
                    key={o}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: selectedOdds.includes(o) ? "#0066cc22" : "transparent",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleOdds(o);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedOdds.includes(o)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    {o.toUpperCase()}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Direction Multi-Select — pre-analysis. Default: both selected.
              Empty selection blocks Analyze. Single selection pins the
              request to one direction; both selected omits `direction`
              from the body so the backend fans out to OVER + UNDER. */}
          <div ref={directionsRef} style={{ position: "relative" }}>
            <div
              onClick={() => setDirectionsOpen(!directionsOpen)}
              style={{
                ...selectStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12 }}>
                {selectedDirections.length === 0
                  ? "— SELECT DIRECTION —"
                  : allDirectionsSelected
                  ? "OVER + UNDER"
                  : selectedDirections.join(", ")}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {directionsOpen ? "▲" : "▼"}
              </span>
            </div>
            {directionsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  background: "#0a1420",
                  border: "1px solid #1e3040",
                  padding: "8px 0",
                  zIndex: 10,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    background: allDirectionsSelected ? "#0066cc22" : "transparent",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleAllDirections();
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allDirectionsSelected}
                    readOnly
                    style={{ cursor: "pointer" }}
                  />
                  <strong>SELECT ALL</strong>
                </label>
                {DIRECTIONS.map((d) => (
                  <label
                    key={d}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: selectedDirections.includes(d) ? "#0066cc22" : "transparent",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleDirection(d);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedDirections.includes(d)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    {d}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Stat Multi-Select */}
          <div ref={statsRef} style={{ position: "relative" }}>
            <div
              onClick={() => setStatsOpen(!statsOpen)}
              style={{
                ...selectStyle,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12 }}>
                {selectedStats.length === 0
                  ? "— SELECT STATS —"
                  : selectedStats.length === leagueStats.length
                  ? "ALL STATS"
                  : `${selectedStats.length} STATS SELECTED`}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {statsOpen ? "▲" : "▼"}
              </span>
            </div>

            {statsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 2px)",
                  left: 0,
                  right: 0,
                  background: "#0a1420",
                  border: "1px solid #1e3040",
                  padding: "8px 0",
                  zIndex: 10,
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {/* Select All */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    background: allStatsSelected ? "#0066cc22" : "transparent",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleAllStats();
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allStatsSelected}
                    readOnly
                    style={{ cursor: "pointer" }}
                  />
                  <strong>SELECT ALL</strong>
                </label>

                {leagueStats.map((s) => (
                  <label
                    key={s}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      fontSize: 12,
                      cursor: "pointer",
                      background: selectedStats.includes(s) ? "#0066cc22" : "transparent",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      toggleStat(s);
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedStats.includes(s)}
                      readOnly
                      style={{ cursor: "pointer" }}
                    />
                    {s}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Filter Summary — live preview of selection state and dispatched
              work. linesToAnalyze is the exact engine task count the Analyze
              click will produce (matches what /api/analyze-all would build),
              so the user can see filters shrink the workload in real time. */}
          <div
            style={{
              background: "#0a1420",
              border: "1px solid #1e3040",
              padding: "10px 14px",
              fontSize: 11,
              color: "#446688",
              display: "flex",
              flexWrap: "wrap",
              gap: 14,
              letterSpacing: 1,
            }}
          >
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>PLAYERS </span>
              <strong style={{ color: "#c8d8e8" }}>{filterStats.players}</strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>DATES </span>
              <strong style={{ color: "#c8d8e8" }}>
                {filterStats.dates === 0
                  ? `ALL${filterStats.datesTotal > 0 ? ` (${filterStats.datesTotal})` : ""}`
                  : `${filterStats.dates} / ${filterStats.datesTotal}`}
              </strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>GAMES </span>
              <strong style={{ color: "#c8d8e8" }}>
                {filterStats.games === 0
                  ? `ALL${filterStats.gamesTotal > 0 ? ` (${filterStats.gamesTotal})` : ""}`
                  : `${filterStats.games} / ${filterStats.gamesTotal}`}
              </strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>STATS </span>
              <strong style={{ color: "#c8d8e8" }}>
                {filterStats.stats} / {filterStats.statsTotal}
              </strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>ODDS </span>
              <strong style={{ color: "#c8d8e8" }}>
                {filterStats.odds} / {filterStats.oddsTotal}
              </strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>DIR </span>
              <strong style={{ color: "#c8d8e8" }}>
                {filterStats.directions} / {filterStats.directionsTotal}
              </strong>
            </span>
            <span style={{ color: "#8ab0cc" }}>
              <span style={{ color: "#446688" }}>PROPS </span>
              <strong style={{ color: "#c8d8e8" }}>{filterStats.propBuckets}</strong>
            </span>
            <span style={{ color: filterStats.linesToAnalyze > 0 ? "#00FF88" : "#886644" }}>
              <span style={{ color: "#446688" }}>LINES </span>
              <strong>{filterStats.linesToAnalyze}</strong>
            </span>
          </div>

          {/* Slate Builder — primary action: target multiplier + Power/Flex */}
          <div style={{ display: "flex", gap: 12, alignItems: "stretch", flexWrap: "wrap" }}>
            <div style={{ ...selectStyle, display: "flex", alignItems: "center", gap: 8, flex: 1, cursor: "default" }}>
              <span style={{ color: "#446688", fontSize: 11, letterSpacing: 1 }}>TARGET</span>
              <select
                value={targetMultiplier}
                onChange={(e) => setTargetMultiplier(Number(e.target.value))}
                style={{ background: "transparent", color: "#c8d8e8", border: "none", fontFamily: "'Courier New', monospace", fontSize: 12, cursor: "pointer", outline: "none", flex: 1 }}
              >
                {[2, 3, 5, 10].map((m) => (
                  <option key={m} value={m} style={{ background: "#0a1420" }}>{m}×+</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", border: "1px solid #1e3040", flex: 1 }}>
              {["power", "flex"].map((m) => {
                const active = slateMode === m;
                return (
                  <button
                    key={m}
                    onClick={() => setSlateMode(m)}
                    style={{ flex: 1, background: active ? "#0066cc" : "#0a1420", color: active ? "#fff" : "#446688", border: "none", padding: "10px 12px", fontFamily: "'Courier New', monospace", fontSize: 12, letterSpacing: 2, fontWeight: active ? "bold" : "normal", cursor: "pointer" }}
                  >
                    {m.toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            onClick={buildSlateNow}
            disabled={buildingSlate}
            style={{
              background: buildingSlate ? "#1a2a3a" : "#00aa55",
              color: buildingSlate ? "#446688" : "#ffffff",
              border: `1px solid ${buildingSlate ? "#1e3040" : "#00cc66"}`,
              padding: "12px 28px",
              fontFamily: "'Courier New', monospace",
              fontSize: 13,
              fontWeight: "bold",
              letterSpacing: 2,
              cursor: buildingSlate ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {buildingSlate ? "BUILDING SLATE..." : `BUILD ${slateMode.toUpperCase()} SLATE (≥${targetMultiplier}×)`}
          </button>
          <div style={{ fontSize: 10, color: "#446688", letterSpacing: 1, marginTop: -4 }}>
            Board-level · standard lines · DK/FD no-vig consensus · +EV-or-abstain
          </div>

          {/* Analyze Button — secondary: per-player engine tier analysis */}
          <button
            onClick={analyzeAll}
            disabled={analyzing}
            style={{
              background: analyzing ? "#1a2a3a" : "#0066cc",
              color: analyzing ? "#446688" : "#ffffff",
              border: `1px solid ${analyzing ? "#1e3040" : "#0088ff"}`,
              padding: "10px 28px",
              fontFamily: "'Courier New', monospace",
              fontSize: 12,
              fontWeight: "bold",
              letterSpacing: 2,
              cursor: analyzing ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {analyzing
              ? progress
                ? `ANALYZING... (${progress.completed}/${progress.total})`
                : "ANALYZING..."
              : players.length > 1
                ? `ANALYZE ${players.length} PLAYERS`
                : "ANALYZE ALL LINES"}
          </button>
        </div>

        {/* Slate Builder result */}
        {slateError && (
          <div style={{ background: "#220000", border: "1px solid #440000", padding: "10px 14px", fontSize: 12, color: "#ff6666", marginBottom: 16 }}>
            {slateError}
          </div>
        )}
        {buildingSlate && (
          <div style={{ border: "1px solid #1e3040", padding: 24, textAlign: "center", marginBottom: 16 }}>
            <div style={{ color: "#00cc66", fontSize: 11, letterSpacing: 3 }}>BUILDING SLATE…</div>
            <div style={{ color: "#446688", fontSize: 11, marginTop: 6 }}>Pricing the board against DK/FD consensus</div>
          </div>
        )}
        {slate && !buildingSlate && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: 2, color: "#00cc66", fontWeight: "bold" }}>RECOMMENDED SLATE</div>
              <div style={{ fontSize: 10, color: "#446688" }}>
                {(slate.odds_sources?.join("+")) || "market"} · {slate.props_priced ?? 0}/{slate.props_examined ?? 0} priced
              </div>
            </div>
            {slate.abstained ? (
              <div style={{ background: "#1a1200", border: "1px solid #664400", padding: 16, color: "#cc9944", fontSize: 12, lineHeight: 1.6 }}>
                <div style={{ fontWeight: "bold", letterSpacing: 1, marginBottom: 6 }}>{slate.calibration_pending ? "SLATE PAUSED — PENDING CALIBRATION" : "NO +EV SLATE — ABSTAIN"}</div>
                <div style={{ color: "#aa8855" }}>{slate.reason}</div>
                {slate.best_rejected && (
                  <div style={{ marginTop: 8, color: "#886644" }}>
                    Closest near-miss: EV {(slate.best_rejected.ev * 100).toFixed(1)}% at {slate.best_rejected.win_multiplier}×
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 10, color: "#665533" }}>
                  {slate.calibration_pending
                    ? "EV is withheld until this league's standard-line calibration is validated — its market is single-book and ungraded, so a slate would read as falsely +EV."
                    : `Not betting is the correct call when nothing clears +EV at ≥${slate.params?.targetMultiplier ?? targetMultiplier}×.`}
                </div>
              </div>
            ) : slate.slate ? (
              <div>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", background: "#002218", border: "1px solid #00FF8844", padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>
                  <span style={{ color: "#8ab0cc" }}><span style={{ color: "#446688" }}>EV </span><strong style={{ color: slate.slate.ev >= 0 ? "#00FF88" : "#ff6666" }}>{(slate.slate.ev * 100).toFixed(1)}%</strong></span>
                  <span style={{ color: "#8ab0cc" }}><span style={{ color: "#446688" }}>PAYOUT </span><strong style={{ color: "#c8d8e8" }}>{slate.slate.win_multiplier}×</strong></span>
                  <span style={{ color: "#8ab0cc" }}><span style={{ color: "#446688" }}>P(ALL) </span><strong style={{ color: "#c8d8e8" }}>{(slate.slate.p_all * 100).toFixed(1)}%</strong></span>
                  <span style={{ color: "#8ab0cc" }}><span style={{ color: "#446688" }}>MODE </span><strong style={{ color: "#c8d8e8" }}>{slate.slate.mode.toUpperCase()}</strong></span>
                </div>
                {slate.slate.legs.map((l, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: i % 2 ? "#0a1420" : "#0c1a14", border: "1px solid #1e3040", padding: "10px 14px", marginBottom: 6, fontSize: 12 }}>
                    <div>
                      <div style={{ fontWeight: "bold", color: "#ffffff" }}>{l.player}</div>
                      <div style={{ color: "#8ab0cc", fontSize: 11 }}>
                        {l.stat_type}{" "}
                        <span style={{ color: l.direction === "OVER" ? "#00FF88" : "#FF8844" }}>{l.direction === "OVER" ? "▲" : "▼"} {l.line}</span>{" "}
                        <span style={{ color: "#446688" }}>· {l.game}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: "bold", color: "#00FF88" }}>{(l.prob * 100).toFixed(1)}%</div>
                      <div style={{ color: "#446688", fontSize: 10 }}>{l.prob_source}{l.market_line_delta ? ` · Δ${l.market_line_delta}` : ""}</div>
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: 10, color: "#446688", marginTop: 6 }}>
                  Stake 1u → returns {slate.slate.expected_return?.toFixed(2)}u on average. Probabilities are DK/FD no-vig consensus at the PrizePicks line.
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: "#220000",
            border: "1px solid #440000",
            padding: "10px 14px",
            fontSize: 12,
            color: "#ff6666",
            marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {/* Loading State */}
        {analyzing && (
          <div style={{
            border: "1px solid #1e3040",
            padding: 24,
            textAlign: "center",
          }}>
            <div style={{ color: "#4488aa", fontSize: 11, letterSpacing: 3, marginBottom: 8 }}>
              RUNNING ENGINE
            </div>
            <div style={{ color: "#446688", fontSize: 11 }}>
              {progress
                ? `${progress.completed} of ${progress.total} player${progress.total === 1 ? "" : "s"} analyzed`
                : "Analyzing PrizePicks lines..."}
            </div>
          </div>
        )}

        {/* Results Table */}
        {results && !analyzing && (
          <div>
            {/* Summary */}
            <div style={{
              background: "#0a1420",
              border: "1px solid #1e3040",
              padding: "12px 16px",
              marginBottom: 16,
              fontSize: 11,
              color: "#446688",
              display: "flex",
              justifyContent: "space-between",
            }}>
              <span>Analyzed: {results.total_analyzed} lines</span>
              <span>S/A/B Tier: {results.total_s_a} picks</span>
              <span>Showing: {displayedTop10.length} results</span>
              {cacheStatus && (
                <span style={{ color: cacheStatus === "HIT" ? "#00FF88" : "#446688" }}>
                  Cache: {cacheStatus}
                </span>
              )}
            </div>

            {/* Tier breakdown — surfaces what the LLM/verifier actually
                returned across all analyzed lines. The S/A/B summary above
                only counts what reaches the table; this row shows where the
                rest landed (mechanical SKIPs, errors). */}
            {results.tier_counts && (
              <div style={{
                background: "#0a1420",
                border: "1px solid #1e3040",
                borderTop: "none",
                padding: "8px 16px",
                marginTop: -16,
                marginBottom: 16,
                fontSize: 10,
                color: "#446688",
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
              }}>
                <span style={{ letterSpacing: 1 }}>TIER COUNTS:</span>
                {Object.entries(results.tier_counts)
                  .filter(([, n]) => n > 0)
                  .map(([tier, n]) => {
                    const c = tier === "S" ? "#FFD700"
                            : tier === "A" ? "#00FF88"
                            : tier === "B" ? "#4488FF"
                            : tier === "SKIP" ? "#886644"
                            : "#aa4444";
                    return (
                      <span key={tier} style={{ color: c }}>
                        {tier} {n}
                      </span>
                    );
                  })}
              </div>
            )}

            {/* Player-wide skip reasons (e.g. no_upcoming_game,
                player_not_configured) — surface so the operator knows the
                analysis stopped at the data layer, not the framework. */}
            {results.skipped && results.skipped.length > 0 && (
              <div style={{
                background: "#1a0f00",
                border: "1px solid #663300",
                padding: "8px 14px",
                marginBottom: 16,
                fontSize: 11,
                color: "#cc8844",
              }}>
                <div style={{ fontSize: 10, letterSpacing: 1, marginBottom: 4, color: "#886644" }}>
                  SKIPPED AT DATA LAYER
                </div>
                {results.skipped.map((s, i) => (
                  <div key={i}>· {s.stat ? `${s.stat}: ` : ""}{s.reason}{s.message ? ` — ${s.message}` : ""}</div>
                ))}
              </div>
            )}

            {/* Errors from the LLM router (provider exhaustion, parse
                failures). Already counted under tier_counts.UNKNOWN above,
                but the per-task reason is only visible here. */}
            {results.errors && results.errors.length > 0 && (
              <div style={{
                background: "#1a0000",
                border: "1px solid #660000",
                padding: "8px 14px",
                marginBottom: 16,
                fontSize: 11,
                color: "#cc6666",
              }}>
                <div style={{ fontSize: 10, letterSpacing: 1, marginBottom: 4, color: "#884444" }}>
                  LLM ERRORS ({results.errors.length})
                </div>
                {results.errors.slice(0, 5).map((e, i) => (
                  <div key={i}>· {e.task}: {e.error}</div>
                ))}
              </div>
            )}

            {/* Table */}
            {displayedTop10.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}>
                  <thead>
                    <tr style={{ background: "#0a1420", borderBottom: "2px solid #1e3040" }}>
                      <th style={{ padding: "8px 10px", textAlign: "left", color: "#446688", fontSize: 10, letterSpacing: 1 }}>#</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", color: "#446688", fontSize: 10, letterSpacing: 1 }}>PLAYER</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", color: "#446688", fontSize: 10, letterSpacing: 1 }}>GAME</th>
                      <th style={{ padding: "8px 10px", textAlign: "left", color: "#446688", fontSize: 10, letterSpacing: 1 }}>PROP</th>
                      <th style={{ padding: "8px 10px", textAlign: "right", color: "#446688", fontSize: 10, letterSpacing: 1 }}>LINE</th>
                      <th style={{ padding: "8px 10px", textAlign: "center", color: "#446688", fontSize: 10, letterSpacing: 1 }}>ODDS</th>
                      <th style={{ padding: "8px 10px", textAlign: "center", color: "#446688", fontSize: 10, letterSpacing: 1 }}>TIER</th>
                      <th style={{ padding: "8px 10px", textAlign: "right", color: "#446688", fontSize: 10, letterSpacing: 1 }}>CONF%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedTop10.map((r, i) => {
                      const style = TIER_STYLE[r.tier] ?? { color: "#4488FF", bg: "#001a33", border: "#4488FF44" };
                      const oddsColor =
                        r.odds_type === "demon" ? "#FF6644" :
                        r.odds_type === "goblin" ? "#00FF88" :
                        r.odds_type === "standard" ? "#c8d8e8" : "#446688";
                      const oddsLabel = r.odds_type ? r.odds_type.toUpperCase() : "—";
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#0a1420" : style.bg, borderBottom: "1px solid #1e3040" }}>
                          <td style={{ padding: "8px 10px", color: "#446688" }}>{i + 1}</td>
                          <td style={{ padding: "8px 10px", fontWeight: "bold" }}>{r.player}</td>
                          <td style={{ padding: "8px 10px", fontSize: 11 }}>{r.game}</td>
                          <td style={{ padding: "8px 10px" }}>{r.prop_type}</td>
                          <td style={{ padding: "8px 10px", textAlign: "right" }}>{r.line}</td>
                          <td style={{ padding: "8px 10px", textAlign: "center", color: oddsColor, fontWeight: "bold" }}>
                            {oddsLabel}
                          </td>
                          <td style={{ padding: "8px 10px", textAlign: "center", color: style.color, fontWeight: "bold" }}>
                            {r.tier ? `${r.tier}-TIER` : "—"}
                          </td>
                          <td style={{ padding: "8px 10px", textAlign: "right", color: style.color, fontWeight: "bold" }}>
                            {r.confidence}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Justifications (expandable) */}
                <div style={{ marginTop: 16 }}>
                  {displayedTop10.map((r, i) => {
                    const style = TIER_STYLE[r.tier] ?? { color: "#4488FF", bg: "#001a33", border: "#4488FF44" };
                    return (
                      <div
                        key={i}
                        style={{
                          background: style.bg,
                          border: `1px solid ${style.border}`,
                          marginBottom: 8,
                          padding: "10px 14px",
                          fontSize: 11,
                          lineHeight: 1.6,
                          color: "#c8d8e8",
                        }}
                      >
                        <div style={{ marginBottom: 4, fontWeight: "bold", color: style.color }}>
                          #{i + 1} {r.player} - {r.prop_type} {r.verdict} ({r.line}) - {r.tier ? `${r.tier}-TIER` : "—"} {r.confidence}%
                        </div>
                        <div style={{ color: "#8ab0cc" }}>{r.justification}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{
                background: "#0a1420",
                border: "1px solid #1e3040",
                padding: 24,
                textAlign: "center",
                fontSize: 12,
                color: "#446688",
              }}>
                <div>
                  {(results.top_10?.length || 0) > 0 && displayedTop10.length === 0
                    ? "No picks match the selected Odds filter."
                    : "No S-Tier, A-Tier, or B-Tier picks found for the selected filters."}
                </div>
                {results.tier_counts && (() => {
                  const tc = results.tier_counts;
                  const nonZero = Object.entries(tc).filter(([, n]) => n > 0);
                  if (nonZero.length === 0) return null;
                  const total = nonZero.reduce((s, [, n]) => s + n, 0);
                  // When everything bucketed into SKIP, the most likely
                  // cause is the new missing_baseline gate (opening-day
                  // WNBA, retired player, no recent games). Surface it.
                  const allSkip = tc.SKIP === total && total > 0;
                  return (
                    <div style={{ marginTop: 10, fontSize: 11, color: "#668899" }}>
                      Breakdown: {nonZero.map(([t, n]) => `${t} ${n}`).join(" · ")}
                      {allSkip && (
                        <div style={{ marginTop: 6, color: "#886644" }}>
                          All lines SKIPped at the mechanical layer — most often missing baseline (e.g. opening-day sample, no recent games).
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
