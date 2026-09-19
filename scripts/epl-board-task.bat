@echo off
REM Wrapper for Scheduled Task "EPL Refresh Board" (00:20 / 06:20 / 12:20 /
REM 18:20 local - 20 min after "PrizePicks Refresh Lines", so the two browser
REM scrapes never share the PrizePicks profile at once). Scrapes the PrizePicks
REM EPL board (league 14) -> data\epl-pp-lines.json; refuses to write an empty
REM board (PerimeterX slider), leaving the last good board for the sweeps.
REM Output -> logs\epl-board.log.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
echo. >> "logs\epl-board.log"
echo === %date% %time% start === >> "logs\epl-board.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-epl-prizepicks.mjs >> "logs\epl-board.log" 2>&1
set "rc=%ERRORLEVEL%"
echo === %date% %time% end exit=%rc% === >> "logs\epl-board.log"
exit /b %rc%
