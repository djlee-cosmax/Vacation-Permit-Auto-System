@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================
echo  COSMAX Vacation Auto Registration
echo ============================================================
echo.

where python > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed.
    echo Please install Python from https://www.python.org/downloads/
    pause
    exit /b 1
)

python automate.py

if errorlevel 1 (
    echo.
    echo [ERROR] An error occurred. See message above.
    pause
)
