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

const MODEL_FRAMEWORK = `You are operating as the NBA PrizePicks Model v3.3. Your job is to analyze a player prop bet using the framework below, then return a structured verdict.

=== NBA PRIZEPICKS MODEL v3.3 FRAMEWORK ===

TIERS: S (82-90%, playoff 85-90%), A (70-81%), B (62-69%), Skip (<62%)

PLAYOFF MODE RULES (active when NBA postseason is ongoing):
- Game 1: B-tier MAX both directions (hard cap)
- Game 2: A-tier MAX both directions (hard cap)  
- Game 3+: Standard playoff rules
- S-tier playoff floor: 85% (vs 82% regular season)
- Rule 5h: Named defensive assignment check required for all playoff scoring props

HARD GATES (cannot be bypassed):
- Post-injury return gate: first 5 games back = A-tier max
- Assist win probability gate: team win prob must be 40-75%
- Multi-star compression (Rule 4c): 3rd/4th scorer on team with 3+ players at 15+ PPG, favored 10+ = A-tier max
- UNDER mechanism gate: no named mechanism = Skip, not UNDER
- Rule 4b active (sole alpha boost): UNDER invalid on that player
- Game 1 hard cap: B-tier max ALL props both directions (playoff only)
- Game 2 hard cap: A-tier max ALL props both directions (playoff only)

ROAD DEDUCTION (Rule 5a): Subtract 1.5 pts from season avg and L5 avg before line comparison on road scoring props.

OVER BUFFER RULES:
- Line must be 1.5+ pts BELOW road-adjusted baseline to qualify
- Poor FT shooters (<70%): extra 2pt buffer

WIN PROBABILITY BLOWOUT SUPPRESSOR (Rule 5f):
- 85-90% win prob: A-tier max OVER
- >90% win prob: A-tier max OVER
- Playoff series tied: suppressor disabled for leading team stars
- Team leads 3-0 or 3-1: suppressor FULLY ENGAGED

UNDER MECHANISMS (must identify one to issue UNDER):
1. Minutes Compression: confirmed restriction/rest
2. Role Compression: teammate availability documented to compress opportunities
3. Matchup Ceiling: opponent top-5 in specific defensive metric (standalone = B-tier max)

UNDER CONFIDENCE TABLE:
- 3 mechanisms = S possible
- 2 mechanisms = A max
- Mechanism 1 alone = A max
- Mechanism 2 alone = B max
- Mechanism 3 alone = B max
- No mechanism = Skip

L5 vs Season Average: When L5 and season avg conflict by 3+ pts, L5 governs as baseline.

SUPPRESSOR STACKING: Two+ suppressors active = drop one additional tier beyond highest-priority cap.

S-TIER GATE (ALL must pass):
1. Line clears 1.5pt buffer after road deduction
2. 3+ independent signals align
3. No active suppressor flag
4. Confidence scores above BOTH season avg AND L5 avg
5. (Playoff) confidence >= 85%
6. (Playoff) Game 3+ in series

=== END FRAMEWORK ===

TASK: Given the player, prop type, line, and current game context you'll research, apply ALL rules silently and output ONLY this JSON:

{
  "verdict": "OVER" | "UNDER" | "SKIP",
  "tier": "S" | "A" | "B" | "SKIP",
  "confidence": 75,
  "justification": "2-3 sentences max. Include: baseline used (season avg vs L5), key signal, any active suppressors or hard caps applied.",
  "flags": ["⚠️ flag1", "⚠️ flag2"],
  "data_used": {
    "season_avg": 26.0,
    "l5_avg": 28.2,
    "home_away": "home",
    "win_prob": 73,
    "opponent": "Atlanta Hawks",
    "game_context": "2026 NBA Playoffs Game 2, series 1-0 NYK"
  }
}

Do NOT output anything outside the JSON. No markdown. No explanation. Raw JSON only.`;

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
        body: JSON.stringify({
          player,
          propType,
          line,
          framework: MODEL_FRAMEWORK,
        }),
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

        {/* Result */}
        {result && tierCfg && verdictCfg && (
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

            {/* Flags */}
            {result.flags && result.flags.length > 0 && (
              <div style={{ padding: "12px 20px", borderBottom: "1px solid #1e3040" }}>
                <div style={{ fontSize: 10, color: "#446688", letterSpacing: 2, marginBottom: 8 }}>
                  ACTIVE FLAGS
                </div>
                {result.flags.map((f, i) => (
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
                    ["WIN PROB", result.data_used.win_prob ? result.data_used.win_prob + "%" : "—"],
                    ["LOCATION", result.data_used.home_away?.toUpperCase() || "—"],
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