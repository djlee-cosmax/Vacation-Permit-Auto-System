@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ============================================================
echo  COSMAX 휴가증 자동화 — 초기 설치
echo ============================================================
echo.

REM Python 확인
where python > nul 2>&1
if errorlevel 1 (
    echo [에러] Python이 설치되어 있지 않습니다.
    echo https://www.python.org/downloads/ 에서 Python 3.10 이상 설치 후 다시 실행해 주세요.
    echo 설치 시 "Add Python to PATH" 옵션을 반드시 체크하세요.
    pause
    exit /b 1
)

echo [1/2] 필수 패키지 설치 중 (Playwright)...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [에러] 패키지 설치 실패. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
)

echo.
echo [2/2] Microsoft Edge 드라이버 설치 중...
python -m playwright install msedge
if errorlevel 1 (
    echo [에러] Edge 드라이버 설치 실패.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  설치 완료
echo ============================================================
echo.
echo 이제 run.bat을 실행하여 사용하실 수 있습니다.
echo 처음 실행 시 그룹웨어에 직접 로그인해 주세요. (1회만)
echo.
pause
