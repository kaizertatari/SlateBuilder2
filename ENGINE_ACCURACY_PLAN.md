# Engine Accuracy Plan — Standard-Line Edge (Path B)

> **Status (2026-05-30): all five stages SHIPPED** on `experiment/suppressor-thin-edge`.
> Every signal family is wired + logged for calibration — sharp market (1),
> Vegas game-script (2), native P(over) (3), minutes/usage/rest (4), WNBA tuning
> (5). **Nothing is validated yet.** The one remaining gate is forward
> measurement: let the verdict telemetry accrue + grade, prove/kill the
> standard-line lift, then (only then) turn on the slate-builder EV blend.

## Context

The slate-builder pivot is +EV-or-abstain, and the calibration audit
(2026-05-29) showed it must abstain ~always at ≥3× because **the engine has no
edge where the payout is**: standard-line hit rate ~47–48% and engine
confidence is *non-predictive* on standard lines (flat across confidence
buckets). Goblins (the only place the engine shows signal, ~67%) are
house-priced to lose and can't reach ≥3×. So profit requires one thing:
**make the engine accurate on standard/demon lines.** This doc researches how
that's actually done and lays out a staged plan, measured by the existing
calibration/backtest loop.

## Why the current engine can't beat standard lines

`api/_lib/engine.js` + `api/_lib/rules/_helpers.js` (`computeOverBufferCheck`)
implement a **box-score projection vs the line**:

> baseline = weighted-L5 / season / H2H blend → road deduction → per-stat
> buffer (+ outlier/variance/poor-FT widening) → `passes = line ≤ baseline −
> buffer`. Confidence = Σ hand-tuned `RULE_WEIGHTS`, snapped to an S/A/B band.

This asks "is the line below the player's own adjusted average?" — **not "is
the line mispriced?"** Standard PrizePicks lines are ~the efficient market, so
out-projecting them from box scores alone tops out at a coin flip. That is
precisely the observed result.

## How quants actually find value (research synthesis)

1. **Beat the *market*, not the box score.** The proven way to beat PrizePicks
   pick'em is to compare each line to a **sharp sportsbook no-vig consensus**
   (Pinnacle/Circa/FanDuel/DK; the "Unabated line"). Bet only props whose
   no-vig fair probability clears the payout breakeven (~54.25% for the −119
   on 5–6 leg standard entries; ~58.5% for a 3-pick Power). Edge comes from
   *line discrepancy*, not from a better season-average model.
2. **Start from a game-script thesis: Vegas total + spread.** Game total →
   pace → possessions → counting stats. Spread → blowout/garbage-time → minutes
   (bench overs on the winner, starter unders on the loser). Pros pick props
   that align with the projected game, then check the matchup.
3. **Minutes and pace are the two biggest drivers.** A player can't accumulate
   if he's not on the floor; +5 possessions vs his normal environment is
   material for PRA/reb/ast/3PA. Prop lines are **slow to move on role
   shifts** — when a teammate is out, usage/minutes jump immediately but the
   line lags. That lag is the edge.
4. **Model the distribution, not the mean.** A prop is P(stat > line); pros
   project a mean *and* a variance and compute the crossing probability, then
   compare to the market's implied probability.
5. **WNBA is a soft market.** Lines are posted off basic averages, move 3+ pts
   when sharps hit them, and books disagree wildly (e.g., one book O18.5, another
   21.5). Information edges (beat-reporter injury/rest news) and no-vig
   comparison pay *more* in the WNBA than the NBA.

## Gap analysis — what the framework is missing

| Signal pros use | In the engine today? | Leverage |
|---|---|---|
| **Sharp no-vig consensus line for the same prop** | **No** | ★★★★★ |
| **Vegas game total / team total / spread** | No (only a weak ESPN win-prob proxy) | ★★★★★ |
| Forward **minutes projection** + injury **usage redistribution** | Partial — mechanisms *react* but don't quantify the minutes/usage delta or compare to a stale line | ★★★★ |
| Explicit **P(over) from mean+variance** | No — heuristic tier/buffer; `variance` block is usually null (needs ≥8 games, only L5 is plumbed) | ★★★★ |
| **Pace** (possessions) + **defense-vs-position** by stat | Partial — `def_rank` only, no pace, no positional DvP | ★★★ |
| Larger windows (L10–L20) + **per-minute rates** + trend | No — only L5 + season | ★★★ |
| **Rest / B2B / 3-in-4** | No — only `days_out` until the game | ★★ |

Have today (for reference): weighted/trimmed/raw L5, season, H2H, current-series,
home/road splits, ESPN win-prob, injuries + body regions, opponent def rank +
primary defender, road deduction, FT-floor by position, UNDER mechanisms,
playoff series state.

## The reframe

Stop trying to out-project an efficient market. Make the engine a
**market-anchored hybrid**: the sharp **no-vig fair probability is the spine**;
the engine's projection + game-script + role-change signals (a) confirm/deny it
and (b) catch *staleness* the market hasn't priced yet. "Increase standard-line
accuracy" = "detect mispriced/stale PrizePicks lines," which is achievable,
versus "out-project Vegas," which is not.

## Staged plan (each stage measured against standard-line hit rate)

### Stage 1 — Sharp odds + no-vig edge  ★ the edge  ✅ SHIPPED
Built with **direct DK + FanDuel scraping** (no paid odds API): `scripts/scrape-odds.mjs` → `data/odds.json`/blob, `api/_lib/odds.js` (de-vig + per-league line-shift), `rule-market-edge.js`, market fields logged. Covers **WNBA + NBA**. Forward measurement of the standard-line lift is pending settled games.
- New `api/_lib/odds.js` + `scripts/refresh-odds.mjs` → `data/odds.json`: pull
  player props + game totals/spreads for NBA **and WNBA** from an odds API,
  compute **no-vig fair probability** per (player, stat, line, direction).
- Match PrizePicks lines ↔ market; expose a `market` block in ground truth:
  `{ no_vig_prob, consensus_line, line_delta, books_n }`.
- New `rule-market-edge.js`: the dominant feature — confidence/EV driven by
  `no_vig_prob` vs the PrizePicks line. Standard lines with a real no-vig edge
  become bettable; the rest abstain.
- Log `no_vig_prob` + `line_delta` in `verdict-logger.js` so calibration can
  slice "had market edge vs not" and we can *prove* the standard-line lift.
- **Decision required: odds provider + budget.** Recommend **The Odds API**
  (documented, affordable, NBA+WNBA player props + totals) for v1; OddsJam/
  Unabated are richer but pricier. Keyed API → can run from the residential
  bridge or a Vercel cron (not IP-blocked like PrizePicks).

### Stage 2 — Vegas game-script features  ✅ SHIPPED (c6c119f)
Built as `rule-game-script.js` (one module per signal family, not a
`computeOverBufferCheck` mutation). `lookupVegas` derives the team implied
total + spread from the scraped `games` block; the rule emits a scoring-env
tailwind/headwind + a blowout minutes adjustment, logged via the engine's
`vegas` block for calibration. Per-league refs/bands are approximate — tune
via calibration (same status as the line-shift slopes).
- From the Stage-1 feed: `vegas` block `{ game_total, team_total, spread,
  implied_pace }`. Feed pace into the baseline (possession scaling) and
  spread/blowout into a minutes/garbage-time adjustment (bench overs on
  favorites, starter unders on big dogs). Refines `computeOverBufferCheck`.

### Stage 3 — Probability model (native P(over))  ✅ SHIPPED (6f6b171)
Built as `api/_lib/projection.js` (mean = the engine's adjusted baseline; σ =
live points stddev or the slope-implied per-league σ; normal crossing) +
`rule-projection.js` (confirm/deny vs the no-vig market — agree→signal,
conflict→suppressor, never SKIPs). The engine emits a `projection` block
(model_prob / mean / σ / market_agree), logged for calibration. **Deferred,
gated on the model grading out:** folding game-script/minutes INTO the
projection mean, and blending model-P into the slate builder's EV — until
then the model is confirm/telemetry-only and the market stays the spine.
- `api/_lib/projection.js`: projected mean (baseline + game-script + minutes) +
  variance → `P(over)` via a normal/negative-binomial crossing. Engine emits a
  **probability**, not just a tier — makes calibration native and lets us learn
  weights against outcomes. Blend model-P with market no-vig-P; bet when they
  agree against PrizePicks (or when one flags clear staleness).

### Stage 4 — Minutes & usage projection  ✅ SHIPPED (1a1c83a, 4a; 3c554fe, 4b)
Done on the EXISTING ESPN gamelog — no nba-stats/lineup dependency: the gamelog
endpoint already returns the full season + per-game dates/minutes, and own-team
injuries are enriched with season ppg on the fly.
- **4a** — extended window → real `variance.ppg_stddev` (feeds the projection σ
  + Rule 5a's dormant variance buffer) + a `rest` block → `rule-rest` (B2B /
  3-in-4 fatigue suppressor).
- **4b** — injury ppg enrichment revives `mech2` → `rule-usage-shift`
  (star-teammate-out usage redistribution + own minutes restriction, OVER side;
  UNDER stays with `rule-under-mechanism`).
Still deferred: per-minute-rate projection scaling and pace (need a pace source);
folding minutes/game-script INTO the projection mean; and — the gate on all of
it — forward measurement before any signal is trusted or fed into bet EV.
- Forward minutes (injury-adjusted, blowout-adjusted) + usage redistribution
  when a teammate is OUT (the role-shift staleness edge). Add L10–L20 windows +
  per-minute rates (fixes the perpetually-null `variance` block) and rest/B2B.
  Needs nba-stats usage + lineup data; verify whether `team-defense.json`
  already carries pace (add if not).

### Stage 5 — WNBA tuning  ✅ SHIPPED (1b7b74e)
WNBA odds coverage shipped in Stage 1. The market signal is now league-aware
(`MARKET_TUNING` + league-aware `MAX_PROB_SHIFT`): WNBA acts on smaller edges
and tolerates larger line gaps (real staleness there) while NBA stays tight,
and dog-protection (skip/cap) stays league-agnostic. Per-league σ (projection)
and game-script reference totals were already league-aware from earlier stages.
- WNBA is the softest market → biggest edge per effort. Prioritize WNBA odds
  coverage and looser staleness thresholds; expect Stage 1 alone to surface
  more standard-line edge here than in the NBA.

## Measurement (non-negotiable)

Every stage is judged by one metric: **standard-line hit rate and the +EV
qualifying-slate yield**, via `scripts/build-calibration.mjs` →
`scripts/backtest-slates.mjs`. Ship a stage only if the backtest shows the
standard-line bucket moving toward/over breakeven on a held-out split. Keep the
daily grader running so the sample grows; treat all early numbers as provisional.

## Risks / honesty

- Even with sharp lines, standard NBA props are ~efficient — edges are
  intermittent (specific stale spots), so the builder will still bet
  *selectively*, not daily. That's correct, not a failure.
- A no-vig data source is a recurring cost and an external dependency.
- WNBA edge is real but lower-limit and seasonal.
- This makes the engine partly market-derivative; the original "pure
  deterministic from box scores" property changes — by design.
