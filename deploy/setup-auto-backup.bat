@echo off
title OvO System Auto Backup Setup

:: Check admin privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges required. Right-click and "Run as administrator"
    pause
    exit /b 1
)

set "BACKUP_SCRIPT=%~dp0backup.bat"

echo Setting up daily auto-backup scheduled task...
echo Backup time: 3:00 AM daily
echo.

:: Create Windows scheduled task: daily at 3:00 AM
schtasks /create /tn "OvO System_DailyBackup" /tr "\"%BACKUP_SCRIPT%\" /quiet" /sc daily /st 03:00 /rl highest /f

if %errorlevel% equ 0 (
    echo.
    echo [OK] Auto-backup task created!
    echo      Task name: OvO System_DailyBackup
    echo      Schedule:  Daily at 03:00
    echo      Script:    %BACKUP_SCRIPT%
    echo.
    echo      Manage in "Task Scheduler" to view or modify
) else (
    echo [X] Failed to create scheduled task
)

pause
