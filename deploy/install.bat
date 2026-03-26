@echo off
title OvO System Installer
color 0A

echo.
echo ======================================================
echo        OvO System Inventory System - Installer
echo ======================================================
echo   This script will:
echo   1. Check Node.js environment
echo   2. Install dependencies
echo   3. Configure production environment
echo   4. Initialize database
echo   5. Register Windows auto-start service
echo ======================================================
echo.

:: ============================================
:: Step 0: Check admin privileges
:: ============================================
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges required.
    echo [!] Please right-click this file and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

:: ============================================
:: Step 1: Get project root directory
:: ============================================
set "PROJECT_DIR=%~dp0.."
pushd "%PROJECT_DIR%"
set "PROJECT_DIR=%CD%"
popd
echo [OK] Project directory: %PROJECT_DIR%
echo.

:: ============================================
:: Step 2: Check Node.js
:: ============================================
echo [1/5] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Node.js not found!
    echo.
    echo     Please install Node.js LTS first:
    echo     Download: https://nodejs.org/en/download
    echo     Recommended: 20.x LTS or 22.x LTS
    echo.
    echo     Make sure to check "Add to PATH" during installation
    echo     Then re-run this script
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js version: %NODE_VER%

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] npm not found! Please reinstall Node.js
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm -v') do set NPM_VER=%%i
echo [OK] npm version: %NPM_VER%
echo.

:: ============================================
:: Step 3: Install dependencies
:: ============================================
echo [2/5] Installing dependencies (may take a few minutes)...
cd /d "%PROJECT_DIR%"
call npm install --production 2>&1
if %errorlevel% neq 0 (
    echo [X] Dependency installation failed! Check network connection.
    echo     If in China, try setting npm mirror:
    echo     npm config set registry https://registry.npmmirror.com
    pause
    exit /b 1
)

:: Install Windows service manager
call npm install --save-dev node-windows 2>&1

:: Install MCP Server dependencies (for AI integration)
if exist "%PROJECT_DIR%\mcp-server\package.json" (
    echo [*] Installing MCP Server dependencies...
    cd /d "%PROJECT_DIR%\mcp-server"
    call npm install --production 2>&1
    cd /d "%PROJECT_DIR%"
)
echo [OK] Dependencies installed
echo.

:: ============================================
:: Step 4: Configure production environment
:: ============================================
echo [3/5] Configuring production environment...
if not exist "%PROJECT_DIR%\.env" (
    echo PORT=3000> "%PROJECT_DIR%\.env"
    echo SESSION_SECRET=%RANDOM%%RANDOM%%RANDOM%-maverick-production>> "%PROJECT_DIR%\.env"
    echo NODE_ENV=production>> "%PROJECT_DIR%\.env"
    echo DB_PATH=%PROJECT_DIR%\data\inventory.db>> "%PROJECT_DIR%\.env"
    echo SESSION_DB_DIR=%PROJECT_DIR%\data>> "%PROJECT_DIR%\.env"
    echo [OK] .env config file created
) else (
    echo [OK] .env config file already exists, skipping
)

:: Ensure data directory exists
if not exist "%PROJECT_DIR%\data" mkdir "%PROJECT_DIR%\data"
echo.

:: ============================================
:: Step 5: Initialize database
:: ============================================
echo [4/5] Initializing database...
if not exist "%PROJECT_DIR%\data\inventory.db" (
    cd /d "%PROJECT_DIR%"
    call npm run init-db
    if %errorlevel% neq 0 (
        echo [X] Database initialization failed!
        pause
        exit /b 1
    )
    echo [OK] Database initialized
) else (
    echo [OK] Database already exists, skipping (delete data\inventory.db to reinitialize)
)
echo.

:: ============================================
:: Step 6: Register Windows service
:: ============================================
echo [5/5] Registering Windows auto-start service...
cd /d "%PROJECT_DIR%"
node deploy\register-service.js
if %errorlevel% neq 0 (
    echo [!] Service registration failed (you can still run manually)
    echo [!] Use start.bat to start manually
)
echo.

:: ============================================
:: Done
:: ============================================
echo.
echo ======================================================
echo                 Installation Complete!
echo ======================================================
echo.
echo   URL:      http://localhost:3000
echo   Account:  admin
echo   Password: admin123
echo.
echo   Commands:
echo     start.bat     - Start server
echo     stop.bat      - Stop server
echo     backup.bat    - Backup database
echo.
echo   AI Integration (OpenClaw/Claude):
echo     AI Account: ai-operator / ai123456
echo     See mcp-server\README.md for config
echo.
echo   ** Please change default password after first login! **
echo.
echo ======================================================
echo.
echo Opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000
pause
