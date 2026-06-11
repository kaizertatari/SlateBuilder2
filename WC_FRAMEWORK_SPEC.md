# World Cup 2026 Framework — Quant Spec (v1, market-led MVP)

Status: **spec finalized 2026-06-11** (tournament opener day). Scope decided
with user: market-led MVP, live picks, **Shots + Shots On Target only**,
FBref primary / ESPN-accrual fallback for baselines. Tournament window:
2026-06-11 → 2026-07-19 (104 matches; group stage ends 2026-06-27).

This is a one-off event framework. It reuses the engine's plumbing
(scrapers → odds store → ground truth → rules → finalizer → Axiom) but
**none of the basketball math**. Where v3.5 assumes Normal counting stats
with stable minutes, soccer requires Poisson tails and a minutes model.

---

## 1. Why basketball rules don't transfer

| Assumption (NBA/WNBA) | Soccer reality |
|---|---|
| Counting stats ≈ Normal (means 5–30) | Shots mean 0.5–4, SOT 0.2–1.5 → Poisson-like; Normal crossing is wrong in the tails where PP prices |
| Minutes stable for rotation players | Subs at ~60–75'; starters average ~78 of 90; minutes are the **dominant** variance source |
| L5 recency is the best baseline | National teams play ~10 matches/yr; recent sample is club football — different system, teammates, opposition |
| H2H matters | International H2H is noise (years apart, different squads) |
| Book O/U two-way prices → `devigTwoWay` | DK/FD price soccer props as **one-sided milestone ladders** ("2+ shots −650") — no under side exists |
| Game settles in 48/40 min + OT | **PrizePicks settles soccer on 90' + stoppage only — extra time excluded** (matters from the Round of 32 on) |

Consequently: the 19 basketball rule modules must no-op on WC ground truth;
a small soccer rule family replaces them.

## 2. Data sources (all verified live 2026-06-11)

| Source | What | Verified facts |
|---|---|---|
| PrizePicks API | Lines + identity | `league_id=241` "WORLD CUP" (6,559 projections live). Shots 1,318 / SOT 721. Player payload carries `team` (country), `position` (Forward/Midfielder/Defender/Goalkeeper), `ppid`. Also `457` "WORLD CUP TRNY" (tournament-long, **out of scope v1**), `458/459` 1H/2H (out of scope). |
| DraftKings nash | Sharp ladder prices | League **209533** ("World Cup 2026", 72 events seeded). Category **1113**, subcategories **16868 Player Shots** / **16861 Player Shots on Target** (1,050+ markets each, live). Ladders: `2+ −650, 3+ −200, …` one-sided. Team Total Goals = sub **19745**; match Total/Spread in base payload. Same `Referer` header auth as NBA/WNBA scrape. |
| ESPN site API | Fixtures, lineups, actuals | `soccer/fifa.world/scoreboard` (today's openers visible: event 760415 Mexico–South Africa). `summary?event=` exposes `rosters[]` → starters near kickoff, per-player stats (incl. shots/SOT) in-game/final. Feeds fixtures, the starter gate, tournament accrual, **and the outcome grader**. |
| FBref | Club per-90 priors | **403s plain fetch AND curl** (Cloudflare bot management) — must scrape via Playwright Chromium with a persistent profile (pattern already in `scripts/fetch-prizepicks-entries.mjs`). One page per league: Big-5 combined + MLS, Liga MX, Eredivisie, Primeira, Championship, Brasileirão, Argentina, Saudi, J1 ≈ 10 pages/snapshot, ≥4s apart. |
| FotMob | (was the chosen fallback) | API endpoints moved behind a signed `x-mas` header — **dead as a low-effort fallback**. Practical fallback = position priors + ESPN tournament accrual (§4.3). |

## 3. Stage 1 — market signal: ladder → Poisson fit

The ladder gives book-priced exceedance probabilities with margin baked in
and no opposite side to de-vig against. Recover a fair distribution by
fitting jointly:

- Implied prob per rung: `imp_k` from American odds (e.g. −650 → 0.867).
- Model: `imp_k ≈ c · P(X ≥ k | λ)` with X ~ Poisson(λ), `c` = one-sided
  overround multiplier, constrained `c ∈ [1.00, 1.15]`.
- Fit: profile least squares on log-probs. For fixed λ,
  `ĉ = clamp(exp(mean(ln imp_k − ln q_k)))`; minimize SSE over λ by
  golden-section on [0.05, 8]. Weight rungs by proximity to the PP line:
  `w_k = 1/(1 + |k − (line + 0.5)|)`.
- Degenerate cases: 1 rung → fix `c = 1.06` (initial league-wide prior;
  recalibrate from graded data) and solve λ exactly. 0 rungs → no market
  signal (hard gate, §6).
- Fair P(over PP line `k.5`) = `P(X ≥ k+1 | λ̂)` — PP half-lines land
  exactly on ladder rungs, so this is mostly a margin-corrected read of an
  observed price, not an extrapolation.

Sanity check from tonight's slate: Martinez (MEX) 2+ shots −650 / 3+ −200 →
λ̂ ≈ 3.2, ĉ ≈ 1.05 — internally consistent Poisson ladder.

**Empirical amendment (first live fit, 2026-06-11, n≈2,100 ladders):** the
fitted ĉ pegs at its 1.0 floor with tiny residuals (median rmse 0.021) —
DK's ladder IS a Poisson curve with the margin baked into λ, not a
probability-scaled one. The margin correction therefore moves to λ-space:
`λ_fair = λ̂ / (1 + POISSON_LAMBDA_MARGIN)` with 0.05 initial (a ~4-pt
one-sided margin at the coin-flip rung ÷ dP/dλ = pmf(k−1) ≈ 0.22 at λ≈3.5).
All pricing uses λ_fair; λ̂ is kept as a diagnostic. The 0.05 is calibration
item #1 for the group-stage checkpoint.

Stored per player-stat in `odds.json`: `{ stat, league:"WC", ladder:[{k,
american, implied}], lambda_fair, overround, fair_over, line }` — the
existing `lookupMarket` contract, plus the λ so any PP line can be priced.
The per-league line-shift slopes (`PER_LEAGUE_STAT_SLOPE`) are **not used**
for WC; the Poisson tail replaces them.

## 4. Stage 3 — model signal: exposure-scaled Poisson rate

`λ_model = r_p90 × (E[min]/90) × A_opp`

### 4.1 Rate prior `r_p90` (club, FBref)
Per-90 shots / SOT from the 2025-26 club season, shrunk toward position
priors with prior weight `n₀ = 5` effective matches:
`r_p90 = (n·r_club + n₀·r_pos) / (n + n₀)`, `n = min(minutes/90, 25)`.
Position priors (init; recalibrate): F 2.4, M 1.2, D 0.5 shots/90;
SOT = 0.36 × shots. Players with **no FBref row use the position prior
alone and are tier-capped** (§6) — the provenance-guard analog.

### 4.2 Minutes model `E[min]`
- Confirmed starter (ESPN roster posted ~1h pre-kickoff): 83.
- Expected starter (club minutes share ≥ 0.75 and PP posts a standard
  line): 78.
- Rotation risk / unknown: 55. Bench profile: 25.
- OVER verdicts additionally require `E[min] ≥ 60` (hard gate); UNDERs may
  use sub risk as a *suppressor-free* tailwind but v1 does not boost for it.

### 4.3 Opponent/environment adjustment `A_opp`
From DK team totals (a soccer team total **is** the market's expected
goals): `A_opp = (team_total / μ_tt)^0.6`, where `μ_tt` is the slate mean
team total and the 0.6 exponent damps goals→shots elasticity (shots scale
sub-linearly with goal environment). Clamped [0.75, 1.30]. No venue term —
all matches are neutral-site (host nations excepted; ignored in v1).

### 4.4 Tournament accrual
After each completed match, ESPN summary actuals append to a per-player WC
log. Blend: each WC match counts **3×** a club match in the shrinkage `n`
(same philosophy as `current_series_averages`). By the knockouts most
starters have 270+ WC minutes and the model stands on tournament data.

Model P(over k.5) = Poisson tail `P(X ≥ k+1 | λ_model)`. (Shots are mildly
overdispersed — NB with k≈10. v1 ships Poisson; overdispersion is a logged
calibration item, not a launch blocker.)

## 5. Verdict policy (market-led)

Both signals are probabilities on the same scale; the existing
`rule-market-edge` / `rule-projection` confirmation logic applies:

- **Primary edge** = `|fair_over − 0.5|` at the PP line (PP pays both sides
  of a 0.5-implied line). Direction = side of the market's fair prob.
- **Model as confirmer**: agreement (model and market on the same side,
  model edge ≥ 3pts) → confidence boost; conflict ≥ 8pts → suppressor;
  no model (no FBref row, prior-only) → A-tier cap.
- Tier mapping (initial, recalibrate after group stage):
  - S: market edge ≥ 8pts AND model agrees AND confirmed starter.
  - A: market edge ≥ 5pts AND no conflict AND E[min] gate passed.
  - B: market edge ≥ 3pts, or model-only edge ≥ 8pts with ladder present.
  - SKIP: everything else, or any hard gate (§6).

## 6. Hard gates (pre-filter, `pre_filtered: true`, mutually exclusive with rules_fired)

1. **No DK ladder** for the player-stat → SKIP (market-led framework; no
   market, no pick).
2. **Minutes**: OVER with `E[min] < 60` → SKIP.
3. **Dead rubber**: group match 3 where the player's team is already
   eliminated or already locked into its seed → SKIP OVERs (rotation +
   motivation risk). Best-effort from ESPN group standings; if standings
   unavailable, flag instead of gate.
4. **Settlement**: knockout matches — verdict text must carry the
   `90'+stoppage, no ET` note; no numeric adjustment (lines are priced on
   90' by books too). Gate nothing, flag always.
5. **Goalkeepers** for Shots/SOT → SKIP (PP posts them; they're noise).

## 7. Telemetry & calibration plan

- Verdicts log to Axiom `props_verdict` with `league:"WC"`, the standard
  `_market` block (now ladder-based: λ̂, ĉ, rungs used) and `_projection`
  (λ_model, E[min], A_opp, prior weight). Outcomes via the nightly grader
  reading ESPN summaries (validate stat keys on event 760415 tonight).
- `calibration-report.mjs` gains a WC slice: market reliability curve
  (ladder fair_over vs hit rate), model curve, and the agree/conflict
  split. **Checkpoint ~2026-06-20** (~30 matches, est. 150–250 graded
  verdicts): if the market curve is flat (no edge at PP's 0.5 pricing),
  tighten S/A thresholds or abstain — same abstain-or-EV policy as
  basketball.
- Initial parameters flagged for recalibration: `c` default 1.06, position
  priors, 0.6 elasticity, tier thresholds, Poisson vs NB.

## 8. Implementation map

| Piece | File | Note |
|---|---|---|
| Prop catalog | `api/_lib/prop-types.js` | "Shots", "Shots On Target" — league-scoped so basketball UI lists are unchanged |
| PP scrape | `scripts/scrape-prizepicks.mjs` | league 241; soccer identity passes through PP payload (players.json not involved) |
| DK ladder scrape + fit | `scripts/scrape-odds.mjs` | league 209533; ladder fit at scrape time; rides the existing 4×/day odds task unchanged |
| Market lookup | `api/_lib/odds.js` | WC path prices any line from stored λ̂; slopes untouched |
| Priors snapshot | `scripts/refresh-soccer-rates.mjs` → `data/soccer-rates.json` | Playwright/FBref, ~10 pages, run pre-tournament + weekly |
| Ground truth | `api/_lib/soccer-truth.js` + early branch in `api/analyze.js` | no new api/ root file (Hobby 12-function cap) |
| Projection | `api/_lib/projection.js` | `probOverPoisson`; Normal path untouched |
| Rules | `api/_lib/rules/rule-wc-*.js` | market / minutes / context; basketball rules must no-op on WC |
| Grader | `scripts/grade-outcomes.mjs` | ESPN fifa.world summaries |
| UI + smokes | `src/App.jsx`, `scripts/smoke-wc.mjs` | league filter; smoke gates per repo policy |

## 9. Non-goals (v1)

Fouls/Fouls Drawn (demon/goblin-only pricing), Goals/Assists/G+A/Cards
(tail events, demon/goblin pricing), Offsides, Attempted Dribbles, Shots
Assisted, Crosses (standalone — they DO feed the fantasy composite, §10.5),
1H/2H and TRNY leagues, FotMob integration, xG models, extra-time markets.
Revisit only if the group-stage calibration slice is healthy.

> Superseded for Tackles and Passes (v2, §10): DK turned out to carry full
> Tackles ladders (sub 18345), and Passes Attempted ships model-led with a
> B-tier cap rather than being excluded.

## 10. v2 prop expansion (2026-06-11): Tackles, Goalie Saves, Clearances, Passes Attempted, Outfield Fantasy Score

Each prop keeps the §4 skeleton (`λ = r_p90 × E[min]/90 × A`), but the
five stats differ in distribution, market anchor, and environment driver.
All IDs probed live 2026-06-11; PP fantasy weights transcribed from the
in-app scoring chart (not published anywhere public).

### 10.1 Per-stat model table

| Stat (PP name) | DK anchor | Distribution | FBref per-90 source | Env driver `A` | Tiering |
|---|---|---|---|---|---|
| Tackles | cat 1567 / sub **18345** (ladders, ~1k markets) | Poisson | defense `tackles` | opp-attack, mild (`(opp_total/μ)^0.3`, clamp [0.85, 1.2]) | market-led (same as Shots) |
| Goalie Saves | cat 1567 / sub **18346** (ladders) | Poisson | keepers `gk_saves` | **opp-attack, strong** (`(opp_total/μ)^0.8`, clamp [0.6, 1.5]) | market-led; **GK required** |
| Clearances | — none — | Poisson | defense `clearances` | opp-attack (`(opp_total/μ)^0.6`, clamp [0.7, 1.4]) | **model-led, B cap** |
| Passes Attempted | — none — | **Normal, Var = φλ, φ = 3.5** (overdispersed count; λ 15–70 ⇒ Poisson σ far too small) | passing `passes` | own-dominance (`(team_total/μ)^0.45`, clamp [0.8, 1.25]) — favored sides hold the ball | **model-led, B cap** |
| Outfield Fantasy Score | — synthetic (§10.5) — | Normal via moment matching | all component rates | per-component drivers | **model-led, B cap; outfield only** |

Driver inversion is the quant core here: shooters scale with their OWN
team's goal environment (§4.3), but saves/clearances/tackles scale with the
OPPONENT's — a keeper behind a heavy underdog faces more shots. Passes
scale with own dominance instead of goal environment.

### 10.2 Market-led vs model-led policy

- **Anchored stats** (Shots, SOT, Tackles, Goalie Saves): unchanged §5
  policy — ladder-fitted `λ_fair` is the spine; no ladder for the player
  → hard SKIP.
- **Model-led stats** (Clearances, Passes Attempted, Fantasy): there is no
  sharp anchor to lead, so `rule-market-edge` does NOT skip — it applies a
  **B-tier cap + `model_led` flag** and hands the spine to
  `rule-wc-projection`: `p_dir < 0.55` → SKIP (stricter than the market-led
  0.53 — an unproven model needs more edge), `0.55–0.60` → 1 signal,
  `≥ 0.60` → 2 signals. **Prior-only rates → SKIP** (a position prior as
  the sole spine is no spine). S/A are unreachable until the calibration
  checkpoint proves the model-led slice; the cap is the whole risk policy.

### 10.3 Position–stat coherence (extends gate §6.5)

Per-stat GK policy: `Goalie Saves` REQUIRES Goalkeeper (others → SKIP);
`Passes Attempted` allows any position (keepers attempt ~20–35);
everything else SKIPs Goalkeepers (incl. Outfield Fantasy Score — PP
defines it as outfield-only; keepers get a separate Goalie Fantasy Score
stat we don't cover). GK minutes: keepers don't rotate within a match —
club share ≥ 0.75 ⇒ E[min] = 90 (not 78); unknown keeper share defaults
LOW (45) so OVERs gate out rather than ride a backup.

### 10.4 Position priors (per-90, initial — recalibrate)

| stat | Attacker | Midfielder | Defender | Goalkeeper |
|---|---|---|---|---|
| tackles | 0.8 | 1.8 | 1.6 | 0.1 |
| clearances | 0.5 | 1.2 | 4.0 | 1.0 |
| passes_att | 25 | 45 | 50 | 25 |
| saves | 0 | 0 | 0 | 3.0 |
| goals | 0.35 | 0.10 | 0.04 | 0 |
| assists | 0.15 | 0.12 | 0.05 | 0 |
| key_passes | 1.2 | 1.1 | 0.5 | 0 |
| crosses | 1.5 | 1.8 | 2.0 | 0 |
| dribbles_att | 2.2 | 1.2 | 0.6 | 0 |
| fouls | 1.2 | 1.2 | 1.0 | 0.1 |
| yellow | 0.12 | 0.18 | 0.20 | 0.05 |
| red | 0.01 | 0.01 | 0.015 | 0.005 |

### 10.5 Outfield Fantasy Score composite

Official PP weights (in-app scoring chart, transcribed 2026-06-11):
Goal **10**, Assist **5**, Shot **1**, SOT **1**, Pass Attempted **0.05**,
Shot Assisted (key pass) **0.5**, Clearance **1**, Tackle **1**, Attempted
Dribble **1**, Cross **0.5**, Yellow **−1**, Red **−2**, Foul **−0.5**.

Moment matching over component rates:

- `E[F] = Σ wᵢ λᵢ`
- `Var[F] = Σ wᵢ² Varᵢ + 2 Σ wᵢ wⱼ Cov(i,j)` with Poisson-thinning
  covariances along the containment chains **goals ⊂ SOT ⊂ shots**
  (`Cov(shots,sot)=λ_sot`, `Cov(shots,goals)=Cov(sot,goals)=λ_goal`) and
  **assists ⊂ key passes** (`Cov(kp,assist)=λ_assist`). Passes use
  `Var = φλ` (φ = 3.5); all other components independent Poisson
  (`Var = λ`). A scored goal correctly books ~12 pts of simultaneous mass
  (10 + shot + SOT) — variance is goal-dominated for attackers
  (w² = 100: λ_goal = 0.3 alone ⇒ σ ≈ 5.5).
- **Sharp-component override**: when DK ladders cover the player's Shots /
  SOT / Tackles, the component λ uses the margin-corrected `λ_fair`
  (already an all-in match estimate — no minutes rescaling) instead of the
  model λ. The composite is then partially market-anchored; per-component
  sources are logged for calibration.
- `P(over) = 1 − Φ((line − E[F]) / σ_F)` (quasi-continuous, no continuity
  correction).

### 10.6 Grading the new stats

ESPN soccer summaries are validated for SH/ST only (§7). Saves likely
present; tackles/clearances/passes unverified — the grader attempts
candidate keys and logs an explicit `ungradeable` warning per missing
stat rather than guessing. Fantasy actuals are computed from components
ONLY when every component is present; otherwise ungradeable (FBref
match-report scrape is the planned weekly fallback). Calibration items
added: φ = 3.5 (passes), driver exponents 0.8/0.6/0.45/0.3, the
fantasy covariance structure, and the FBref-vs-settlement definition of
"Tackles" (FBref `Tkl` = attempted; PP scoring chart says "Tackles
Attempted" — verify against the first graded match).
