@echo off
title OvO System Database Restore

set "PROJECT_DIR=%~dp0.."
set "BACKUP_DIR=%PROJECT_DIR%\backups"
pushd "%PROJECT_DIR%"
for /f "usebackq delims=" %%I in (`node -e "const p=require('./server/config/paths'); console.log(p.getDbPath())"`) do set "DB_FILE=%%I"
popd

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
echo     Current database will be backed up as inventory_before_restore.db
set /p CONFIRM=Are you sure? (Y/N):

if /i not "%CONFIRM%"=="Y" (
    echo Cancelled
    pause
    exit /b 0
)

:: Backup current database
if exist "%DB_FILE%" (
    copy "%DB_FILE%" "%BACKUP_DIR%\inventory_before_restore.db" >nul
    echo [OK] Current database backed up
)

:: Stop service
call "%~dp0stop.bat" >nul 2>&1

:: Restore
copy /Y "%RESTORE_FILE%" "%DB_FILE%" >nul
echo [OK] Database restored from: %BACKUP_NAME%
echo.
echo Please restart the service: start.bat
pause
