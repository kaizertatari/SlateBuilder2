@echo off
REM Wrapper invoked by Windows Task Scheduler to refresh DK+FD sharp odds.
REM Scrapes DraftKings + FanDuel from this machine's residential IP, computes
REM the no-vig consensus, writes data\odds.json and pushes to Vercel Blob so
REM the deployed slate builder prices against fresh odds. Scheduled at the same
REM cadence as the lines refresh (10 min after it) so odds and lines stay in
REM sync. Output is appended to logs\refresh-odds.log for postmortem.
REM
REM Path is derived from the .bat's own location (%~dp0 = scripts\), so this
REM runs correctly from whichever checkout it lives in (Slate Builder) with no
REM edit.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\refresh-odds.log"
echo === %date% %time% start === >> "logs\refresh-odds.log"
"C:\Program Files\nodejs\node.exe" scripts\scrape-odds.mjs >> "logs\refresh-odds.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\refresh-odds.log"
exit /b %rc%
