@echo off
REM Wrapper invoked by Windows Task Scheduler to refresh PrizePicks lines.
REM Scrapes from this machine's residential IP (Vercel's iad1 is 403'd) and
REM pushes to Vercel Blob; deployed Fluid Compute instances read the blob.
REM Output is appended to logs\refresh.log for postmortem.

setlocal
cd /d "C:\Users\aminu\OneDrive\Documents\MarkdownFiles\PrizePick\Props_Generator"
if not exist "logs" mkdir "logs"
echo. >> "logs\refresh.log"
echo === %date% %time% start === >> "logs\refresh.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-prizepicks.mjs >> "logs\refresh.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\refresh.log"
exit /b %rc%
