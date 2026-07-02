@echo off
rem gm-bridge launcher for Windows (codex backend — the claude backend needs WSL/tmux).
rem Double-click to start; keep this window open while playing.

cd /d "%~dp0"
set GM_BACKEND=codex-mcp
if not defined GM_PORT set GM_PORT=8799

rem If a previous (possibly hung) bridge still holds the port, kill it first —
rem otherwise the new instance exits with "port already in use".
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%GM_PORT% " ^| findstr LISTENING') do (
    echo Killing previous bridge instance ^(pid %%p^) holding port %GM_PORT%...
    taskkill /F /PID %%p >nul 2>&1
)

echo Starting gm-bridge (codex backend) on http://localhost:%GM_PORT% ...
echo Log file: %USERPROFILE%\.claude\gm-bridge.log
echo.

call npm start

echo.
echo gm-bridge exited. See the messages above and the log file:
echo   %USERPROFILE%\.claude\gm-bridge.log
pause
