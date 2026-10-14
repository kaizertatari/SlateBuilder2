@echo off
REM Wrapper for Scheduled Task "NFL Gameday Sweep" (every 30 min, 07:00-23:30
REM local). scripts\nfl-gameday.mjs is a quiet no-op unless an NFL game kicks
REM off within 90 min; then it refreshes DK/FD odds and sweeps the NFL board
REM to Axiom (the closing prices). Output (only when it acts) ->
REM logs\nfl-gameday.log. Registered via conhost.exe --headless so the
REM 30-minute cadence never flashes a window.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
"C:\Program Files\nodejs\node.exe" scripts\nfl-gameday.mjs >> "logs\nfl-gameday.log" 2>&1
exit /b %ERRORLEVEL%
