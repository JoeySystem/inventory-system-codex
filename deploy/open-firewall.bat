@echo off

:: Check admin privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Administrator privileges required. Right-click and "Run as administrator"
    pause
    exit /b 1
)

echo Opening Windows Firewall port 3000 (for LAN access)...

netsh advfirewall firewall add rule name="OvO System (TCP 3000)" dir=in action=allow protocol=tcp localport=3000

if %errorlevel% equ 0 (
    echo.
    echo [OK] Firewall rule added!
    echo      Other computers on LAN can access via http://THIS_PC_IP:3000
) else (
    echo [X] Failed to add firewall rule
)

pause
