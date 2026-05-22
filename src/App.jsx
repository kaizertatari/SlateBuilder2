import { useState, useCallback, useMemo, useEffect } from "react";
import playersData from "../data/players.json";
import { STATS } from "../api/lib/prop-types.js";
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

const LEAGUES = ["NBA", "WNBA"];

export default function App() {
  const [league, setLeague] = useState("NBA");
  // Multi-player selection. Order preserved so the chip row is stable;
  // duplicates are prevented at selectPlayer time.
  const [players, setPlayers] = useState([]);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHighlight, setPlayerHighlight] = useState(0);
  const [selectedStats, setSelectedStats] = useState([...STATS]);
  // Direction is hard-coded to OVER. UNDER analysis was removed from the
  // UI — the operator only takes OVER picks.
  const [analyzing, setAnalyzing] = useState(false);
  // Slate metadata fetched from /api/lines on mount + league change. Drives
  // the Game filter dropdown and constrains the player picker to the roster
  // of players who actually have lines published in the selected games.
  const [linesData, setLinesData] = useState(null);
  // Canonical game keys (alpha-sorted abbr pair, e.g. "BOS|LAL"). Empty
  // selection = no filter (all players visible).
  const [selectedGames, setSelectedGames] = useState([]);
  const [gamesOpen, setGamesOpen] = useState(false);
  // Odds-type filter for the displayed top picks. Default: all three.
  const [selectedOdds, setSelectedOdds] = useState([...ODDS_TYPES]);
  const [oddsOpen, setOddsOpen] = useState(false);
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

  const allStatsSelected = selectedStats.length === STATS.length;
  const allOddsSelected = selectedOdds.length === ODDS_TYPES.length;

  // Fetch the PrizePicks slate so we can populate the Game filter and
  // constrain the player picker to players who actually have lines tonight.
  // Re-run on league change to refresh the game list. The endpoint reads
  // from blob (or bundled fallback) — cheap; no need to debounce.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/lines")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setLinesData(d || null);
      })
      .catch(() => {
        if (!cancelled) setLinesData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the unique games list for the active league. The scraper writes
  // two game entries per matchup (one per team perspective: "BOS@LAL" and
  // "LAL@BOS"). Collapse to one canonical entry per pair using an alpha-sort
  // key, then preserve the raw gameKeys + player set so filters can fan out.
  const availableGames = useMemo(() => {
    const games = linesData?.data?.games || {};
    const byCanonical = new Map();
    for (const [gameKey, info] of Object.entries(games)) {
      if (!info || info.league !== league) continue;
      const cleanKey = gameKey.replace(/^WNBA:/, "");
      const parts = cleanKey.split("@");
      if (parts.length !== 2) continue;
      const [a, b] = parts;
      const canonical = [a, b].sort().join("|");
      let entry = byCanonical.get(canonical);
      if (!entry) {
        entry = { canonical, label: `${a} @ ${b}`, gameKeys: [], players: new Set() };
        byCanonical.set(canonical, entry);
      }
      entry.gameKeys.push(gameKey);
      for (const prop of info.props || []) {
        const name = prop.player_key || prop.player;
        if (name) entry.players.add(name);
      }
    }
    return [...byCanonical.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [linesData, league]);

  // Players visible in the picker — narrowed to selected games when at
  // least one game is picked. Empty selection means "no game filter".
  const leaguePlayers = useMemo(() => {
    const all = PLAYERS_BY_LEAGUE[league] ?? [];
    if (selectedGames.length === 0) return all;
    const allowed = new Set();
    for (const g of availableGames) {
      if (selectedGames.includes(g.canonical)) {
        for (const p of g.players) allowed.add(p);
      }
    }
    return all.filter((name) => allowed.has(name));
  }, [league, selectedGames, availableGames]);

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    // Hide already-selected players so the dropdown doesn't show duplicates.
    const available = leaguePlayers.filter((p) => !players.includes(p));
    if (!q) return available;
    return available.filter((p) => p.toLowerCase().includes(q));
  }, [playerQuery, leaguePlayers, players]);

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
    setPlayers([]);
    setPlayerQuery("");
    setPlayerOpen(false);
    setPlayerHighlight(0);
    setSelectedGames([]);
    setResults(null);
    setError(null);
    setCacheStatus(null);
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
      for (const g of availableGames) {
        if (stillSelected.includes(g.canonical)) {
          for (const p of g.players) allowed.add(p);
        }
      }
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

  const selectPlayer = (name) => {
    setPlayers((cur) => (cur.includes(name) ? cur : [...cur, name]));
    setPlayerQuery("");
    setPlayerOpen(false);
    setPlayerHighlight(0);
  };

  const removePlayer = (name) => {
    setPlayers((cur) => cur.filter((p) => p !== name));
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
        selectPlayer(filteredPlayers[playerHighlight]);
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
    setSelectedStats(allStatsSelected ? [] : [...STATS]);
  };

  // Fetch (or load from cache) a single player's analyze-all response.
  // Returns { data, cacheStatus } or throws on hard error.
  //
  // Direction is fixed to "OVER" — the UNDER UI path was removed. The
  // backend still accepts UNDER, but every UI-initiated request is OVER.
  const analyzeOne = useCallback(async (playerName) => {
    const cached = readNewestCached(playerName, selectedStats, "OVER");
    if (cached) {
      return { data: cached.data, cacheStatus: "HIT" };
    }
    const body = { player: playerName, statTypes: selectedStats, league, direction: "OVER" };

    const response = await fetch("/api/analyze-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (data.error) throw new Error(`${playerName}: ${data.error}`);
    if (!response.ok) throw new Error(data.error || "Request failed");

    if (data.lines_fetched_at) {
      const key = buildKey(playerName, data.lines_fetched_at, selectedStats, "OVER");
      writeCached(key, data);
      clearStaleForPlayer(key, playerName);
    }
    return { data, cacheStatus: response.headers.get("X-Cache") || "MISS" };
  }, [selectedStats, league]);

  const analyzeAll = useCallback(async () => {
    if (players.length === 0) {
      setError("Select at least one player.");
      return;
    }
    if (selectedStats.length === 0) {
      setError("Select at least one stat type.");
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
      // If ALL players hit cache we report HIT; any miss → MISS.
      const anyMiss = successes.some((s) => s.cacheStatus !== "HIT");
      setCacheStatus(anyMiss ? "MISS" : "HIT");
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setAnalyzing(false);
      setProgress(null);
    }
  }, [players, selectedStats, analyzeOne]);

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
          <div style={{ fontSize: 11, letterSpacing: 4, color: "#4488aa", marginBottom: 4 }}>
            {league} PRIZEPICKS
          </div>
          <div style={{ fontSize: 22, fontWeight: "bold", color: "#ffffff", letterSpacing: 1 }}>
            BATCH ANALYZER
          </div>
          <div style={{ fontSize: 11, color: "#446688", marginTop: 4 }}>
            S-TIER & A-TIER PICKS · PRIZEPICKS LINES
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>

          {/* League Toggle */}
          <div role="tablist" aria-label="League" style={{ display: "flex", gap: 0, border: "1px solid #1e3040" }}>
            {LEAGUES.map((l) => {
              const active = l === league;
              const count = PLAYERS_BY_LEAGUE[l]?.length ?? 0;
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
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
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
              {playerOpen && filteredPlayers.length > 0 && (
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
                  {filteredPlayers.map((p, i) => (
                    <li
                      key={p}
                      id={`player-opt-${i}`}
                      role="option"
                      aria-selected={i === playerHighlight}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectPlayer(p);
                      }}
                      onMouseEnter={() => setPlayerHighlight(i)}
                      style={{
                        padding: "8px 12px",
                        fontSize: 12,
                        cursor: "pointer",
                        background: i === playerHighlight ? "#0066cc" : "transparent",
                        color: i === playerHighlight ? "#ffffff" : "#c8d8e8",
                      }}
                    >
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Game Multi-Select — pulled from /api/lines on mount. Filters
              the player picker to players who have lines in the selected
              games. Empty selection = no filter (all players visible). */}
          <div style={{ position: "relative" }}>
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
                {availableGames.length === 0
                  ? "— NO GAMES AVAILABLE —"
                  : selectedGames.length === 0
                  ? "ALL GAMES"
                  : selectedGames.length === 1
                  ? availableGames.find((g) => g.canonical === selectedGames[0])?.label || "1 GAME"
                  : `${selectedGames.length} GAMES SELECTED`}
              </span>
              <span style={{ fontSize: 10, color: "#446688" }}>
                {gamesOpen ? "▲" : "▼"}
              </span>
            </div>
            {gamesOpen && availableGames.length > 0 && (
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
                {availableGames.map((g) => (
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
                    {g.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Odds Multi-Select — display filter on the result rows. Default
              all three selected (goblin + standard + demon). Empty
              selection = hide all results (same as unchecking everything
              on the stats picker). tier_counts ignores this filter. */}
          <div style={{ position: "relative" }}>
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

          {/* Stat Multi-Select */}
          <div style={{ position: "relative" }}>
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
                  : selectedStats.length === STATS.length
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

                {STATS.map((s) => (
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

          {/* Analyze Button */}
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
