@echo off
REM Wrapper for Scheduled Task "EPL Matchday Sweep" (every 30 min, 04:30-16:00
REM local). scripts\epl-matchday.mjs is a quiet no-op unless an EPL fixture
REM kicks off within 90 min; then it refreshes DK/FD odds and sweeps the EPL
REM board to Axiom. Output (only when it acts) -> logs\epl-matchday.log.
REM Self-locating (%%~dp0 = scripts\) like the other task wrappers. Registered
REM via conhost.exe --headless so the 30-minute cadence never flashes a window.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
"C:\Program Files\nodejs\node.exe" scripts\epl-matchday.mjs >> "logs\epl-matchday.log" 2>&1
exit /b %ERRORLEVEL%
