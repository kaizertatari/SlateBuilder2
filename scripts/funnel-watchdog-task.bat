@echo off
REM Wrapper invoked by Windows Task Scheduler ("Funnel Watchdog", every
REM 15 min) to detect and self-heal the Tailscale funnel zombie that
REM strands the deployed REFRESH LINES button (bridge healthy, funnel
REM claims on, Vercel gets "Home bridge unreachable"). Probes the deployed
REM /api/refresh-lines?ping=1 and only resets the funnel on the zombie
REM signature. Output appended to logs\funnel-watchdog.log.
REM
REM Path is derived from the .bat's own location (%~dp0 = scripts\), so this
REM runs correctly from whichever checkout it lives in with no edit.

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
"C:\Program Files\nodejs\node.exe" scripts\funnel-watchdog.mjs >> "logs\funnel-watchdog.log" 2>&1
exit /b %ERRORLEVEL%
