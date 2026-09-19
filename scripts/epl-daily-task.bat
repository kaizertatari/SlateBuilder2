@echo off
REM Wrapper for Scheduled Task "EPL Daily" (07:00 local). In order:
REM   1. refresh-epl-data      FotMob matches + FPL availability (incremental)
REM   2. build-epl-model       refit data\epl-model.json (+ upcoming fixtures)
REM   3. grade-epl-outcomes    settle finished EPL verdicts from FotMob
REM   4. epl-calibration-report  progress toward unlocking the EPL slate
REM Each step runs even if an earlier one failed (a stale snapshot still
REM builds; grading is independent). Output -> logs\epl-daily.log; the latest
REM report is also written alone to logs\epl-calibration-latest.txt.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "LOG=logs\epl-daily.log"
set "NODE=C:\Program Files\nodejs\node.exe"
echo. >> "%LOG%"
echo === %date% %time% start === >> "%LOG%"
"%NODE%" scripts\refresh-epl-data.mjs >> "%LOG%" 2>&1
echo --- refresh-epl-data exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\build-epl-model.mjs >> "%LOG%" 2>&1
echo --- build-epl-model exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\grade-epl-outcomes.mjs >> "%LOG%" 2>&1
echo --- grade-epl-outcomes exit=%ERRORLEVEL% >> "%LOG%"
"%NODE%" scripts\epl-calibration-report.mjs > "logs\epl-calibration-latest.txt" 2>&1
type "logs\epl-calibration-latest.txt" >> "%LOG%"
echo === %date% %time% end === >> "%LOG%"
exit /b 0
