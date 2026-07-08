@echo off
REM Runs the refresh-bridge daemon in the interactive user session via the
REM logon-triggered Scheduled Task "Refresh Bridge". Replaced the NSSM service
REM on 2026-07-07: PerimeterX now hard-403s headless Chrome launched from
REM session 0 (Windows services), and a failed session-0 scrape poisons the
REM shared .prizepicks-profile for every other scrape on the machine. The PP
REM scrape only clears PX from the logged-on desktop session, so the bridge
REM must live there too.
REM
REM Self-locating (%~dp0 = scripts\) like the other task wrappers, so it runs
REM against whichever checkout this .bat lives in. Output appends to
REM logs\refresh-bridge.{out,err}.log (no rotation — NSSM rotated at 10 MB,
REM but the bridge writes only a few lines per scrape).

setlocal
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"

REM Self-restart loop — replaces NSSM's AppExit=Restart. The 5s pause keeps a
REM crash-loop from spinning hot. Launched hidden via refresh-bridge-task.vbs
REM (a visible console window gets closed by accident, which killed the bridge
REM the first time; 0xC000013A).
:loop
echo === %date% %time% bridge start === >> "logs\refresh-bridge.out.log"
"C:\Program Files\nodejs\node.exe" scripts\refresh-bridge.mjs >> "logs\refresh-bridge.out.log" 2>> "logs\refresh-bridge.err.log"
echo === %date% %time% bridge exit rc=%ERRORLEVEL% — restarting in 5s === >> "logs\refresh-bridge.out.log"
timeout /t 5 /nobreak > NUL
goto loop
