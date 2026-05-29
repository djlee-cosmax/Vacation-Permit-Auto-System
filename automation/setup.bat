@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================
echo  COSMAX Vacation Automation - Initial Setup
echo ============================================================
echo.

where python > nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed.
    echo Please install Python 3.10+ from https://www.python.org/downloads/
    echo Make sure "Add Python to PATH" is checked during installation.
    pause
    exit /b 1
)

echo [1/2] Installing Playwright package...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Package installation failed. Check internet connection.
    pause
    exit /b 1
)

echo.
echo [2/2] Installing Microsoft Edge driver...
python -m playwright install msedge
if errorlevel 1 (
    echo [ERROR] Edge driver installation failed.
    pause
    exit /b 1
)

echo.
echo [3/3] Registering vacation-auto:// URL protocol...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0register_protocol.ps1"
if errorlevel 1 (
    echo [WARN] Protocol registration failed. Web auto-run button will not work.
)

echo.
echo ============================================================
echo  Setup Complete
echo ============================================================
echo.
echo You can now run "run.bat" to use the automation.
echo On first run, please login to the groupware in Edge. (one-time only)
echo.
echo Web auto-run: Click [프로그램 실행] button on the website.
echo.
pause
