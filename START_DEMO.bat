@echo off
title PhantomACE Demo Server
echo.
echo  Starting PhantomACE Demo Server...
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  ERROR: Node.js is not installed.
    echo  Download it from https://nodejs.org
    echo.
    pause
    exit /b 1
)

start "" http://localhost:8080
node "%~dp0demo-server.js"
pause
