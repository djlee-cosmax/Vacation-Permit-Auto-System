"""HTML 매뉴얼을 PDF로 변환 (Playwright + Edge)

Edge 를 쓰므로 Windows 쪽 python 으로 돌려야 한다. WSL 의 python3 에는
playwright 가 없어 ModuleNotFoundError 가 난다.

    powershell> python "\\\\wsl.localhost\\Ubuntu\\home\\djlee\\cosmax\\project5\\docs\\generate_pdf.py"
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

SCRIPT_DIR = Path(__file__).resolve().parent
HTML = SCRIPT_DIR / "manual.html"
OUT_PDF = SCRIPT_DIR / "휴가증 자동 반영 프로그램 종합 매뉴얼.pdf"

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.goto(f"file:///{HTML.as_posix()}", wait_until="networkidle")
        page.pdf(
            path=str(OUT_PDF),
            format="A4",
            print_background=True,
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
        )
        browser.close()
    print(f"PDF 생성 완료: {OUT_PDF}")
    print(f"크기: {OUT_PDF.stat().st_size:,} bytes")

if __name__ == "__main__":
    main()
