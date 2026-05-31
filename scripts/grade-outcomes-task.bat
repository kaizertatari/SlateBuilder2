@echo off
REM Wrapper invoked by Windows Task Scheduler to grade yesterday's verdicts.
REM Reads verdict events from Axiom, fetches final box scores from ESPN,
REM emits outcome events back to Axiom. Output appended to logs\grade.log
REM for postmortem.

setlocal
REM Self-locating (%~dp0 = scripts\), so it runs from whichever checkout it
REM lives in and reads that checkout's .env.local + writes its own logs\.
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\grade.log"
echo === %date% %time% start === >> "logs\grade.log"
"C:\Program Files\nodejs\node.exe" scripts\grade-outcomes.mjs >> "logs\grade.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\grade.log"
exit /b %rc%
