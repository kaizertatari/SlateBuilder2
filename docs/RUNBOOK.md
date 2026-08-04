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
| `grade-outcomes-daily` | 09:00 local (**DISABLED 2026-06-21**) | `scripts/grade-outcomes.mjs` — joins verdicts ↔ ESPN actuals, emits outcome events. Disabled in favor of on-demand grading at calibration time. ⚠️ Axiom retention is 30 days, so grade within 30 days of any verdict (lookback ≤30) or it ages out unrecoverably. Re-enable: `Enable-ScheduledTask -TaskName grade-outcomes-daily`. |
| `PrizePicks Refresh Lines` | 00:00 / 06:00 / 12:00 / 18:00 | PrizePicks lines scrape → `data/prizepicks-lines.json` + blob |
| `PrizePicks Refresh Odds` | 00:10 / 06:10 / 12:10 / 18:10 | `scripts/refresh-odds-task.bat` → DK+FD no-vig consensus → `data/odds.json` + blob (+10 min after lines so they stay in sync) |
| `Funnel Watchdog` | every 15 min | `scripts/funnel-watchdog-task.bat` → self-heals the Tailscale funnel zombie (see below) |
| `Refresh Bridge` | at logon (daemon) | `powershell.exe -WindowStyle Hidden -File scripts/refresh-bridge-task.ps1` → job-object-wrapped, self-restarting `scripts/refresh-bridge.mjs`. Replaced the NSSM service 2026-07-07; launcher rewritten from `.vbs` 2026-07-30 — see "Refresh-bridge daemon" |

**Migration audit (2026-07-07):** after the 06-17 move to `Slate Builder2`,
`PrizePicks Refresh Lines` and `PrizePicks Refresh Odds` still executed the
OLD `Slate Builder` checkout's `.bat`s — every scheduled run used the old
code/env and pushed to the DEAD `5smeyecbhyrcod7s` blob store while prod read
`yKBw`; masked for 3 weeks by manual refreshes and REFRESH LINES clicks. Both
re-pointed (action + WorkingDirectory) to this checkout. When migrating a
checkout, audit EVERY task's Task-To-Run (`schtasks /Query /TN <name> /V`)
AND every NSSM path (`nssm get <svc> AppDirectory/AppStdout/AppStderr`).

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

**Stale-checkout lesson (2026-06-13):** `PrizePicks Refresh Lines` once ran a
`.bat` with a HARDCODED `cd /d ...\Props_Generator`, so every scheduled run
executed the RETIRED checkout's scraper while manual REFRESH LINES (which
routes through the refresh-bridge) worked fine. The wrapper now self-locates
with `cd /d "%~dp0.."` like `refresh-odds-task.bat`. **Lesson:** a
self-locating `.bat` only helps if the task's *Task To Run* points at the
right copy — when auditing, check BOTH the bat body AND the registered
Task-To-Run path (`schtasks /Query /TN <name> /V /FO LIST`).

## Daily grader

Manual: `npm run grade-outcomes`. Options: `--date YYYY-MM-DD`,
`--lookback N` (default 7 days), `--dry-run`.

## Refresh lines

`npm run refresh-prizepicks` (residential IP only). Writes
`data/prizepicks-lines.json` + blob. Commit the JSON snapshot with a
timestamped message. The refresh has occasionally produced an empty file
mid-slate; verify the file is non-empty before committing
(`git checkout --` to restore on failure).

**PerimeterX (since 2026-06-23):** `api.prizepicks.com` is now fronted by
PerimeterX/HUMAN bot management — plain fetch (and curl/.NET) gets HTTP 403
with a challenge body (`appId "PXZNeitfzP"`). The scrape therefore runs
through a real browser: `scripts/scrape-prizepicks-browser.mjs` drives a
Playwright persistent context (`.prizepicks-profile`, same recipe as
fetch-prizepicks-entries) that loads `app.prizepicks.com` to
earn a cleared `_px3` cookie, then in-page-`fetch`es the projections API.
`refresh-prizepicks` and the `refresh-bridge` both call it. **Headless works**
— the decisive bit is the `addInitScript` fingerprint patch (navigator.webdriver
undefined etc.); without it headless 403s. Run `node
scripts/scrape-prizepicks-browser.mjs --headed` once to (re)seed the profile if
PX ever hard-blocks the headless path. After deploying a bridge code change,
the NSSM service must be restarted (elevated) to pick it up.

**Mid-run PX recovery (2026-07-10):** the browser fetcher now self-heals when
PX re-challenges the api subdomain mid-scrape. A per-request `HTTP 0
("Failed to fetch")` / 403 no longer just sleeps and fails the league — it
reloads `app.prizepicks.com` to earn a fresh `_px3` (`ensurePxCleared`,
20s budget) and retries, so a SINGLE run recovers all leagues that clear at
all. This retired the old "just re-run the guarded refresh a few times"
recipe (that worked only because salvage merged partial runs). 429s (genuine
rate-limit, cookie fine) still take a plain cooldown, not a re-clear. If one
run now leaves a league at 0, it's a real block/outage or a poisoned profile —
not per-request flakiness — so go to the re-seed recipe below.

**Offseason league skip:** set `PP_LEAGUES=WNBA` (comma-separated, matched
case-insensitively against the league names in `scrape-prizepicks.mjs`
`LEAGUES`) to skip a dormant league without a code edit — e.g. NBA over the
summer, which otherwise burns a fetch+retry cycle for a slate with no games.
Unset = scrape all. Applies to `refresh-prizepicks`, the bridge, and the CLI.

**Warm bridge browser (2026-07-10):** `refresh-bridge.mjs` now holds ONE
`createBrowserSession()` for the daemon's lifetime instead of launching a fresh
Chrome per `/refresh`. Each click probes the warm `_px3` first and only re-clears
when it's stale, saving ~10-25s of launch+clear per click; a crashed page drops
the context so the next click relaunches clean. Bridge code changes still need a
`Stop-/Start-ScheduledTask "Refresh Bridge"` to take effect.

**Session-0 escalation (2026-07-07, later the same day):** re-seeding fixed
the interactive paths but the bridge kept 403ing — controlled test showed PX
now hard-blocks headless Chrome launched from **session 0** (the NSSM
service) even on a pristine profile, while the identical scrape from the
logged-on desktop session clears. Worse, each failed session-0 run poisons
the shared profile (see below), re-breaking the interactive paths within
minutes. Fix: the bridge moved to the interactive-session `Refresh Bridge`
scheduled task (see "Refresh-bridge daemon"). ALL PP scrapes must run in the
operator's desktop session; never host one in a service/session 0.

**Poisoned profile (2026-07-07):** PX can flag the persistent
`.prizepicks-profile` itself, after which EVERY league 403s ("PerimeterX did
not clear within budget") **even `--headed`** — the re-seed recipe above is
not enough. Diagnosis: a scrape on a FRESH profile clears in ~10s, so if
headed-on-the-existing-profile fails but the IP is fine, the profile is
flagged. Fix: delete `.prizepicks-profile` and run the `--headed` re-seed —
it recreates the profile and clears immediately; verify with a headless
`npm run refresh-prizepicks`. No bridge restart needed (the profile is
re-read at each scrape's browser launch). Symptom from the deployed button:
`Home bridge unreachable: The operation was aborted due to timeout` — the
bridge IS reachable but burns minutes on 403 retries until the Vercel-side
fetch aborts, so don't chase the funnel zombie (`?ping=1` distinguishes
them: `bridge_reachable: true` = not a funnel problem).

**Slider captcha regime (steady-state since 2026-08-02):** PX now serves a
"Let's confirm you're human" slider that needs ONE human slide per fresh
clearance, and the clearance does not survive ~12h idle — so unattended
scheduled refreshes fail gracefully (refuse-write keeps the stale snapshot)
and every operator-requested refresh may need a slide. Do NOT use `--headed`
for this: its clearance loop reloads the page every ~12s, which resets the
slider mid-drag (2026-08-01). Routine:
1. `Stop-ScheduledTask "Refresh Bridge"` (shared-profile collision).
2. Delete `.prizepicks-profile`.
3. `node scripts/px-seed-assist.mjs` — opens a headed window that NEVER
   reloads and probes the API in-page every 5s; operator slides once; the
   script exits 0 on a 200 probe (exit 1 = budget/window closed).
4. Headless `npm run refresh-prizepicks:guarded` immediately after.
5. `Start-ScheduledTask "Refresh Bridge"`; verify
   `curl 127.0.0.1:4000/health`.
NBA and WC boards may error ("Failed to fetch") even when cleared — WNBA is
the only health signal.

**League thinning / salvage:** since 2026-06-12 the scraper has a salvage
guard (`salvageLeagueFromSnapshot` in `scripts/scrape-prizepicks.mjs`, smoke
`smoke:scrape-salvage`): a league whose fetch fails after retry is
backfilled from the previous snapshot (blob first), keeping only
not-yet-started games — output shows `salvaged from <ts>`. Salvage is
partial-failure only; an all-league failure still returns 0 props so the
refuse-write / forward-to-bridge guards fire. Verify per-league counts via
`node scripts/peek-lines.mjs` after a refresh; a salvaged count only
shrinks as games tip off.

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

## Refresh-bridge daemon

The bridge exists because of the PrizePicks IP block: the deployed
REFRESH LINES button forwards to this daemon on the operator's
residential IP.

**Hosting changed 2026-07-07** — the NSSM Windows service was retired
because PerimeterX now hard-403s headless Chrome launched from session 0
(any Windows service), and each failed session-0 scrape poisons the shared
`.prizepicks-profile` for every other scrape. The bridge now runs as
Scheduled Task **`Refresh Bridge`**: at-logon trigger, Interactive as the
operator (same session as the other PP scrapes), `powershell.exe
-WindowStyle Hidden -File scripts/refresh-bridge-task.ps1` → wraps
`refresh-bridge-task.bat` (self-restart loop around `node
scripts/refresh-bridge.mjs`, 5s backoff, replaces NSSM `AppExit=Restart`)
in a **kill-on-close Job Object** and waits on it.

**Launcher changed 2026-07-30** — the original `wscript.exe
refresh-bridge-task.vbs` launcher fired-and-forgot, so (a) the task
instance "completed" in <1s and every logon stacked another orphaned
restart loop (three found running at once), and (b) `Stop-ScheduledTask`
had nothing to kill — Windows never terminates a task's process TREE, only
its direct process. The `.ps1` fixes both: the task instance now reads
**Running** for the daemon's lifetime (so the IgnoreNew instance policy
blocks duplicate logon launches), and stopping the task terminates the
launcher, whose closing job handle makes the kernel reap cmd + node + the
warm Chrome. The `.bat` also gained a port-4000 duplicate guard (a second
copy exits instead of crash-looping on EADDRINUSE).

- Status: `Get-ScheduledTask -TaskName "Refresh Bridge"` (State should be
  **Running** — `Ready` means the daemon is NOT up) + `curl
  http://127.0.0.1:4000/health` (`GET /health`, unauthenticated →
  `{ok:true}`).
- Restart (no elevation): `Stop-ScheduledTask -TaskName "Refresh Bridge"`
  then `Start-ScheduledTask -TaskName "Refresh Bridge"`. Since 2026-07-30
  Stop reliably kills the whole tree (verify: port 4000 free) — no manual
  orphan hunt needed.
- Logs: `logs/refresh-bridge.out.log` + `logs/refresh-bridge.err.log`
  (append-only now — NSSM's 10 MB rotation is gone; trim occasionally).
- Public route: the `HOME_REFRESH_URL` Vercel env points at the Tailscale
  Funnel hostname → `127.0.0.1:4000`.
- Caveat: the bridge only runs while the operator is logged on (Interactive
  logon type — required, because session 0 is what PX blocks).

If the deployed REFRESH LINES button returns `forwarded_to_bridge: true`
with no `total_props` field, the bridge is down or its scrape failed —
`?ping=1` first (bridge_status 200 = process up; 502 from the funnel =
process dead), then the err log.

**The bridge imports code at process start:** after pulling scraper or
bridge changes, restart the task (Stop-/Start-ScheduledTask, no elevation)
or it keeps serving the old code.

## Funnel zombie

Seen twice 2026-06-12: `tailscale funnel status` shows "Funnel on" while
the public path is dead — Vercel gets
`Home bridge unreachable: fetch failed`. Local tailnet curl of the
`.ts.net` URL still works, so it masks the failure. The zombie can be
**partial**: one external vantage got through while Vercel's egress path
stayed dead, so a passing external probe does NOT clear the funnel. The
only trustworthy check is the deployed endpoint itself:

```
POST https://slate-builder2.vercel.app/api/refresh-lines?ping=1
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
