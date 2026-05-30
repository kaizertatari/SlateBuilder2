@echo off
REM One-time Task Scheduler wrapper for the Stage 1-5 signal-calibration check.
REM Runs the read-only calibration report (verdicts<->outcomes from Axiom) and
REM appends the output — including the SIGNAL CALIBRATION block — to
REM logs\calibration-check.log so the operator (or a future Claude session) can
REM read which signals proved out. Suggest-only; makes no changes.
REM
REM Path is self-locating (%~dp0 = scripts\), so it runs from whichever checkout
REM it lives in. Needs AXIOM_TOKEN in .env.local (the report reads it).

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\calibration-check.log"
echo === %date% %time% signal-calibration check (--lookback 120) === >> "logs\calibration-check.log"
"C:\Program Files\nodejs\node.exe" scripts\calibration-report.mjs --lookback 120 >> "logs\calibration-check.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\calibration-check.log"
exit /b %rc%
