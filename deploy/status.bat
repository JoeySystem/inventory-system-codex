@echo off
title OvO System Status
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

echo.
echo ======================================================
echo   OvO System Deployment Status
echo ======================================================
echo   Project: %PROJECT_DIR%
echo   App:     %APP_BASE_URL%
echo   Health:  %HEALTH_URL%
echo   DB:      %DB_PATH%
echo.

where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('node -v') do echo   Node:    %%i
) else (
    echo   Node:    [X] not found
)

where npm >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('npm -v') do echo   npm:     %%i
) else (
    echo   npm:     [X] not found
)

where git >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=*" %%i in ('git rev-parse --short HEAD 2^>nul') do echo   Git:     %%i
) else (
    echo   Git:     [X] not found
)

echo.
sc query "OvO System" >nul 2>&1
if %errorlevel% equ 0 (
    for /f "tokens=4" %%s in ('sc query "OvO System" ^| findstr "STATE"') do echo   Service: %%s
) else (
    echo   Service: not registered
)

if exist "%PID_FILE%" (
    set /p APP_PID=<"%PID_FILE%"
    echo   Manual PID: !APP_PID!
) else (
    echo   Manual PID: none
)

if exist "%DB_PATH%" (
    for %%A in ("%DB_PATH%") do echo   DB Size:  %%~zA bytes
) else (
    echo   DB Size:  [X] database file not found
)

if exist "%PROJECT_DIR%\backups" (
    for /f %%c in ('dir /b "%PROJECT_DIR%\backups\*.db" 2^>nul ^| find /c /v ""') do echo   Backups: %%c database backup file(s)
) else (
    echo   Backups: 0 database backup file(s)
)

echo.
call "%~dp0health-check.bat" 1 <nul
if %errorlevel% neq 0 (
    echo.
    echo [!] System is not reachable from the configured health URL.
    echo     If the service was just started, run deploy\health-check.bat again.
)

echo.
pause
