@echo off
title OvO System Update and Restart
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "TARGET_REF=%~1"
set "APP_URL=http://127.0.0.1:3000/api/health"

echo.
echo ======================================================
echo   OvO System Update and Restart
echo ======================================================
echo.

cd /d "%PROJECT_DIR%"

echo [1/6] Backing up database...
call "%~dp0backup.bat" <nul
if %errorlevel% neq 0 (
    echo [X] Backup failed, update aborted.
    pause
    exit /b 1
)

echo [2/6] Stopping running service...
call "%~dp0stop.bat" <nul

echo [3/6] Updating code...
if not "%TARGET_REF%"=="" (
    call "%~dp0update.bat" %TARGET_REF% <nul
) else (
    call "%~dp0update.bat" <nul
)
if %errorlevel% neq 0 (
    echo [X] Update failed, service not restarted.
    pause
    exit /b 1
)

echo [4/6] Starting service...
sc query "OvO System" >nul 2>&1
if %errorlevel% equ 0 (
    net start "OvO System" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Windows service started
    ) else (
        echo [!] Failed to start Windows service, falling back to manual start
        start "OvO System Server" cmd /c "cd /d \"%PROJECT_DIR%\" && node server/index.js"
    )
) else (
    start "OvO System Server" cmd /c "cd /d \"%PROJECT_DIR%\" && node server/index.js"
)
timeout /t 4 /nobreak >nul

echo [5/6] Running health check...
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%APP_URL%' -TimeoutSec 5; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 (
    echo [X] Health check failed: %APP_URL%
    echo [!] Please review the server window or logs before continuing.
    pause
    exit /b 1
)

echo [6/6] Update finished successfully
for /f "tokens=*" %%i in ('git rev-parse --short HEAD') do set GIT_SHA=%%i
echo [OK] Current revision: %GIT_SHA%
echo [OK] Health check passed: %APP_URL%
echo.
start http://localhost:3000
pause
