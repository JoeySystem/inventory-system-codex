@echo off
title OvO System Update and Restart
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "TARGET_REF=%~1"

echo.
echo ======================================================
echo   OvO System Update and Restart
echo ======================================================
echo.

cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

echo [1/6] Backing up database...
call "%~dp0backup.bat" /quiet
if %errorlevel% neq 0 (
    echo [X] Backup failed, update aborted.
    pause
    exit /b 1
)

echo [2/6] Stopping running service...
call "%~dp0stop.bat" <nul

echo [3/6] Updating code...
if not "%TARGET_REF%"=="" (
    call "%~dp0update.bat" "%TARGET_REF%" <nul
) else (
    call "%~dp0update.bat" <nul
)
if %errorlevel% neq 0 (
    echo [X] Update failed, service not restarted.
    pause
    exit /b 1
)

echo [4/6] Starting service...
call "%~dp0start-background.bat" <nul
if %errorlevel% neq 0 (
    echo [X] Failed to start service or manual process.
    pause
    exit /b 1
)

echo [5/6] Running health check...
call "%~dp0health-check.bat" 15 <nul
if %errorlevel% neq 0 (
    echo [X] Health check failed: %HEALTH_URL%
    echo [!] Please review the server window or logs before continuing.
    pause
    exit /b 1
)

echo [6/6] Update finished successfully
for /f "tokens=*" %%i in ('git rev-parse --short HEAD') do set GIT_SHA=%%i
echo [OK] Current revision: %GIT_SHA%
echo [OK] Health check passed: %HEALTH_URL%
echo.
start "" "%APP_BASE_URL%"
pause
