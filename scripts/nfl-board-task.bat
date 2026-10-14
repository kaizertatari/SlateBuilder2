@echo off
REM Wrapper for Scheduled Task "NFL Refresh Board" (00:40 / 06:40 / 12:40 /
REM 18:40 local - after "EPL Refresh Board" at :20, so the browser scrapes
REM never share the PrizePicks profile at once). Scrapes the PrizePicks NFL
REM board -> data\nfl-pp-lines.json; refuses to write an empty board (PX
REM slider) or one whose props don't carry NFL teams (wrong league id),
REM leaving the last good board for the sweeps. --push also writes the Blob
REM copy the deployed app reads FIRST (api/_lib/nfl/store.js nflLinesStore).
REM Output -> logs\nfl-board.log.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\nfl-board.log"
echo === %date% %time% start === >> "logs\nfl-board.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-nfl-prizepicks.mjs --push >> "logs\nfl-board.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\nfl-board.log"
exit /b %rc%
