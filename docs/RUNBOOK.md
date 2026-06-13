# Operational Runbook

Operational procedures for the Slate Builder deployment: scheduled tasks,
data refreshes, the home-bridge/funnel path, and debugging recipes.
Architecture and module layout are documented separately; this file is
about *running* the system.

Background constraint that shapes most of this file: **PrizePicks 403s
Vercel/cloud egress IPs.** Every PrizePicks scrape must run from a
residential IP — either the local CLI on the operator's machine, or the
home-bridge daemon that the deployed UI forwards to.

## Scheduled tasks (Windows Task Scheduler, this machine)

| Task | Schedule | What it runs |
|---|---|---|
| `grade-outcomes-daily` | 09:00 local | `scripts/grade-outcomes.mjs` — joins verdicts ↔ ESPN actuals, emits outcome events |
| `PrizePicks Refresh Lines` | 00:00 / 06:00 / 12:00 / 18:00 | PrizePicks lines scrape → `data/prizepicks-lines.json` + blob |
| `PrizePicks Refresh Odds` | 00:10 / 06:10 / 12:10 / 18:10 | `scripts/refresh-odds-task.bat` → DK+FD no-vig consensus → `data/odds.json` + blob (+10 min after lines so they stay in sync) |
| `Funnel Watchdog` | every 15 min | `scripts/funnel-watchdog-task.bat` → self-heals the Tailscale funnel zombie (see below) |

Common operations: inspect `schtasks /Query /TN "<name>" /V /FO LIST`,
run now `schtasks /Run /TN "<name>"`, modify `schtasks /Change`.

**Task-registration gotchas (burned 2026-06-12):** `schtasks /TR` strips
quotes around paths containing spaces — the action splits at the space in
"Slate Builder" and the task dies with 0x80070002 "file not found".
Register actions via PowerShell `New-ScheduledTaskAction -Execute <path>`
instead. Also clear the default battery conditions
(`DisallowStartIfOnBatteries = $false`, `StopIfGoingOnBatteries = $false`)
or the task silently queues on battery. All task `.bat` wrappers are
self-locating (`%~dp0..`), so a moved checkout only needs the Action path
updated.

**Audit (2026-06-13):** `PrizePicks Refresh Odds` + both grader tasks still had
the battery conditions set, so on battery the scheduled refreshes/grades silently
skipped (e.g. the odds blob sat ~20h stale; `analyze-all` then priced against no
odds → ~zero `market_fair_at_line` coverage in the verdict log). Cleared
`DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` and set
`StartWhenAvailable=$true` on `PrizePicks Refresh Odds`, `grade-outcomes-daily`,
`PrizePicks Grade Outcomes`. Also found a DUPLICATE grader: `PrizePicks Grade
Outcomes` pointed at the old `Props_Generator` checkout — **unregistered** it
(Props_Generator is retired); `grade-outcomes-daily` (this checkout) is the
sole keeper. To verify a task launches
cleanly after editing: `Start-ScheduledTask -TaskName <name>` then check
`logs\grade.log` / `Get-ScheduledTaskInfo` for `LastTaskResult 0`.

## Daily grader

Manual: `npm run grade-outcomes`. Options: `--date YYYY-MM-DD`,
`--lookback N` (default 7 days), `--dry-run`.

## Refresh lines

`npm run refresh-prizepicks` (residential IP only). Writes
`data/prizepicks-lines.json` + blob. Commit the JSON snapshot with a
timestamped message. The refresh has occasionally produced an empty file
mid-slate; verify the file is non-empty before committing
(`git checkout --` to restore on failure).

**WC-leg thinning:** PrizePicks rate-limits league 241 (World Cup)
aggressively. Since 2026-06-12 the scraper has a salvage guard
(`salvageLeagueFromSnapshot` in `scripts/scrape-prizepicks.mjs`, smoke
`smoke:scrape-salvage`): a league whose fetch fails after retry is
backfilled from the previous snapshot (blob first), keeping only
not-yet-started games — output shows `salvaged from <ts>`. Salvage is
partial-failure only; an all-league failure still returns 0 props so the
refuse-write / forward-to-bridge guards fire. Verify WC>0 via
`node scripts/peek-lines.mjs` after a refresh; a salvaged count only
shrinks as games kick off.

## Refresh odds

Manual: `npm run refresh-odds`. Logs: `logs/refresh-odds.log`. Runs the
DK+FD scrape and no-vig consensus the slate builder prices against.
Residential IP only (same constraint as lines).

## Inspect the slate snapshot

`data/prizepicks-lines.json` is ~2 MB / 70k lines; never open it whole
(it will blow an agent session's context). Use
`node scripts/peek-lines.mjs` (summary),
`node scripts/peek-lines.mjs "<player>"` (one player), or
`node scripts/peek-lines.mjs --stat "<stat>"`.

## Refresh-bridge service

The bridge exists because of the PrizePicks IP block: the deployed
REFRESH LINES button forwards to this daemon on the operator's
residential IP. It runs as NSSM Windows service `refresh-bridge`,
auto-starts on boot, auto-restarts on crash (`AppExit=Restart`,
`RestartDelay=0ms`).

- Status: `nssm status refresh-bridge` (no admin needed for read).
- Restart: elevated `nssm restart refresh-bridge`.
- Logs: `logs/refresh-bridge.out.log` + `logs/refresh-bridge.err.log`
  (rotate at 10 MB).
- Liveness: `GET /health` (unauthenticated) → `{ok:true}`.
- Public route: the `HOME_REFRESH_URL` Vercel env points at the Tailscale
  Funnel hostname → `127.0.0.1:4000`.

If the deployed REFRESH LINES button returns `forwarded_to_bridge: true`
with no `total_props` field, the bridge is down — check the service
status first, then the err log.

**NSSM path gotcha:** `AppParameters` MUST stay the relative
`scripts\refresh-bridge.mjs` — an absolute path breaks on the space in
"Slate Builder" (NSSM passes it unquoted → MODULE_NOT_FOUND crash-loop →
service lands in Paused; fix params, then elevated
`Restart-Service refresh-bridge -Force`).

**The bridge imports code at process start:** after pulling scraper or
bridge changes, restart the service (elevated) or it keeps serving the
old code.

## Funnel zombie

Seen twice 2026-06-12: `tailscale funnel status` shows "Funnel on" while
the public path is dead — Vercel gets
`Home bridge unreachable: fetch failed`. Local tailnet curl of the
`.ts.net` URL still works, so it masks the failure. The zombie can be
**partial**: one external vantage got through while Vercel's egress path
stayed dead, so a passing external probe does NOT clear the funnel. The
only trustworthy check is the deployed endpoint itself:

```
POST https://slate-builder.vercel.app/api/refresh-lines?ping=1
Authorization: Bearer $REFRESH_TOKEN
```

(`?ping=1` probes the bridge through the funnel without scraping;
`bridge_reachable: true` = healthy. Note `.env.local` is CRLF — strip
`\r` when scripting the header or auth silently breaks.)

Fix: `tailscale funnel reset` then
`tailscale funnel --bg http://127.0.0.1:4000` (no admin needed), then
allow **~3 minutes** of ingress propagation before judging — the
immediate retry after a reset still failed; the +3 min one succeeded.

## Funnel watchdog

Automates the zombie fix. Windows task **Funnel Watchdog** (every 15 min)
→ `scripts/funnel-watchdog-task.bat` → `scripts/funnel-watchdog.mjs` →
`logs/funnel-watchdog.log`. Manual: `npm run funnel-watchdog`.

Probes the deployed `?ping=1` endpoint (Vercel's own vantage — the only
one that counts, per the partial-zombie finding). On a zombie verdict it
runs the funnel reset + re-establish, waits the ~3 min propagation, and
re-probes. Auth failures, rate limits, and local-network problems log
`NO-RESET` and never churn the funnel — a reset can't fix those.

Deployment note: the `?ping=1` branch lives in `api/refresh-lines.js` and
only exists in **Production = `main`** (pushes to `Testing` create
Preview deploys only).

## Refresh bbref splits

`npm run refresh-bbref-splits` (annual; staleness triggers the
DATA-PROVENANCE GUARD and caps WNBA verdicts at A-tier). Verify the
snapshot's `season` field after refresh.

## Refresh team defense

`npm run refresh-team-defense`.

## Refresh soccer rates (World Cup)

`npm run refresh-soccer-rates -- --headed` — MUST be headed: headless
gets Cloudflare's "Just a moment..." on every FBref page; the headed
system-Chrome run passes it unattended (~12 min, 12 comps × 7 pages:
shooting/passing/defense/possession/misc/keepers/playingtime). Weekly
during the tournament is plenty (club seasons are over; in-tournament
signal accrues via the grader). Missing players degrade to position
priors + A-tier cap; rows missing a v2 field degrade per-stat (model-led
props SKIP on prior-only) — a partial snapshot is safe.

## Refresh WC match stats (FBref grader fallback)

`node scripts/refresh-wc-match-stats.mjs --headed` (same Cloudflare
constraint as soccer-rates). Incremental: scrapes only completed matches
missing from `data/wc-match-stats.json`, PLUS any stored match that is
still "basic only" — FBref posts day-after reports with just the basic
summary table (no tackles/clearances/passes; seen 2026-06-12) and
enriches to full Opta tables later, so basic matches auto-rescrape every
run until they upgrade. The grader merges this snapshot over ESPN rosters
(`fbref_filled` counter in the WC result line). Tackles / Clearances /
Passes Attempted / Outfield Fantasy Score CANNOT grade until enrichment
lands — if FBref lags past the grader's 7-day window, backfill with
`node scripts/grade-outcomes.mjs --lookback 30` after a refresh. Run
every day or two during the tournament.

## World Cup coverage

Rides the existing refreshes: the lines scrape adds PP league 241
(7 stats: Shots / SOT / Tackles / Goalie Saves / Clearances / Passes
Attempted / Outfield Fantasy Score, promos dropped; the WC leg 429s
easily — it retries once, and a dropped league is salvaged from the
previous snapshot). The odds scrape adds DK league 209533
(ladder → Poisson fit at scrape time; entries carry `lambda_fair`). The
grader has a WC leg (ESPN fifa.world summaries, name-matched; stat keys
validated 2026-06-12 against event 760415 — ESPN carries only
SHOT/SOG/SV plus goals/assists/fouls/cards, hence the FBref fallback
above). PrizePicks settles soccer on 90'+stoppage, NO extra time.

## Query Axiom

Telemetry lives in Axiom dataset `props_verdict` (also the
verdict-logger default), discriminated by `event_type` ∈
{`verdict`, `outcome`, `log`}. The `verdict` field stores direction; the
`tier` field stores S/A/B/SKIP — filter on `tier` for issued picks.
Helpers in `scripts/_axiom.mjs`; `AXIOM_TOKEN` from `.env.local`.

## Measure signal calibration

`node scripts/calibration-report.mjs --lookback 120` (read-only,
suggest-only). Joins verdicts ↔ outcomes; reports hit-rate by
tier/confidence + a SIGNAL CALIBRATION block (Stage 1–5: market & model
reliability curves, plus market_edge / model×market-agree /
vegas-blowout / rest / usage-teammate-out slices, standard-line focused).
This is the forward-measurement gate — prove or kill a slice before
trusting it or enabling the slate-builder EV blend.
`scripts/backtest-slates.mjs` reads every signal field (schema-proof
full-row pull in `scripts/_axiom.mjs`).

`node scripts/calibrate-market.mjs` (`npm run calibrate-market`) is the
slate-builder–specific rig: it tests the de-vig prob the builder actually
BETS ON (`market_fair_at_line`) against graded outcomes. Two reads: a
reliability curve + Brier (*is the prob right?* — a persistent negative gap
⇒ discount EV in `buildSlate`), and an **EDGE BY LINE Δ** block (*where is
the exploitable slice?*) — realized hit vs predicted, bucketed by
`market_line_delta` (PP line − sharp book line): by |Δ| magnitude (a gap
that grows with |Δ| ⇒ the linear line-shift slope is biased far from the
book line) and by direction-adjusted **favorable** Δ (a positive gap in the
favorable bucket ⇒ the market under-credits PP lines that lag sharp = real
edge). Leads with a COVERAGE line and is data-gated: build-slate telemetry
must accrue and settle first (today only ~2 settled rows carry the market
prob), and the favorable bucket prints "too thin to call" under n=30.

## Debug 0-analyzed players

Check in order: (1) PrizePicks scrape produced a `player_team` hint,
(2) ESPN scoreboard reachable, (3) `RETRIABLE_SKIP_REASONS` gate in
`gatherGroundTruthWithRetry`, (4) `teamAbbrHint` fallback path in
`gatherGroundTruth`. Most recurring 0-analyzed cases are transient ESPN
timeouts.

## Rate limits

`/api/analyze-all` allows 20 requests / 60s per IP. `/api/refresh-lines`
allows 6 / 60s per IP.
