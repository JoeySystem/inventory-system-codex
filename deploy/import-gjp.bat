@echo off
title OvO System Data Import Tool

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

echo.
echo ======================================================
echo   GuanJiaPo to OvO System Data Migration Tool
echo ======================================================
echo.
echo   Please prepare Excel files exported from GuanJiaPo:
echo     1. Inventory report (.xlsx)  - Required
echo     2. BOM template (.xlsx)      - Optional
echo.
echo   Export method: Open report in GuanJiaPo - Export - Excel
echo.
echo ------------------------------------------------------
echo.

set /p INV_FILE=Drag inventory Excel file here (or enter path):
set INV_FILE=%INV_FILE:"=%

if "%INV_FILE%"=="" (
    echo [X] No file specified, exiting
    pause
    exit /b 1
)

echo.
set /p BOM_FILE=Drag BOM template Excel file here (press Enter to skip):
set BOM_FILE=%BOM_FILE:"=%

echo.
echo ======================================================
echo   Step 1: Preview mode (no data will be written)
echo ======================================================
echo.

if "%BOM_FILE%"=="" (
    node deploy/import-from-gjp.js --inventory "%INV_FILE%" --dry-run
) else (
    node deploy/import-from-gjp.js --inventory "%INV_FILE%" --bom "%BOM_FILE%" --dry-run
)

echo.
echo ======================================================
set /p CONFIRM=Preview looks correct. Proceed with import? (Y/N):

if /i not "%CONFIRM%"=="Y" (
    echo Cancelled
    pause
    exit /b 0
)

echo.
echo   Importing data...
echo.

if "%BOM_FILE%"=="" (
    node deploy/import-from-gjp.js --inventory "%INV_FILE%"
) else (
    node deploy/import-from-gjp.js --inventory "%INV_FILE%" --bom "%BOM_FILE%"
)

echo.
pause
