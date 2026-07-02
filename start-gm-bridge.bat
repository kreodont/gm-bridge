@echo off
rem gm-bridge launcher for Windows (codex backend — the claude backend needs WSL/tmux).
rem Double-click to start; keep this window open while playing.

cd /d "%~dp0"
set GM_BACKEND=codex-mcp

echo Starting gm-bridge (codex backend) on http://localhost:8799 ...
echo Log file: %USERPROFILE%\.claude\gm-bridge.log
echo.

call npm start

echo.
echo gm-bridge exited. See the messages above and the log file:
echo   %USERPROFILE%\.claude\gm-bridge.log
pause
