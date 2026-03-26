@echo off
title OvO System Database Backup

set "PROJECT_DIR=%~dp0.."
set "BACKUP_DIR=%PROJECT_DIR%\backups"
pushd "%PROJECT_DIR%"
for /f "usebackq delims=" %%I in (`node -e "const p=require('./server/config/paths'); console.log(p.getDbPath())"`) do set "DB_FILE=%%I"
popd

:: Generate timestamp
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set TIMESTAMP=%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%_%datetime:~8,2%%datetime:~10,2%%datetime:~12,2%

:: Create backup directory
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

:: Check database file
if not exist "%DB_FILE%" (
    echo [X] Database file not found: %DB_FILE%
    pause
    exit /b 1
)

:: WAL checkpoint before backup
echo Backing up database...
cd /d "%PROJECT_DIR%"
node -e "const db=require('./server/db/database').getDB(); db.pragma('wal_checkpoint(TRUNCATE)'); console.log('[OK] WAL checkpoint done'); require('./server/db/database').closeDB();" 2>nul

set "BACKUP_FILE=%BACKUP_DIR%\inventory_%TIMESTAMP%.db"
copy "%DB_FILE%" "%BACKUP_FILE%" >nul

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

pause
