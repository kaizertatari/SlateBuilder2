import { useState, useCallback, useMemo } from "react";
import playersData from "../data/players.json";

const NBA_PLAYERS = Object.keys(playersData);

const STATS = ["Points", "Rebounds", "Assists", "PRA", "PR", "PA", "3-Pointers Made"];
const DIRECTIONS = ["Over", "Under"];

const TIER_CONFIG = {
  S: { color: "#FFD700", bg: "#2a2200", label: "S-TIER", glow: "0 0 20px #FFD70066" },
  A: { color: "#00FF88", bg: "#002218", label: "A-TIER", glow: "0 0 20px #00FF8866" },
  B: { color: "#4488FF", bg: "#001133", label: "B-TIER", glow: "0 0 20px #4488FF66" },
  SKIP: { color: "#FF4444", bg: "#220000", label: "SKIP", glow: "0 0 20px #FF444466" },
};

const VERDICT_CONFIG = {
  OVER: { color: "#00FF88", symbol: "▲" },
  UNDER: { color: "#FF6644", symbol: "▼" },
  SKIP: { color: "#888888", symbol: "✕" },
};

const SORTED_PLAYERS = [...NBA_PLAYERS].sort();

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

export default function App() {
  const [player, setPlayer] = useState("");
  const [stat, setStat] = useState("");
  const [direction, setDirection] = useState("");
  const [line, setLine] = useState("");
  const propType = stat && direction ? `${stat} ${direction.toUpperCase()}` : "";
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [playerHighlight, setPlayerHighlight] = useState(0);

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

  const analyze = useCallback(async () => {
    if (!player || !propType || !line) {
      setError("Fill in all fields.");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player, propType, line }),
      });

      const data = await response.json();

      if (data.error) throw new Error(data.error);
      if (!response.ok) throw new Error(data.error || "Request failed");

      setResult(data);
    } catch (e) {
      setError(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [player, propType, line]);

  const tierCfg = result ? TIER_CONFIG[result.tier] || TIER_CONFIG.SKIP : null;
  const verdictCfg = result ? VERDICT_CONFIG[result.verdict] || VERDICT_CONFIG.SKIP : null;
  // SKIPs that came from data unavailability (orchestrator-level early exit OR
  // missing-required-fields) have data_used: null. Gemini-level "I analyzed
  // this and reject it" SKIPs include data_used and render in the standard panel.
  const isUnable = result?.tier === "SKIP" && !result?.data_used;
  const missingFlags = (result?.flags ?? []).filter((f) => /missing:/i.test(f));
  const otherFlags = (result?.flags ?? []).filter((f) => !/missing:/i.test(f));
  const winProbDisplay = (() => {
    const wp = result?.data_used?.win_prob;
    if (wp == null) return "—";
    return (wp <= 1 ? Math.round(wp * 100) : Math.round(wp)) + "%";
  })();

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
            MODEL v3.3
          </div>
          <div style={{ fontSize: 11, color: "#446688", marginTop: 4 }}>
            PLAYOFF CALIBRATED · LIVE DATA · ALL RULES APPLIED
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
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
                  if (player && playerQuery !== player) setPlayerQuery(player);
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
              {playerOpen && (
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
                  {filteredPlayers.length === 0 ? (
                    <li style={{ padding: "10px 12px", fontSize: 12, color: "#446688" }}>
                      no matches
                    </li>
                  ) : (
                    filteredPlayers.map((p, i) => (
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
                    ))
                  )}
                </ul>
              )}
            </div>

            <select
              value={stat}
              onChange={(e) => setStat(e.target.value)}
              style={selectStyle}
            >
              <option value="">— SELECT PROP —</option>
              {STATS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              style={selectStyle}
            >
              <option value="">— OVER / UNDER —</option>
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input
              type="number"
              step="0.5"
              placeholder="LINE (e.g. 26.5)"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              style={{
                ...selectStyle,
                width: 160,
                flex: "none",
              }}
            />

            <button
              onClick={analyze}
              disabled={loading}
              style={{
                background: loading ? "#1a2a3a" : "#0066cc",
                color: loading ? "#446688" : "#ffffff",
                border: "1px solid " + (loading ? "#1e3040" : "#0088ff"),
                padding: "10px 28px",
                fontFamily: "'Courier New', monospace",
                fontSize: 12,
                fontWeight: "bold",
                letterSpacing: 2,
                cursor: loading ? "not-allowed" : "pointer",
                transition: "all 0.15s",
              }}
            >
              {loading ? "FETCHING DATA..." : "ANALYZE"}
            </button>
          </div>
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

        {/* Loading state */}
        {loading && (
          <div style={{
            border: "1px solid #1e3040",
            padding: 24,
            textAlign: "center",
          }}>
            <div style={{ color: "#4488aa", fontSize: 11, letterSpacing: 3, marginBottom: 8 }}>
              RUNNING MODEL
            </div>
            <div style={{ color: "#446688", fontSize: 11 }}>
              Fetching live stats · injury report · win probability · matchup data
            </div>
            <div style={{ color: "#446688", fontSize: 11, marginTop: 4 }}>
              Applying all framework rules silently...
            </div>
          </div>
        )}

        {/* UNABLE panel — orchestrator early-skip or missing-required-fields */}
        {result && isUnable && (
          <div style={{
            border: "1px solid #FFA50044",
            background: "#2a1a00",
            boxShadow: "0 0 20px #FFA50033",
          }}>
            <div style={{
              background: "#FFA50018",
              borderBottom: "1px solid #FFA50044",
              padding: "14px 20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: "bold", color: "#FFA500", letterSpacing: 2 }}>
                  UNABLE TO ANALYZE
                </div>
                <div style={{ fontSize: 11, color: "#cc8833", letterSpacing: 2, marginTop: 2 }}>
                  DATA UNAVAILABLE
                </div>
              </div>
            </div>

            <div style={{
              padding: "10px 20px",
              borderBottom: "1px solid #1e3040",
              fontSize: 12,
              color: "#7799bb",
              letterSpacing: 1,
            }}>
              {player} · {propType} {line}
            </div>

            <div style={{ padding: "16px 20px", borderBottom: missingFlags.length > 0 ? "1px solid #1e3040" : undefined }}>
              <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                REASON
              </div>
              <div style={{ fontSize: 13, color: "#c8d8e8", lineHeight: 1.6 }}>
                {result.justification}
              </div>
            </div>

            {missingFlags.length > 0 && (
              <div style={{ padding: "12px 20px" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  MISSING DATA
                </div>
                {missingFlags.map((f, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#FFA500", marginBottom: 4 }}>
                    • {f.replace(/^⚠️\s*missing:\s*/i, "")}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Standard tier panel — verdict + tier card */}
        {result && !isUnable && tierCfg && verdictCfg && (
          <div style={{
            border: `1px solid ${tierCfg.color}44`,
            background: tierCfg.bg,
            boxShadow: tierCfg.glow,
          }}>
            {/* Verdict bar */}
            <div style={{
              background: tierCfg.color + "18",
              borderBottom: `1px solid ${tierCfg.color}44`,
              padding: "14px 20px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{
                  fontSize: 28,
                  fontWeight: "bold",
                  color: verdictCfg.color,
                  lineHeight: 1,
                }}>
                  {verdictCfg.symbol}
                </span>
                <div>
                  <div style={{ fontSize: 18, fontWeight: "bold", color: verdictCfg.color, letterSpacing: 2 }}>
                    {result.verdict}
                  </div>
                  <div style={{ fontSize: 11, color: tierCfg.color, letterSpacing: 2, marginTop: 2 }}>
                    {tierCfg.label}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 32, fontWeight: "bold", color: tierCfg.color, lineHeight: 1 }}>
                  {result.confidence}%
                </div>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 1 }}>CONFIDENCE</div>
              </div>
            </div>

            {/* Prop label */}
            <div style={{
              padding: "10px 20px",
              borderBottom: "1px solid #1e3040",
              fontSize: 12,
              color: "#7799bb",
              letterSpacing: 1,
            }}>
              {player} · {propType} {line}
            </div>

            {/* Justification */}
            <div style={{ padding: "16px 20px", borderBottom: "1px solid #1e3040" }}>
              <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                ANALYSIS
              </div>
              <div style={{ fontSize: 13, color: "#c8d8e8", lineHeight: 1.6 }}>
                {result.justification}
              </div>
            </div>

            {/* Flags (excluding missing-data flags, which only appear in the UNABLE panel) */}
            {otherFlags.length > 0 && (
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e3040" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  ACTIVE FLAGS
                </div>
                {otherFlags.map((f, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#ffaa44", marginBottom: 4 }}>
                    {f}
                  </div>
                ))}
              </div>
            )}

            {/* Data used */}
            {result.data_used && (
              <div style={{ padding: "12px 20px" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  DATA SNAPSHOT
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                }}>
                  {[
                    ["SEASON AVG", result.data_used.season_avg],
                    ["L5 AVG", result.data_used.l5_avg],
                    ["WIN PROB", winProbDisplay === "—" ? null : winProbDisplay],
                    ["LOCATION", result.data_used.home_away?.toUpperCase() || null],
                    ["OPP", result.data_used.opponent],
                    ["CONTEXT", result.data_used.game_context],
                  ].map(([label, val]) => val && (
                    <div key={label} style={{
                      background: "#0a1420",
                      border: "1px solid #1e3040",
                      padding: "8px 10px",
                    }}>
                      <div style={{ fontSize: 9, color: "#446688", letterSpacing: 1, marginBottom: 3 }}>
                        {label}
                      </div>
                      <div style={{ fontSize: 12, color: "#8ab0cc" }}>
                        {String(val)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}