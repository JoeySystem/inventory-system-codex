@echo off
title OvO System Data Migration

set "PROJECT_DIR=%~dp0.."
pushd "%PROJECT_DIR%"
for /f "usebackq delims=" %%I in (`node -e "const p=require('./server/config/paths'); console.log(p.getDbPath())"`) do set "CURRENT_DB=%%I"
for /f "usebackq delims=" %%I in (`node -e "const p=require('./server/config/paths'); console.log(p.getSessionDbPath())"`) do set "SESSION_DB=%%I"
popd

echo.
echo ======================================================
echo   OvO System Data Migration Tool
echo ======================================================
echo   Migrate database from old PC to new installation
echo.
echo   Steps:
echo   1. Copy data\inventory.db from old PC to USB drive
echo   2. Run this script and specify the old database path
echo ======================================================
echo.

set /p OLD_DB=Enter old database file path (drag file here):

:: Remove quotes
set OLD_DB=%OLD_DB:"=%

if "%OLD_DB%"=="" (
    echo [X] No file specified, cancelled
    pause
    exit /b 1
)

if not exist "%OLD_DB%" (
    echo [X] File not found: %OLD_DB%
    pause
    exit /b 1
)

:: Validate SQLite database
node -e "try{require('better-sqlite3')('%OLD_DB%',{readonly:true}).prepare('SELECT 1').get();console.log('valid')}catch(e){console.log('invalid: '+e.message);process.exit(1)}" 2>nul
if %errorlevel% neq 0 (
    echo [X] The specified file is not a valid SQLite database
    pause
    exit /b 1
)

echo.
echo [OK] Database file validated

:: Backup current database
if exist "%CURRENT_DB%" (
    echo [OK] Backing up current database...
    copy "%CURRENT_DB%" "%CURRENT_DB%.bak" >nul
)

:: Stop service
call "%~dp0stop.bat" >nul 2>&1

:: Copy database
echo [OK] Importing old database...
copy /Y "%OLD_DB%" "%CURRENT_DB%" >nul

:: Delete old session data
del "%SESSION_DB%" 2>nul

echo.
echo ======================================================
echo   Data migration complete!
echo.
echo   Please run start.bat to start the system
echo   All data (materials, inventory, BOMs) has been migrated
echo   User accounts and passwords remain unchanged
echo ======================================================
echo.
pause
