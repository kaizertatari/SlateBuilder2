@echo off
REM Wrapper invoked by Windows Task Scheduler to grade yesterday's verdicts.
REM Reads verdict events from Axiom, fetches final box scores from ESPN,
REM emits outcome events back to Axiom, then copies every graded pair (all
REM leagues, incl. EPL graded by "EPL Daily" at 07:00) into data\graded\
REM before Axiom's 30-day retention drops it. Output appended to
REM logs\grade.log for postmortem.

setlocal
REM Self-locating (%~dp0 = scripts\), so it runs from whichever checkout it
REM lives in and reads that checkout's .env.local + writes its own logs\.
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\grade.log"
echo === %date% %time% start === >> "logs\grade.log"
REM Separate graders per league (2026-10-28): each pass queries only its own
REM league in day windows, so neither can be starved by the other - or by
REM NFL/EPL sweep volume - past Axiom's 50,000-row query cap.
set "rc=0"
"C:\Program Files\nodejs\node.exe" scripts\grade-outcomes.mjs --league NBA >> "logs\grade.log" 2>&1
if errorlevel 1 set "rc=1"
"C:\Program Files\nodejs\node.exe" scripts\grade-outcomes.mjs --league WNBA >> "logs\grade.log" 2>&1
if errorlevel 1 set "rc=1"
"C:\Program Files\nodejs\node.exe" scripts\export-graded.mjs >> "logs\grade.log" 2>&1
if errorlevel 1 set "rc=1"
REM Cross-league calibration report over data\graded\ (latest copy alone).
"C:\Program Files\nodejs\node.exe" scripts\calibration-all.mjs > "logs\calibration-latest.txt" 2>&1
REM SHADOW basketball opponent-factor model: refresh last night's box scores,
REM refit, push the artifact the app logs on every verdict (no tier change).
REM Failures here never touch rc. Output -> logs\opp-model.log.
echo === %date% %time% start === >> "logs\opp-model.log"
for %%L in (NBA WNBA) do (
  "C:\Program Files\nodejs\node.exe" scripts\refresh-basketball-gamelogs.mjs --league %%L >> "logs\opp-model.log" 2>&1
  "C:\Program Files\nodejs\node.exe" scripts\build-basketball-opponent.mjs --league %%L --push >> "logs\opp-model.log" 2>&1
)
echo === %date% %time% end === >> "logs\opp-model.log"
REM NBA team tracker (this season only): store last night's per-game box
REM scores (traditional incl. starters/bench, misc, advanced, hustle, matchup
REM defense; each game cross-checked vs ESPN + the game log refreshed above),
REM then rebuild data\nba-team-tracker.json + logs\nba-team-tracker-latest.txt
REM and re-check it against stats.nba.com's official team/player totals. A
REM no-game day fetches nothing. Never touches rc. Output -> logs\nba-tracker.log.
echo === %date% %time% start === >> "logs\nba-tracker.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-nba-boxscores.mjs >> "logs\nba-tracker.log" 2>&1
"C:\Program Files\nodejs\node.exe" scripts\build-nba-team-tracker.mjs >> "logs\nba-tracker.log" 2>&1
echo === %date% %time% end === >> "logs\nba-tracker.log"
echo === %date% %time% end exit=%rc% === >> "logs\grade.log"
exit /b %rc%
