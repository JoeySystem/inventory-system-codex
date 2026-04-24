@echo off
title OvO System Database Restore
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "BACKUP_DIR=%PROJECT_DIR%\backups"
cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

echo.
echo   OvO System Database Restore Tool
echo   ==================================
echo.

if not exist "%BACKUP_DIR%" (
    echo [X] Backup directory not found: %BACKUP_DIR%
    pause
    exit /b 1
)

:: List available backups
echo Available backup files:
echo.
set count=0
for /f "tokens=*" %%f in ('dir /b /o-d "%BACKUP_DIR%\inventory_*.db" 2^>nul') do (
    set /a count+=1
    echo   [!count!] %%f
)

if %count% equ 0 (
    echo   No backup files found
    pause
    exit /b 1
)

echo.
set /p BACKUP_NAME=Enter backup filename to restore (or press Enter to cancel):

if "%BACKUP_NAME%"=="" (
    echo Cancelled
    pause
    exit /b 0
)

set "RESTORE_FILE=%BACKUP_DIR%\%BACKUP_NAME%"
if not exist "%RESTORE_FILE%" (
    echo [X] File not found: %RESTORE_FILE%
    pause
    exit /b 1
)

:: Confirm
echo.
echo [!] WARNING: This will overwrite the current database!
echo     Current database will be backed up before restore.
set /p CONFIRM=Are you sure? (Y/N):

if /i not "%CONFIRM%"=="Y" (
    echo Cancelled
    pause
    exit /b 0
)

:: Backup current database
if exist "%DB_PATH%" (
    if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"
    copy "%DB_PATH%" "%BACKUP_DIR%\inventory_before_restore_!TIMESTAMP!.db" >nul
    echo [OK] Current database backed up
)

:: Stop service
call "%~dp0stop.bat" >nul 2>&1

:: Restore
if not exist "%DB_DIR%" mkdir "%DB_DIR%"
copy /Y "%RESTORE_FILE%" "%DB_PATH%" >nul
if %errorlevel% neq 0 (
    echo [X] Database restore failed
    pause
    exit /b 1
)
if exist "%DB_PATH%-wal" del /q "%DB_PATH%-wal" >nul 2>&1
if exist "%DB_PATH%-shm" del /q "%DB_PATH%-shm" >nul 2>&1

echo [OK] Database restored from: %BACKUP_NAME%
echo.
echo Starting service and checking health...
call "%~dp0start-background.bat" <nul
if %errorlevel% neq 0 (
    echo [X] Failed to start service after restore
    pause
    exit /b 1
)
call "%~dp0health-check.bat" 15 <nul
if %errorlevel% neq 0 (
    echo [X] Health check failed after restore
    pause
    exit /b 1
)
echo [OK] Restore completed and system is healthy: %APP_BASE_URL%
pause
