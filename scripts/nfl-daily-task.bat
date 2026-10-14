@echo off
REM Wrapper for Scheduled Task "NFL Daily" (07:30 local, after "EPL Daily").
REM In order:
REM   1. refresh-nfl-data       nflverse stats / schedule / snaps / injuries
REM                             (nflverse rebuilds nightly)
REM   2. build-nfl-model        refit data\nfl-model.json (+ schedule, injury
REM                             report); --push updates the deployed app's copy
REM   3. scrape-nfl-odds        DK/FD props (+ Blob)
REM   4. sweep-nfl-board        log the whole upcoming board = the OPENING
REM                             prices the grader's CLV compares against
REM   5. grade-nfl-outcomes     settle finished NFL verdicts from nflverse
REM   6. export-graded          NFL verdict<->outcome pairs -> data\graded\NFL\
REM   7. calibration-all        NFL section -> logs\nfl-calibration-latest.txt
REM Each step runs even if an earlier one failed (a stale snapshot still
REM builds; grading is independent). Output -> logs\nfl-daily.log.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "LOG=logs\nfl-daily.log"
set "NODE=C:\Program Files\nodejs\node.exe"
echo. >> "%LOG%"
echo === %date% %time% start === >> "%LOG%"
"%NODE%" scripts\refresh-nfl-data.mjs >> "%LOG%" 2>&1
echo --- refresh-nfl-data exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\build-nfl-model.mjs --push >> "%LOG%" 2>&1
echo --- build-nfl-model exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\scrape-nfl-odds.mjs --push >> "%LOG%" 2>&1
echo --- scrape-nfl-odds exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\sweep-nfl-board.mjs >> "%LOG%" 2>&1
echo --- sweep-nfl-board exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\grade-nfl-outcomes.mjs >> "%LOG%" 2>&1
echo --- grade-nfl-outcomes exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\export-graded.mjs --league NFL >> "%LOG%" 2>&1
echo --- export-graded exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\calibration-all.mjs --league NFL > "logs\nfl-calibration-latest.txt" 2>&1
type "logs\nfl-calibration-latest.txt" >> "%LOG%"
echo === %date% %time% end === >> "%LOG%"
exit /b 0
