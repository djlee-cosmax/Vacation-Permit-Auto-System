@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================
echo  COSMAX 휴가증 자동 반영 프로그램
echo ============================================================
echo.

REM Python 존재 확인
where python > nul 2>&1
if errorlevel 1 (
    echo [에러] Python이 설치되어 있지 않습니다.
    echo setup.bat을 먼저 실행해 주세요.
    pause
    exit /b 1
)

python automate.py

if errorlevel 1 (
    echo.
    echo [오류] 실행 중 오류가 발생했습니다.
    pause
)
