import { useState, useCallback, useMemo } from "react";
import playersData from "../data/players.json";
import { STATS } from "../api/lib/prop-types.js";

const NBA_PLAYERS = Object.keys(playersData);

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

const SORTED_PLAYERS = [...NBA_PLAYERS].sort();

export default function App() {
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

  const allStatsSelected = selectedStats.length === STATS.length;

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    if (!q) return SORTED_PLAYERS;
    return SORTED_PLAYERS.filter((p) => p.toLowerCase().includes(q));
  }, [playerQuery]);

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
    setAnalyzing(true);

    try {
      const body = { player, statTypes: selectedStats };
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
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setAnalyzing(false);
    }
  }, [player, selectedStats, direction]);

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
            NBA PRIZEPICKS
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
            {analyzing ? "ANALYZING..." : "ANALYZE ALL LINES"}
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
              <span>S/A Tier: {results.total_s_a} picks</span>
              <span>Showing: {Math.min(results.top_10?.length || 0, 10)} results</span>
            </div>

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
                No S-Tier or A-Tier picks found for the selected filters.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
