@echo off
setlocal enabledelayedexpansion
echo Stopping OvO System service...

set "PROJECT_DIR=%~dp0.."
set "PID_FILE=%PROJECT_DIR%\run\ovo-system.pid"

:: Method 1: Stop Windows service
net stop "OvO System" 2>nul
if %errorlevel% equ 0 (
    echo [OK] Windows service stopped
    if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>&1
    goto :done
)

:: Method 2: Stop manual process from PID file
cd /d "%PROJECT_DIR%"
where node >nul 2>&1
if %errorlevel% equ 0 (
    for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"
)
if exist "%PID_FILE%" (
    set /p APP_PID=<"%PID_FILE%"
    if not "!APP_PID!"=="" (
        echo [OK] Stopping manual process PID: !APP_PID!
        taskkill /F /PID !APP_PID! >nul 2>&1
        if !errorlevel! equ 0 (
            echo [OK] Manual process stopped
        ) else (
            echo [!] PID file found, but process !APP_PID! is no longer running
        )
    )
    del /q "%PID_FILE%" >nul 2>&1
) else (
    echo [!] No Windows service or tracked manual process found
)

:done
echo [OK] Done
pause
