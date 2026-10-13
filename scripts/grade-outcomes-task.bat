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
"C:\Program Files\nodejs\node.exe" scripts\grade-outcomes.mjs >> "logs\grade.log" 2>&1
set "rc=%ERRORLEVEL%"
"C:\Program Files\nodejs\node.exe" scripts\export-graded.mjs >> "logs\grade.log" 2>&1
if errorlevel 1 set "rc=1"
REM Cross-league calibration report over data\graded\ (latest copy alone).
"C:\Program Files\nodejs\node.exe" scripts\calibration-all.mjs > "logs\calibration-latest.txt" 2>&1
echo === %date% %time% end exit=%rc% === >> "logs\grade.log"
exit /b %rc%
