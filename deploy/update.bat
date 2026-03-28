@echo off
title OvO System Update
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "TARGET_REF=%~1"

echo.
echo ======================================================
echo   OvO System Code Update
echo ======================================================
echo.

cd /d "%PROJECT_DIR%"
for /f "usebackq tokens=1,* delims==" %%A in (`node deploy/print-deploy-config.js`) do set "%%A=%%B"

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Git not found. Please install Git first.
    pause
    exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js not found. Please install Node.js first.
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] npm not found. Please reinstall Node.js.
    pause
    exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Current directory is not a Git repository:
    echo     %PROJECT_DIR%
    pause
    exit /b 1
)

echo [1/5] Fetching remote updates...
git fetch --all --tags
if %errorlevel% neq 0 (
    echo [X] git fetch failed
    pause
    exit /b 1
)

if not "%TARGET_REF%"=="" (
    echo [2/5] Checking out target ref: %TARGET_REF%
    git checkout "%TARGET_REF%"
    if %errorlevel% neq 0 (
        echo [X] Failed to checkout %TARGET_REF%
        pause
        exit /b 1
    )
) else (
    echo [2/5] Pulling latest code from current branch...
    git pull --ff-only
    if %errorlevel% neq 0 (
        echo [X] git pull failed
        echo     Please resolve local changes or branch divergence first.
        pause
        exit /b 1
    )
)

echo [3/5] Installing production dependencies...
call npm install --production
if %errorlevel% neq 0 (
    echo [X] npm install failed
    pause
    exit /b 1
)

echo [4/5] Running deployment preflight...
call npm run preflight
if %errorlevel% neq 0 (
    echo [X] Preflight failed
    pause
    exit /b 1
)

echo [5/5] Verifying configured database path...
if not exist "%DB_FILE%" (
    echo [!] Database file not found at configured path:
    echo     %DB_FILE%
    echo [!] Update succeeded, but database initialization or migration may still be required.
) else (
    echo [OK] Database path: %DB_FILE%
)

echo Update complete
for /f "tokens=*" %%i in ('git rev-parse --short HEAD') do set GIT_SHA=%%i
echo [OK] Current revision: %GIT_SHA%
echo.
echo Update finished. If service is running, restart it to apply the new code.
echo.
pause
