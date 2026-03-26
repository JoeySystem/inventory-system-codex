@echo off
echo Stopping OvO System service...

:: Method 1: Stop Windows service
net stop "OvO System" 2>nul
if %errorlevel% equ 0 (
    echo [OK] Windows service stopped
    goto :done
)

:: Method 2: Kill process on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo [OK] Killing process PID: %%a
    taskkill /F /PID %%a 2>nul
)

:done
echo [OK] Done
pause
