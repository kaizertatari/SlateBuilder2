# PrizePicks Model v3.5 — Portable Framework Spec

Self-contained specification of the v3.5 NBA/WNBA PrizePicks model. Written so it can be lifted into another project that currently runs v3.3 without needing to read this repo's code. Source of truth in this repo: `api/_lib/framework.js`, `api/_lib/league-config.js`, `api/_lib/weighted-l5.js`.

---

## 1. What changed from v3.3

If your target project is v3.3, these are the deltas you must implement. Everything else in v3.3 still applies as a baseline.

**Tier system (v3.4 rework, kept in v3.5)**
- S: 82–90% confidence (playoff floor 85%)
- A: 70–81%
- **B: 62–69% — verdict still issued, but a mandatory SKIP advisory flag is attached. B-tier is informational; the operator decides.**
- SKIP: <62% or hard-gate failure.
- In v3.3, B-tier was either absent or treated as "skip." In v3.5 the verdict is emitted with a `⚠️ B-tier confidence band — model recommends SKIP (B-tier hit 29.6% in v3.3 sample)` flag.

**New / changed rules**
- **Rule 5a addendum — Variance-Adjusted OVER buffer.** Standard buffer is 1.5 pts below road-adjusted baseline; when per-player ppg σ exceeds the league threshold, widen the buffer.
- **Rule 5b.i — Foul-prone matchup rebound suppressor** (new).
- **Rule 5b.ii — Shooting-slump rebound suppressor** (new).
- **Rule 5f — Pre-tip blowout-projection override** for series-tied playoff games (new).
- **Rule 5h — FT-leak modifier with two-tier gating** (named matchup vs team-rank proxy) replaces v3.3's "skip if no named defender."
- **Rule 5i — FT-Floor Insurance Guard** for UNDER on Points/PRA (new hard gate).
- **Rule 6 — Injury-type modulation** (parse body-region keywords for adjustments) (new).
- **Rule 3a — Home/road split sample minimum** (new): treat splits as structural baseline only with ≥3 games at that location.
- **Weighted L5 (v3.5).** L5 baselines used by 5a, 5f, S-tier gate item 4, and the L5-vs-season tiebreaker switch from raw to a recency-/opponent-/outlier-weighted L5 when available. Game-level reads (5b.ii, 4c) still use raw values.
- **Game 1 playoff exception.** Verdict still issued at B-tier max with SKIP advisory; exception: UNDER via Mechanism 1 (confirmed minutes restriction) goes A-tier max with no SKIP advisory.

**Cross-rule mechanics**
- Suppressor stacking: 2+ active suppressors drop one additional tier beyond the highest-priority cap.
- 5h FT-leak modifier is now independent of 5i; FT scoring is gated only by 5i, not by defensive assignment.

---

## 2. Required input data structure

The framework consumes a `groundTruth` object. Below is the minimum schema. Fields can be `null` when unavailable — the rules below specify the fallback behaviour for each.

```jsonc
{
  "player": {
    "name": "Player Name",
    "team_abbr": "BOS",
    "position": "G"            // "G" | "F" | "C" | null
  },
  "opponent_team": { "abbr": "MIA" },
  "prop": { "stat": "PTS", "line": 24.5 },  // PTS, PRA, PR, PA, REB, AST, 3PM, etc.
  "venue": "road",             // "home" | "road"

  "season": {
    "averages": {
      "ppg": 24.3, "rpg": 5.1, "apg": 4.7,
      "fga": 17.2, "fgm": 8.4,
      "fta": 5.6,  "ftm": 4.9, "ft_pct": 0.875,
      "minutes": 34.1, "pra": 34.1
    }
  },

  "l5": {
    "averages": { "ppg": 26.1, "rpg": 5.4, "apg": 5.0, /* ... */ },
    "games": [                 // newest first, length up to 5
      {
        "matchup": "BOS @ MIA",
        "pts": 28, "reb": 6, "ast": 5,
        "fgm": 10, "fga": 19, "ftm": 6, "fta": 7,
        "blk": 1, "stl": 2, "tov": 3,
        "minutes": 36, "pra": 39,
        "fg_pct": 0.526
      }
    ],
    "weighted": {              // v3.5 — see section 7
      "averages": { /* same shape as l5.averages */ },
      "raw_vs_weighted_delta": { "ppg": -1.2, "rpg": 0.3, "apg": 0.0, "pra": -0.9 },
      "outlier_present": false,
      "mode": "regular"        // "regular" | "playoff_series" | "playoff_raw_fallback"
    }
  },

  "splits": {                  // Rule 3a
    "home": { "games": 4, "ppg": 25.8, /* ... */ },
    "road": { "games": 3, "ppg": 22.1, /* ... */ }
  },

  "variance": { "ppg_stddev": 7.2 },   // null when sample <8 games

  "opponent_defense": {
    "def_rank": 6,             // 1=best D, 30=worst (12 for WNBA)
    "primary_defender": {
      "name": "Defender Name",
      "share_pct": 0.42,       // share of possessions guarded
      "n_games": 4,
      "confirmed": true        // true iff share_pct >= 0.40 AND n_games >= 2
    }
  },

  "injuries": {
    "player_team": [ { "name": "Teammate A", "status": "OUT", "detail": "knee" } ],
    "opponent":    [ { "name": "Opp Big",   "status": "DOUBTFUL", "detail": "ankle" } ]
  },

  "win_prob": 0.62,            // team win probability, 0..1

  "series": {                  // playoff only; nulls in regular season
    "leading_team_abbr": null, // null when tied
    "player_team_wins": 0,
    "opponent_wins": 0,
    "game_number": 1,
    "games_played": 0
  },

  "derived": {
    // Per-position worst-case FG floor vs elite D (Rule 5i).
    // NBA: G=6, F=8, C=10. WNBA: G=4, F=6, C=8. Fall back to F when position unknown.
    "ft_floor_baseline": 8
  }
}
```

---

## 3. Tier definitions

| Tier | Regular season | Playoffs | Behaviour |
|------|----------------|----------|-----------|
| S    | 82–90%         | 85–90%   | Highest conviction. Must clear S-tier gate (Section 8). |
| A    | 70–81%         | 70–81%   | Default tier when suppressors are clean and signals align. |
| B    | 62–69%         | 62–69%   | **Verdict still issued**, but include flag: `⚠️ B-tier confidence band — model recommends SKIP (B-tier hit 29.6% in v3.3 sample)`. |
| SKIP | <62%           | <62%     | No verdict, or hard-gate failure. |

---

## 4. Hard gates (cannot be bypassed)

Evaluate these first. Any failure caps or kills the pick regardless of other signals.

1. **Post-injury return gate (Rule 6).** First 5 games back from an injury = A-tier max. For "lower leg / Achilles," defer all picks for the first 10 games back (hard SKIP).
2. **Assist win-probability gate (Rule 5c).** Assists props require team win probability ∈ [0.35, 0.80]. Outside band → SKIP.
3. **Multi-star compression (Rule 4c).** 3rd or 4th scorer on team with 3+ players at ≥15 PPG, favoured ≥10 → A-tier max. Compounds with Rule 5f → B-tier max + SKIP advisory.
4. **UNDER mechanism gate (Rule 5g).** No named mechanism (Section 5) → SKIP, never UNDER.
5. **Sole-alpha boost active (Rule 4b).** UNDER invalid on that player.
6. **Game 1 (playoffs).** B-tier max baseline + mandatory SKIP advisory. Exception: UNDER via Mechanism 1 only → A-tier max, no SKIP advisory.
7. **Game 2 (playoffs).** A-tier max on ALL props both directions.
8. **Rule 5i FT-Floor Insurance Guard** (see Section 6). UNDER on Points/PRA invalid when player's FT-protected floor exceeds line.

---

## 5. UNDER mechanism gate (Rule 5g)

To issue an UNDER, identify at least one mechanism. Rule 5i must clear first for Points/PRA UNDER.

| Mechanism | Description | Solo cap |
|-----------|-------------|----------|
| 1. Minutes Compression | Confirmed minutes restriction or rest designation | A max |
| 2. Role Compression    | Documented teammate availability compressing opportunities | B max + SKIP advisory |
| 3. Matchup Ceiling     | Opponent top-5 in specific defensive metric. Unavailable when `opponent_defense` is null. | B max + SKIP advisory |

Stacking:
- 3 mechanisms = S possible
- 2 mechanisms = A max
- 1 mechanism alone = caps above
- 0 mechanisms = SKIP

---

## 6. Rule reference (full v3.5)

### Rule 3a — Home/road split sample minimum
Use `splits.home` / `splits.road` as a structural baseline ONLY when based on ≥3 games at that location. With fewer than 3 samples, blend the split toward season average (50/50 weight). Avoids small-sample inflation.

### Rule 4b — Sole alpha boost
When a player is the sole high-volume scorer with no other teammate averaging 15+ PPG available, apply an OVER boost. **UNDER invalid on that player when 4b is active.**

### Rule 4c — Multi-star compression
3rd/4th scorer on a team with 3+ players at ≥15 PPG, favoured 10+ → A-tier max. Compounds with 5f → B-tier max + SKIP advisory. Reads raw L5 / season averages, not weighted L5.

### Rule 5a — Road deduction + variance-adjusted OVER buffer
- **Road deduction.** On road games, subtract `road_deduction_pts` from season avg and L5 avg before line comparison on scoring props. NBA = 1.5, WNBA = 1.2.
- **OVER buffer.** Line must be ≥1.5 pts BELOW road-adjusted baseline.
- **Poor FT shooters (<70%).** Add extra 2 pt buffer.
- **Variance-Adjusted Buffer (addendum).** If `variance.ppg_stddev` is non-null AND > league threshold (NBA = 6.0, WNBA = 5.0), widen OVER buffer:
  ```
  buffer = 1.5 + 0.25 × (ppg_stddev − variance_threshold_ppg)
  ```
  Applies to Points-family props (PTS, PRA, PR, PA). Cite σ in justification. If σ is null (sample <8 games), use baseline 1.5.

### Rule 5b — Rebound suppressors (v3.4 extension)
- **5b.i Foul-Prone Matchup.** When `injuries.player_team` OR `injuries.opponent` lists 2+ frontcourt players (C/PF, inferred from name as general-knowledge position data) with mobility-limiting designations (knee/back/ankle/hip), reduce rebound expectation by 1.5 boards before line comparison. Name the cited injured frontcourt players in the justification.
- **5b.ii Shooting-Slump.** When player has shot `fg_pct < 0.35` in 2+ of `l5.games[]`, apply −15% suppressor on rebound OVER. Reads raw game-level `fg_pct`.

### Rule 5c — Assist win-probability gate
Assists props require team win probability ∈ [0.35, 0.80]. Outside band → SKIP. (Hard gate.)

### Rule 5f — Win-probability blowout suppressor
- 85–90% win prob: A-tier max OVER.
- >90% win prob: A-tier max OVER, require line 3+ below L5 avg.
- **Playoff series tied** (`series.leading_team_abbr === null`): suppressor DISABLED — except when the pre-tip override fires.
- **Player's team leads 3–0 or 3–1**: suppressor FULLY ENGAGED on this player's OVER.
- **Opponent leads 3–0 or 3–1**: suppressor DISABLED (trailing team plays desperate).

**Pre-tip blowout-projection override (series-tied games only).** When ALL three hold pre-tip — (a) leading team's win prob ≥ 0.80, (b) opposing team has 2+ starters listed OUT/DOUBTFUL in `injuries.opponent`, (c) leading team is at home — treat as if win_prob ≥ 0.90 and apply >90% rules regardless of actual figure.

### Rule 5g — UNDER mechanism gate
See Section 5.

### Rule 5h — FT-leak modifier (two-tier gating)
Target must average `season.averages.fta ≥ 5` regardless of tier.

- **Tier 1 (named matchup confirmed).** `opponent_defense.primary_defender` non-null with `confirmed=true` (share_pct ≥ 0.40, n_games ≥ 2). Apply full **20–25% FG-output reduction**. Cite defender + share in justification (e.g., "Tatum primary defender, 0.42 share over 4 GP").
- **Tier 2 (team-rank proxy).** `primary_defender` null OR `confirmed=false`, AND `opponent_defense.def_rank ≤ 3`. Apply lighter **10–15% FG-output reduction** and add flag `⚠️ 5h applied via team-rank proxy (no named-defender data)`.
- **Do not invoke.** `primary_defender` null AND `def_rank > 3` → 5h does not apply.

FT scoring is independent of defensive assignment in all tiers and is gated only by Rule 5i. Do not issue UNDER on this player without clearing 5i first.

In playoffs, if `opponent_defense` is entirely absent, do NOT skip — cap pick at A-tier max and add `⚠️ no defensive matchup data (5h capped)`.

### Rule 5i — FT-Floor Insurance Guard (UNDER picks)
For Points/PRA UNDER on a player with `season.averages.fta ≥ 5`:

```
ft_floor_pts = season.averages.fta × season.averages.ft_pct
total_floor  = ft_floor_pts + derived.ft_floor_baseline
```

`ft_floor_baseline` is per-position worst-case FG floor vs elite D (G/F/C lookup; fall back to F when position unknown). NBA: G=6, F=8, C=10. WNBA: G=4, F=6, C=8.

- `total_floor ≥ line`: **UNDER INVALID** (regardless of 5h suppression). verdict = SKIP.
- `total_floor < line − 2`: UNDER valid (5g mechanism still required).
- `line − 2 ≤ total_floor < line`: UNDER A-tier max, requires Mechanism 1 OR 2 confirmed.

**Mechanism 1 override.** If confirmed minutes restriction R < ⌊game_minutes × 30 / 48⌋ (NBA: 30, WNBA: 25), scale `ft_floor_pts × (R / ⌊game_minutes × 32 / 48⌋)` (NBA: 32, WNBA: ~27) and recompute `total_floor`.

### Rule 6 — Post-injury return + injury-type modulation
- **Base gate.** First 5 games back from injury = A-tier max.
- **Body-region modulation** (parse `injuries.player_team[].detail`):
  - **rib / oblique / back**: −20% rebound floor; rebound OVER A-tier max.
  - **shoulder / elbow**: +25% variance on points; 3PM OVER → SKIP.
  - **hand / wrist**: treat FT% as L5 not season; 3PM OVER → SKIP.
  - **knee / ankle**: post-injury gate AND −1 reb floor.
  - **lower leg / Achilles**: defer all picks first 10 games back; hard SKIP override.
- If `detail` is empty or generic, apply post-injury gate at default A-tier max with no body-part adjustment.

---

## 7. Weighted L5 (v3.5)

The L5 baseline used for Rule 5a, Rule 5f, S-tier gate item 4, and the L5-vs-season tiebreaker is `l5.weighted.averages` when present, otherwise `l5.averages`. Game-level reads (Rule 5b.ii, Rule 4c) continue to use raw values.

When the chosen L5 baseline and season avg conflict by 3+ pts, **L5 governs**.

### Computation

Each of the 5 most-recent games gets a composite weight:

```
weight_i = recency_i × (opponent_i OR series_i) × outlier_i
```

- **Recency ramp** (newest → oldest): `[0.30, 0.25, 0.20, 0.15, 0.10]`.
- **Opponent quality** (regular season):
  - def_rank ≤ 5 → 1.15
  - 6–15 → 1.00
  - 16–25 → 0.90
  - ≥26 → 0.80
  - null → 1.00
- **Series-game modifier** (playoffs, used in place of opponent quality):
  - Series game 1–2 → 0.75
  - 3–4 → 1.00
  - 5+ → 1.20
- **Outlier dampener** (vs season ppg):
  - pts > 1.5 × season_ppg → 0.60 (hot outlier)
  - pts < 0.50 × season_ppg → 0.85 (cold outlier)
  - else → 1.00

Weights are normalized to sum to 1.0; weighted averages computed across `ppg, rpg, apg, fgm, fga, ftm, fta, blk, stl, tov, minutes, pra`. Then derive `pr = ppg+rpg`, `pa = ppg+apg`, `ra = rpg+apg`, `pra = ppg+rpg+apg`.

### Modes
- `regular`: regular season; opponent_quality multiplier used.
- `playoff_series`: playoff; series-game multiplier used. Identify which L5 games are vs current opponent (oldest-first ordinal numbering), assign series-game numbers; non-series leftovers get series multiplier 1.00.
- `playoff_raw_fallback`: playoff but <3 of L5 games vs current opponent. The series multiplier is neutralized (no usable series signal), but recency + outlier dampening still apply — those axes are orthogonal to series sampling. Earlier versions of v3.5 returned raw averages here; current impl computes the weighted mean with `perGameMultipliers = 1.0`. Mode name preserved for Axiom continuity.

### Trimmed averages (drop-max)
`l5.weighted.trimmed_averages` carries the same headline-stat shape as `averages` but with the single highest game (per field) dropped before computing the weighted mean. Used by Rule 5a as a sanity check on OVER: if the full baseline clears the line but the trimmed baseline doesn't clear it by `buffer`, one game is doing the heavy lifting and S-tier is capped at A. Drop-max keys off the *target field* rather than `pts`, so Fantasy-Score-style anomalies (where reb/ast/stl carry the composite while pts stays normal) are caught even when `outlier_present` doesn't fire.

### Diagnostic flags (mandatory when triggers fire)
- If `|l5.weighted.averages.ppg − l5.averages.ppg| ≥ 2`: `⚠️ weighted L5 diverges from raw L5 by Xpts — outlier distortion detected` (X = abs delta, 1 dp).
- If `l5.weighted.outlier_present === true`: OVER buffer in Rule 5a widens from 1.5 to 2.5 pts on this pick, and add `⚠️ post-outlier window — buffer widened to 2.5 pts`.
- If `l5.weighted.mode === "playoff_raw_fallback"`: emit `⚠️ small playoff sample — weighted L5 deferred to raw L5`, proceed with weighted L5 (recency + outlier multipliers applied, series multiplier neutralized).
- If Rule 5a sees `trimmedAdjusted - line < buffer`: emit `⚠️ Rule 5a — trimmed L5 (X) doesn't clear line by buffer; S-tier capped at A` and set `tier_cap = "A"`.

Both divergence and outlier flags are independent and can fire on the same pick.

---

## 8. S-tier gate

All six must pass for S-tier:

1. Line clears 1.5 pt buffer after road deduction (use 2.5 pt buffer if outlier-window flag fired).
2. 3+ independent signals align.
3. No active suppressor flag.
4. Confidence scores above BOTH season avg AND L5 avg (weighted L5 if present).
5. (Playoff only) Confidence ≥ 85%.
6. (Playoff only) Game 3+ in series.

Failing any single item → A-tier max.

---

## 9. Suppressor stacking + tiebreaker

- Two or more suppressors active → drop one additional tier beyond highest-priority cap (S→A→B→SKIP). When the stack lands at B, the SKIP advisory flag is mandatory.
- **Tiebreaker.** Suppressor > boost when in conflict.
- **Suppressor priority (high → low):** Rule 6 → 4c → 4i → 5f → 5c.
- **Boosts (4b sole alpha)** apply only after all suppressors are clean.
- **For UNDERs:** 4b active = UNDER invalid on that player.

---

## 10. Playoff mode

Active when the league postseason is ongoing. Series lengths:

| League | First round | Semis | Conf finals | Finals |
|--------|-------------|-------|-------------|--------|
| NBA    | 7           | 7     | 7           | 7      |
| WNBA   | 3           | 5     | 5           | 7      |

- **Game 1.** Verdict still issued but B-tier max baseline + `⚠️ Game 1 — model recommends SKIP (Game 1 hit 18.8% in v3.3 sample)`. **Exception:** UNDER via Mechanism 1 only → A-tier max, no SKIP advisory.
- **Game 2.** A-tier max ALL props both directions.
- **Game 3+.** Standard playoff rules.
- **S-tier floor 85%** in playoffs (vs 82% regular season).
- **Rule 5h.** If `opponent_defense` is absent, do NOT skip — cap pick at A-tier max and add `⚠️ no defensive matchup data (5h capped)`.

**Play-In Tournament is NOT a playoff series.** v3.3-era playoff-specific rules (Game Number Modifier, series-score modifier on 5f, named-defender 5h) do NOT apply. Treat as high-stakes regular season. Post-injury return gate still applies in full — unrestricted-minutes confirmation required, else A-tier max.

---

## 11. Pre-pick checklists (silent, before output)

### OVER checklist
1. Apply road deduction (5a) if road game.
2. Apply variance-adjusted buffer if σ > threshold.
3. Check 5f win-prob suppressor; if blowout window, cap to A-tier max.
4. Apply 5h FT-leak modifier if FTA ≥ 5 AND (Tier 1 OR Tier 2 conditions met).
5. Apply 5b.i / 5b.ii on rebound props.
6. Apply 4b alpha boost only if all suppressors clean.
7. Apply weighted-L5 diagnostic flags.
8. Check S-tier gate; demote to A if any item fails.

### UNDER checklist
1. Confirm Rule 4b not active (else UNDER invalid).
2. Identify at least one 5g mechanism (else SKIP).
3. For Points/PRA: apply Rule 5i; if `total_floor ≥ line`, SKIP.
4. Apply 5h FT-leak modifier only to FG-side scoring (FT independent).
5. Apply 5b.i / 5b.ii on rebound UNDERs.
6. Apply post-injury Rule 6 modulation.
7. Apply weighted-L5 diagnostic flags.
8. Pick tier per mechanism count (Section 5).

---

## 12. Output format

Table only. Sorted S → A → B, by confidence % descending within tier. OVER and UNDER share one table. Max 10 picks. Do not pad. Conditional picks flagged with `⚠️` and a one-line confirmation note below.

```
| Rank | Player | Prop | Line | Tier | Confidence % | Brief Justification (2–3 sentences) |
```

Justifications must:
- Cite the specific rule that drove the tier cap when a suppressor fired (e.g., "5h Tier 1: Tatum primary defender, 0.42 share / 4 GP — FG output −22%").
- Cite the σ value when variance-adjusted buffer applied.
- Name the specific injured frontcourt players when 5b.i applies.
- NOT list historical data, player stats, or matchup probabilities beyond the rule cite.

---

## 13. League scaling values

Single source of truth for per-league constants. Mirror this into your target project's config.

| Constant | NBA | WNBA |
|----------|-----|------|
| `game_minutes` | 48 | 40 |
| `road_deduction_pts` (Rule 5a) | 1.5 | 1.2 |
| `variance_threshold_ppg` (Rule 5a addendum) | 6 | 5 |
| `ft_floor_by_position.G` (Rule 5i) | 6 | 4 |
| `ft_floor_by_position.F` | 8 | 6 |
| `ft_floor_by_position.C` | 10 | 8 |
| `playoff_series.first_round` | 7 | 3 |
| `playoff_series.semis` | 7 | 5 |
| `playoff_series.conf_finals` | 7 | 5 |
| `playoff_series.finals` | 7 | 7 |

WNBA: 40-minute games (vs NBA 48), per-game stat lines ~83% of NBA reference. Most thresholds scale proportionally.

---

## 14. Implementation order (recommended)

When porting to a v3.3 project, evaluate per-pick in this order:

1. **Compute weighted L5** (Section 7). Attach to groundTruth before evaluation.
2. **Hard-gate sweep** (Section 4). Any failure → cap or SKIP and short-circuit.
3. **Suppressors** — compute and stack:
   - Rule 6 injury modulation
   - Rule 4c multi-star compression
   - Rule 5f win-prob suppressor (including pre-tip override)
   - Rule 5c assist gate
   - Rule 5b rebound suppressors
   - Rule 5h FT-leak modifier
4. **For UNDER**: apply Rule 5i; if invalid → SKIP. Else, gate by 5g mechanism count.
5. **For OVER**: apply Rule 5a road deduction + variance-adjusted buffer.
6. **Apply boost** (Rule 4b) only when all suppressors clean.
7. **Suppressor-stacking demotion**: 2+ active → one additional tier drop.
8. **S-tier gate** (Section 8). If any item fails → A-tier max.
9. **Attach mandatory flags**: weighted-L5 divergence, outlier-window, 5h proxy, B-tier advisory, Game 1 advisory, 5h-capped (no def data), etc.
10. **Emit verdict** in table format (Section 12).

---

## 15. Things deliberately NOT in v3.5

- Per-game historical `def_rank` lookup (weighted L5 uses current-season snapshot as proxy).
- Empirical re-calibration of the recency ramp `[0.30, 0.25, 0.20, 0.15, 0.10]` — placeholder pending ~20 tracked v3.5 picks.
- Coefficient-fitted confidence + Kalman baseline (Phase 2/3, gated on ≥100 decided pick-log entries).

These are documented so a future port knows what's a known limitation vs. a missing feature.
