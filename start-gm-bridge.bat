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

rem Self-update: when this folder is a git clone and git is installed, pull the
rem latest version before starting (a ZIP install is skipped silently). --ff-only
rem never merges: with local edits to tracked files it fails, we warn and start
rem the current version instead of leaving the folder half-updated.
if exist ".git" (
    where git >nul 2>&1
    if not errorlevel 1 (
        echo Checking for gm-bridge updates...
        git pull --ff-only
        if errorlevel 1 (
            echo Could not update ^(local changes?^) - starting the current version.
        ) else (
            call npm install --omit=dev --no-audit --no-fund
        )
    )
)

echo Starting gm-bridge (codex backend) on http://localhost:%GM_PORT% ...
echo Log file: %USERPROFILE%\.claude\gm-bridge.log
echo.

call npm start

echo.
echo gm-bridge exited. See the messages above and the log file:
echo   %USERPROFILE%\.claude\gm-bridge.log
pause
