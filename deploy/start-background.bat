@echo off
title OvO System Background Start
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

sc query "OvO System" >nul 2>&1
if %errorlevel% equ 0 (
    sc query "OvO System" | findstr /I "RUNNING" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Windows service is already running
        if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>&1
        exit /b 0
    )
    net start "OvO System" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Windows service started
        if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>&1
        exit /b 0
    )
    echo [!] Failed to start Windows service, falling back to tracked manual process
)

powershell -NoProfile -Command ^
  "$pidFile = '%PID_FILE%'; $p = Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory '%PROJECT_DIR%' -PassThru; New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($pidFile)) | Out-Null; Set-Content -Path $pidFile -Value $p.Id"
if %errorlevel% neq 0 (
    echo [X] Failed to start tracked manual process
    exit /b 1
)

echo [OK] Manual process started and tracked by PID file: %PID_FILE%
exit /b 0
