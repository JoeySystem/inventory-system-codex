@echo off
title OvO System Rollback
setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0.."
set "TARGET_REF=%~1"
set "TARGET_BACKUP=%~2"

echo.
echo ======================================================
echo   OvO System Rollback
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

git rev-parse --is-inside-work-tree >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Current directory is not a Git repository:
    echo     %PROJECT_DIR%
    pause
    exit /b 1
)

set "BACKUP_DIR=%PROJECT_DIR%\backups"

if "%TARGET_REF%"=="" (
    echo [X] Missing target ref.
    echo Usage:
    echo   rollback.bat ^<git-tag-or-commit^> [backup-file-name]
    echo Example:
    echo   rollback.bat v1.0.3 inventory_2026-03-26_103000.db
    pause
    exit /b 1
)

if not exist "%BACKUP_DIR%" (
    echo [X] Backup directory not found:
    echo     %BACKUP_DIR%
    pause
    exit /b 1
)

if "%TARGET_BACKUP%"=="" (
    echo Available backup files:
    echo.
    for /f "tokens=*" %%f in ('dir /b /o-d "%BACKUP_DIR%\inventory_*.db" 2^>nul') do echo   %%f
    echo.
    set /p TARGET_BACKUP=Enter backup filename to restore:
)

if "%TARGET_BACKUP%"=="" (
    echo [X] No backup file specified.
    pause
    exit /b 1
)

set "RESTORE_FILE=%BACKUP_DIR%\%TARGET_BACKUP%"
if not exist "%RESTORE_FILE%" (
    echo [X] Backup file not found:
    echo     %RESTORE_FILE%
    pause
    exit /b 1
)

echo [1/7] Stopping running service...
call "%~dp0stop.bat" <nul

echo [2/7] Backing up current database before rollback...
if exist "%DB_FILE%" (
    copy "%DB_FILE%" "%BACKUP_DIR%\inventory_before_rollback_!TIMESTAMP!.db" >nul
    echo [OK] Current database backed up
) else (
    echo [!] Current database not found, skipping pre-rollback backup
)

echo [3/7] Checking out target ref: %TARGET_REF%
git fetch --all --tags
git checkout "%TARGET_REF%"
if %errorlevel% neq 0 (
    echo [X] Failed to checkout %TARGET_REF%
    pause
    exit /b 1
)

echo [4/7] Installing production dependencies...
call npm install --production
if %errorlevel% neq 0 (
    echo [X] npm install failed
    pause
    exit /b 1
)

echo [5/7] Running deployment preflight...
call npm run preflight
if %errorlevel% neq 0 (
    echo [X] Preflight failed
    pause
    exit /b 1
)

echo [6/7] Restoring database backup...
if not exist "%DB_DIR%" mkdir "%DB_DIR%"
copy /Y "%RESTORE_FILE%" "%DB_FILE%" >nul
if %errorlevel% neq 0 (
    echo [X] Failed to restore database
    pause
    exit /b 1
)
echo [OK] Database restored from %TARGET_BACKUP%

echo [7/7] Starting service and running health check...
sc query "OvO System" >nul 2>&1
if %errorlevel% equ 0 (
    net start "OvO System" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Windows service started
        if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>&1
    ) else (
        echo [!] Failed to start Windows service, falling back to manual start
        powershell -NoProfile -Command ^
          "$p = Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory '%PROJECT_DIR%' -PassThru; New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName('%PID_FILE%')) | Out-Null; Set-Content -Path '%PID_FILE%' -Value $p.Id"
    )
) else (
    powershell -NoProfile -Command ^
      "$p = Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory '%PROJECT_DIR%' -PassThru; New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName('%PID_FILE%')) | Out-Null; Set-Content -Path '%PID_FILE%' -Value $p.Id"
)
timeout /t 4 /nobreak >nul

powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing '%APP_URL%' -TimeoutSec 5; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel% neq 0 (
    echo [X] Health check failed after rollback: %APP_URL%
    echo [!] Please review the server window or logs.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('git rev-parse --short HEAD') do set GIT_SHA=%%i
echo [OK] Rollback finished successfully
echo [OK] Current revision: %GIT_SHA%
echo [OK] Health check passed: %APP_URL%
echo.
start "" "%APP_BASE_URL%"
pause
