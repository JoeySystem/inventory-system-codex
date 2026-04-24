@echo off
title OvO System Health Check
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "MAX_RETRIES=%~1"
if "%MAX_RETRIES%"=="" set "MAX_RETRIES=10"

cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

echo.
echo ======================================================
echo   OvO System Health Check
echo ======================================================
echo   URL: %HEALTH_URL%
echo   Retries: %MAX_RETRIES%
echo.

set /a RETRY=0
:retry
set /a RETRY+=1
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%HEALTH_URL%' -TimeoutSec 5; if ($r.StatusCode -eq 200) { Write-Host '[OK] Health check passed'; exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% equ 0 (
    exit /b 0
)

if !RETRY! geq %MAX_RETRIES% (
    echo [X] Health check failed after %MAX_RETRIES% attempt(s): %HEALTH_URL%
    exit /b 1
)

echo [!] Health check failed, retry !RETRY!/%MAX_RETRIES%...
timeout /t 2 /nobreak >nul
goto :retry
