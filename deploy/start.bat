@echo off
title OvO System Server
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>&1

echo.
echo   OvO System Inventory System
echo   Press Ctrl+C to stop the server
echo   URL: %APP_BASE_URL%
echo.

node server/index.js
pause
