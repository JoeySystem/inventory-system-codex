@echo off
title OvO System Server

set "PROJECT_DIR=%~dp0.."
cd /d "%PROJECT_DIR%"

echo.
echo   OvO System Inventory System
echo   Press Ctrl+C to stop the server
echo   URL: http://localhost:3000
echo.

node server/index.js
pause
