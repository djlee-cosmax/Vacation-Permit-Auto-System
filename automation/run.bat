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

REM Web에서 vacation-auto://run 호출되면 인자에 protocol URL이 전달됨 → --auto 모드
set "AUTO_MODE="
for %%a in (%*) do (
    echo %%a | findstr /i "vacation-auto" > nul && set "AUTO_MODE=--auto"
    if /i "%%a"=="--auto" set "AUTO_MODE=--auto"
)

python automate.py %AUTO_MODE%

if errorlevel 1 (
    echo.
    echo [ERROR] An error occurred. See message above.
    pause
)
