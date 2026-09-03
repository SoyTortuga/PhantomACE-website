@echo off
title PhantomACE Demo Server
color 0C

echo.
echo  ========================================
echo    PhantomACE Community Website Demo
echo  ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed.
    echo  Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo  Starting dev server on http://localhost:8805 ...
echo  Press Ctrl+C to stop.
echo.

start "" http://localhost:8805

npx wrangler pages dev . --port 8805 --kv MARKETPLACE

pause
