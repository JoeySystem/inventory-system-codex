@echo off
title OvO System Database Backup

set "QUIET_MODE=%~1"
set "PROJECT_DIR=%~dp0.."
set "BACKUP_DIR=%PROJECT_DIR%\backups"
pushd "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"
popd

:: Create backup directory
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Check database file
if not exist "%DB_PATH%" (
    echo [X] Database file not found: %DB_PATH%
    if /i not "%QUIET_MODE%"=="/quiet" pause
    exit /b 1
)

:: WAL checkpoint before backup
echo Backing up database...
cd /d "%PROJECT_DIR%"
node -e "const db=require('./server/db/database').getDB(); db.pragma('wal_checkpoint(TRUNCATE)'); console.log('[OK] WAL checkpoint done'); require('./server/db/database').closeDB();" 2>nul

set "BACKUP_FILE=%BACKUP_DIR%\inventory_%TIMESTAMP%.db"
copy "%DB_PATH%" "%BACKUP_FILE%" >nul

if %errorlevel% equ 0 (
    echo.
    echo ======================================================
    echo   Backup successful!
    echo ======================================================
    echo   File: %BACKUP_FILE%
    for %%A in ("%BACKUP_FILE%") do echo   Size: %%~zA bytes
    echo.
) else (
    echo [X] Backup failed!
)

:: Clean up backups older than 30 days
echo Cleaning up old backups (30+ days)...
forfiles /p "%BACKUP_DIR%" /m "inventory_*.db" /d -30 /c "cmd /c echo Deleting old backup: @file && del @path" 2>nul

if /i not "%QUIET_MODE%"=="/quiet" pause
