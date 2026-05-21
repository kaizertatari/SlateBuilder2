import { useState, useCallback, useMemo } from "react";
import playersData from "../data/players.json";
import { STATS } from "../api/lib/prop-types.js";
import { readNewestCached, writeCached, clearStaleForPlayer, clearAllAnalyzeAll, buildKey } from "./lib/result-cache.js";

const TIER_ORDER = { S: 0, A: 1, B: 2, SKIP: 3 };

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
  const [player, setPlayer] = useState("");
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHighlight, setPlayerHighlight] = useState(0);
  const [selectedStats, setSelectedStats] = useState([...STATS]);
  const [direction, setDirection] = useState("OVER");
  const [analyzing, setAnalyzing] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // "HIT" when served from sessionStorage or when server returned X-Cache:HIT.
  // "MISS" on a fresh network analysis. null on first render / between calls.
  const [cacheStatus, setCacheStatus] = useState(null);
  const [clearing, setClearing] = useState(false);
  // Shown briefly after the CLEAR CACHE button completes. Null when no
  // recent clear action; cleared by the next analyze call.
  const [clearMessage, setClearMessage] = useState(null);

  const allStatsSelected = selectedStats.length === STATS.length;

  const leaguePlayers = PLAYERS_BY_LEAGUE[league] ?? [];

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    if (!q) return leaguePlayers;
    return leaguePlayers.filter((p) => p.toLowerCase().includes(q));
  }, [playerQuery, leaguePlayers]);

  const handleLeagueChange = (next) => {
    if (next === league) return;
    setLeague(next);
    setPlayer("");
    setPlayerQuery("");
    setPlayerOpen(false);
    setPlayerHighlight(0);
    setResults(null);
    setError(null);
    setCacheStatus(null);
  };

  const selectPlayer = (name) => {
    setPlayer(name);
    setPlayerQuery(name);
    setPlayerOpen(false);
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
        selectPlayer(filteredPlayers[playerHighlight]);
      }
    } else if (e.key === "Escape") {
      setPlayerOpen(false);
      setPlayerQuery(player);
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

  const analyzeAll = useCallback(async () => {
    if (!player) {
      setError("Select a player.");
      return;
    }
    if (selectedStats.length === 0) {
      setError("Select at least one stat type.");
      return;
    }

    setError(null);
    setResults(null);
    setCacheStatus(null);
    setClearMessage(null);

    // Browser-side cache check. Same (player, statTypes, direction) within
    // the current lines snapshot → return instantly, no server round-trip,
    // no LLM tokens, no external API hits. Key is keyed on fetched_at so
    // a cron-driven refresh invalidates everything automatically.
    const cached = readNewestCached(player, selectedStats, direction);
    if (cached) {
      setResults(cached.data);
      setCacheStatus("HIT");
      return;
    }

    setAnalyzing(true);

    try {
      const body = { player, statTypes: selectedStats, league };
      if (direction === "OVER" || direction === "UNDER") body.direction = direction;

      const response = await fetch("/api/analyze-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (data.error) throw new Error(data.error);
      if (!response.ok) throw new Error(data.error || "Request failed");

      setResults(data);
      // Reflect server-side cache status. A fresh tab can still hit the
      // server's in-memory cache if another user already analyzed this
      // (player, fetched_at, …) combo on the same warm instance.
      setCacheStatus(response.headers.get("X-Cache") || "MISS");

      // Persist for repeat clicks in this tab. Skip if the response is
      // missing lines_fetched_at (defensive — shouldn't happen after
      // server-side rollout).
      if (data.lines_fetched_at) {
        const key = buildKey(player, data.lines_fetched_at, selectedStats, direction);
        writeCached(key, data);
        clearStaleForPlayer(key, player);
      }
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setAnalyzing(false);
    }
  }, [player, selectedStats, direction, league]);

  // Manual cache wipe — drops every analyze-all entry from this tab's
  // sessionStorage AND asks the server to drop its in-process Map for the
  // analyze-all namespace. The next Analyze click is guaranteed to do real
  // work (fresh GT fetch + LLM call). Per-warm-instance only on the server
  // side — multi-instance deployments may keep serving cached entries from
  // other workers until they age out.
  const clearCache = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    setClearMessage(null);
    setError(null);
    let serverCleared = 0;
    let serverError = null;
    try {
      const response = await fetch("/api/cache-clear", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        serverError = data?.error || `HTTP ${response.status}`;
      } else {
        serverCleared = data.cleared ?? 0;
      }
    } catch (e) {
      serverError = e.message;
    }
    const browserCleared = clearAllAnalyzeAll();
    setCacheStatus(null);
    setResults(null);
    setClearMessage(
      serverError
        ? `Browser: ${browserCleared} cleared. Server: ${serverError}`
        : `Cleared ${serverCleared} server + ${browserCleared} browser entries.`
    );
    setClearing(false);
  }, [clearing]);

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

          {/* Player Select */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 180 }}>
              <input
                type="text"
                value={playerQuery}
                onChange={(e) => {
                  setPlayerQuery(e.target.value);
                  setPlayerOpen(true);
                  setPlayerHighlight(0);
                }}
                onFocus={(e) => {
                  setPlayerOpen(true);
                  e.target.select();
                }}
                onBlur={() => {
                  setPlayerOpen(false);
                  if (playerQuery !== player) setPlayerQuery(player);
                }}
                onKeyDown={handlePlayerKeyDown}
                placeholder="— SEARCH PLAYER —"
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

          {/* Direction */}
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            style={{ ...selectStyle, flex: undefined, width: "100%", boxSizing: "border-box" }}
          >
            <option value="OVER">OVER ONLY</option>
            <option value="UNDER">UNDER ONLY</option>
            <option value="BOTH">BOTH DIRECTIONS</option>
          </select>

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

          {/* Analyze + Clear Cache Buttons */}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={analyzeAll}
              disabled={analyzing}
              style={{
                flex: 1,
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
              {analyzing ? "ANALYZING..." : "ANALYZE ALL LINES"}
            </button>
            <button
              onClick={clearCache}
              disabled={clearing || analyzing}
              title="Drop cached analyze-all responses (browser + server). Next analyze runs cold."
              style={{
                background: "#0a1420",
                color: clearing || analyzing ? "#446688" : "#cc8844",
                border: `1px solid ${clearing || analyzing ? "#1e3040" : "#663300"}`,
                padding: "10px 16px",
                fontFamily: "'Courier New', monospace",
                fontSize: 11,
                fontWeight: "bold",
                letterSpacing: 2,
                cursor: clearing || analyzing ? "not-allowed" : "pointer",
                transition: "all 0.15s",
                whiteSpace: "nowrap",
              }}
            >
              {clearing ? "CLEARING..." : "CLEAR CACHE"}
            </button>
          </div>
          {clearMessage && (
            <div style={{
              fontSize: 10,
              color: "#886644",
              letterSpacing: 1,
              padding: "2px 4px",
            }}>
              {clearMessage}
            </div>
          )}
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
              RUNNING BATCH MODEL
            </div>
            <div style={{ color: "#446688", fontSize: 11 }}>
              Analyzing PrizePicks lines... This may take up to 30 seconds.
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
              <span>Showing: {Math.min(results.top_10?.length || 0, 10)} results</span>
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
            {results.top_10 && results.top_10.length > 0 ? (
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
                    {results.top_10.map((r, i) => {
                      const tierColor = r.tier === "S" ? "#FFD700" : r.tier === "A" ? "#00FF88" : "#4488FF";
                      const oddsColor =
                        r.odds_type === "demon" ? "#FF6644" :
                        r.odds_type === "goblin" ? "#00FF88" :
                        r.odds_type === "standard" ? "#c8d8e8" : "#446688";
                      const oddsLabel = r.odds_type ? r.odds_type.toUpperCase() : "—";
                      const bgColor = r.tier === "S" ? "#2a2200" : r.tier === "A" ? "#002218" : "#001133";
                      return (
                        <tr key={i} style={{ background: i % 2 === 0 ? "#0a1420" : bgColor, borderBottom: "1px solid #1e3040" }}>
                          <td style={{ padding: "8px 10px", color: "#446688" }}>{i + 1}</td>
                          <td style={{ padding: "8px 10px", fontWeight: "bold" }}>{r.player}</td>
                          <td style={{ padding: "8px 10px", fontSize: 11 }}>{r.game}</td>
                          <td style={{ padding: "8px 10px" }}>{r.prop_type}</td>
                          <td style={{ padding: "8px 10px", textAlign: "right" }}>{r.line}</td>
                          <td style={{ padding: "8px 10px", textAlign: "center", color: oddsColor, fontWeight: "bold" }}>
                            {oddsLabel}
                          </td>
                          <td style={{ padding: "8px 10px", textAlign: "center", color: tierColor, fontWeight: "bold" }}>
                            {r.tier === "S" ? "S-TIER" : "A-TIER"}
                          </td>
                          <td style={{ padding: "8px 10px", textAlign: "right", color: tierColor, fontWeight: "bold" }}>
                            {r.confidence}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Justifications (expandable) */}
                <div style={{ marginTop: 16 }}>
                  {results.top_10.map((r, i) => (
                    <div
                      key={i}
                      style={{
                        background: r.tier === "S" ? "#2a2200" : "#002218",
                        border: `1px solid ${r.tier === "S" ? "#FFD70044" : "#00FF8844"}`,
                        marginBottom: 8,
                        padding: "10px 14px",
                        fontSize: 11,
                        lineHeight: 1.6,
                        color: "#c8d8e8",
                      }}
                    >
                      <div style={{ marginBottom: 4, fontWeight: "bold", color: r.tier === "S" ? "#FFD700" : "#00FF88" }}>
                        #{i + 1} {r.player} - {r.prop_type} {r.verdict} ({r.line}) - {r.tier === "S" ? "S-TIER" : "A-TIER"} {r.confidence}%
                      </div>
                      <div style={{ color: "#8ab0cc" }}>{r.justification}</div>
                    </div>
                  ))}
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
                <div>No S-Tier or A-Tier picks found for the selected filters.</div>
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
