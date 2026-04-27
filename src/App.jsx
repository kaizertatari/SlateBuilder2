import { useState, useCallback } from "react";

const NBA_PLAYERS = [
  "Jalen Brunson", "Karl-Anthony Towns", "OG Anunoby", "Mikal Bridges", "Josh Hart",
  "Jalen Johnson", "Dyson Daniels", "CJ McCollum", "Nickeil Alexander-Walker", "Onyeka Okongwu",
  "Victor Wembanyama", "LaMelo Ball", "Shai Gilgeous-Alexander", "Donovan Mitchell",
  "Evan Mobley", "Jarrett Allen", "Devin Booker", "Paolo Banchero", "Cooper Flagg",
  "Moussa Diabate", "James Harden", "Kon Knueppel", "Kevin Durant", "Giannis Antetokounmpo",
  "Jayson Tatum", "Jaylen Brown", "Anthony Davis", "LeBron James", "Stephen Curry",
  "Nikola Jokic", "Joel Embiid", "Damian Lillard", "Trae Young", "Luka Doncic",
  "Anthony Edwards", "Cade Cunningham", "Tyrese Haliburton", "Darius Garland",
  "De'Aaron Fox", "Zach LaVine", "Julius Randle", "DeMar DeRozan", "Jimmy Butler",
  "Bam Adebayo", "Tyler Herro", "Scottie Barnes", "RJ Barrett", "Franz Wagner",
  "Alperen Sengun", "Fred VanVleet"
];

const PROP_TYPES = [
  "Points OVER", "Points UNDER",
  "Rebounds OVER", "Rebounds UNDER",
  "Assists OVER", "Assists UNDER",
  "PRA OVER", "PRA UNDER",
  "PR OVER", "PR UNDER",
  "PA OVER", "PA UNDER",
  "3-Pointers Made OVER", "3-Pointers Made UNDER"
];

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

export default function App() {
  const [player, setPlayer] = useState("");
  const [propType, setPropType] = useState("");
  const [line, setLine] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

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
            <select
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              style={selectStyle}
            >
              <option value="">— SELECT PLAYER —</option>
              {NBA_PLAYERS.sort().map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <select
              value={propType}
              onChange={(e) => setPropType(e.target.value)}
              style={selectStyle}
            >
              <option value="">— SELECT PROP —</option>
              {PROP_TYPES.map((p) => (
                <option key={p} value={p}>{p}</option>
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

        {/* Footer */}
        <div style={{
          marginTop: 32,
          paddingTop: 12,
          borderTop: "1px solid #0e1f2a",
          fontSize: 10,
          color: "#223344",
          letterSpacing: 1,
        }}>
          MODEL RECORD (tracked): 14–6 OVER · 0–0 UNDER · PLAYOFF TRACKING BEGINS v3.3
        </div>
      </div>
    </div>
  );
}

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