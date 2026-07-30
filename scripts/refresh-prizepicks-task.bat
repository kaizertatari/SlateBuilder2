@echo off
REM Wrapper invoked by Windows Task Scheduler to refresh PrizePicks lines.
REM Scrapes NBA + WNBA from this machine's residential IP (Vercel's iad1 is
REM 403'd) and pushes to Vercel Blob; deployed Fluid Compute instances read
REM the blob.
REM
REM Path is derived from the .bat's own location (%~dp0 = scripts\), so this
REM runs against whichever checkout the .bat lives in (Slate Builder), matching
REM refresh-odds-task.bat. (It was previously HARDCODED to the retired
REM Props_Generator checkout — a scheduled run silently executing stale code.)
REM Output is appended to logs\refresh.log for postmortem.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\refresh.log"
echo === %date% %time% start === >> "logs\refresh.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-prizepicks.mjs >> "logs\refresh.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\refresh.log"
exit /b %rc%
