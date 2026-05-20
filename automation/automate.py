"""
휴가증 자동 반영 — COSMAX COIN 그룹웨어
사용법: run.bat 더블클릭 → JSON 파일 선택 → 자동으로 Edge가 열리고 신청서 등록
"""

import json
import sys
import traceback
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

GROUPWARE_URL = "https://coin.cosmax.com/"
SCRIPT_DIR = Path(__file__).resolve().parent
PROFILE_DIR = SCRIPT_DIR / "profile"
LOG_FILE = SCRIPT_DIR / "last_error.log"


def log_error(stage: str, exc: Exception):
    """에러를 로그 파일에 기록 (사용자가 보내주기 편하게)"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n[{ts}] 단계: {stage}\n")
        f.write(f"에러 타입: {type(exc).__name__}\n")
        f.write(f"에러 메시지: {exc}\n")
        f.write("스택 트레이스:\n")
        traceback.print_exc(file=f)
        f.write("=" * 60 + "\n")


# ------------------------------------------------------------------
# 파일 선택 다이얼로그
# ------------------------------------------------------------------
def select_json_file() -> str | None:
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askopenfilename(
        title="휴가증 JSON 파일 선택",
        filetypes=[("JSON 파일", "*.json"), ("모든 파일", "*.*")],
        initialdir=str(Path.home() / "Downloads"),
    )
    root.destroy()
    return path or None


def show_info(title: str, msg: str):
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showinfo(title, msg)
    root.destroy()


def show_error(title: str, msg: str):
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showerror(title, msg)
    root.destroy()


def confirm(title: str, msg: str) -> bool:
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    answer = messagebox.askyesno(title, msg)
    root.destroy()
    return answer


# ------------------------------------------------------------------
# 자동화 본체
# ------------------------------------------------------------------
CURRENT_STAGE = ""  # 디버깅용 — 현재 진행 중인 단계

def set_stage(stage: str):
    global CURRENT_STAGE
    CURRENT_STAGE = stage
    print(f"  >> {stage}")


def register_application(page, application: dict, app_idx: int, total_apps: int):
    """한 신청서(applications 배열의 한 항목) 등록"""
    gw_type = application["groupwareType"]
    entries = application["entries"]
    print(f"\n[{app_idx}/{total_apps}] '{gw_type}' 신청서 — 인원 {len(entries)}명")

    # 1. 신청서 메뉴 (상단)
    set_stage("(1) 상단 '신청서' 메뉴 클릭")
    page.get_by_role("link", name="신청서").first.click()
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)

    # 2. 좌측 메뉴 — 근태/휴가신청
    set_stage("(2) 좌측 메뉴 '근태/휴가신청' 클릭")
    page.get_by_text("근태/휴가신청", exact=True).click()
    page.wait_for_timeout(800)

    # 3. 신청서추가 버튼
    set_stage("(3) '신청서추가' 버튼 클릭")
    page.get_by_role("button", name="신청서추가").click()
    page.wait_for_timeout(800)

    # 4. 추가 버튼 (직원찾기 모달 열기)
    set_stage("(4) '추가' 버튼 클릭 (직원찾기 모달 열기)")
    page.get_by_role("button", name="추가").click()
    page.wait_for_timeout(800)

    # 5. 직원찾기 모달에서 "기존데이터유지" 체크박스 체크
    keep_check = page.locator("label:has-text('기존데이터유지') input[type='checkbox']")
    if not keep_check.is_checked():
        keep_check.check()
        page.wait_for_timeout(200)

    # 6. 각 entry의 이름을 순차적으로 검색 & 추가
    search_input = page.locator("input").filter(has_text="").nth(0)  # 임시 — 실제론 사번/성명 input
    # 더 안전한 셀렉터: 사번/성명 라벨 옆 input
    search_input = page.locator("xpath=//*[contains(text(), '사번/성명') or contains(text(), '성명')]/following::input[1]").first

    for entry in entries:
        name = entry["name"]
        print(f"  - {name} 검색 중...")
        # 입력 후 Enter (기존 데이터 유지 체크되어 있으므로 누적됨)
        search_input.fill("")
        search_input.fill(name)
        search_input.press("Enter")
        page.wait_for_timeout(700)

    # 7. 검색 결과 표의 헤더 체크박스로 전체 선택
    # tbody가 아닌 thead의 첫 번째 체크박스
    header_check = page.locator("xpath=//table//thead//input[@type='checkbox']").first
    if not header_check.is_checked():
        header_check.check()
        page.wait_for_timeout(200)

    # 8. 모달 우측 상단의 "선택" 버튼 클릭
    page.get_by_role("button", name="선택").click()
    page.wait_for_timeout(1200)

    # 9. 메인 표의 각 행에 근태구분/시작일/종료일/사유 입력
    for idx, entry in enumerate(entries):
        row = page.locator("tbody tr").nth(idx)

        # 근태구분 드롭다운 (행 안의 select 또는 커스텀 dropdown)
        # 일반 select라면 select_option, 커스텀 div라면 클릭 후 옵션 선택
        try:
            row.locator("select").first.select_option(label=gw_type)
        except Exception:
            # 커스텀 드롭다운: 화살표 클릭 → 옵션 클릭
            row.locator("xpath=.//button[contains(@class, 'dropdown') or contains(., '▼')]").first.click()
            page.wait_for_timeout(300)
            page.get_by_role("option", name=gw_type).first.click()
            page.wait_for_timeout(200)

        # 신청시작일
        start_input = row.locator("xpath=.//input[contains(@class, 'date') or @type='date' or @placeholder*='시작']").first
        start_input.fill(entry["start"].replace("-", "."))
        page.keyboard.press("Tab")
        page.wait_for_timeout(150)

        # 신청종료일
        end_input = row.locator("xpath=.//input[contains(@class, 'date') or @type='date' or @placeholder*='종료']").first
        end_input.fill(entry["end"].replace("-", "."))
        page.keyboard.press("Tab")
        page.wait_for_timeout(150)

        # 신청사유 (텍스트 입력)
        reason_input = row.locator("xpath=.//input[contains(@placeholder, '사유') or contains(@class, 'reason')]").first
        reason_input.fill(entry.get("reason", ""))
        page.wait_for_timeout(100)

    # 10. 임시저장 버튼 클릭
    page.wait_for_timeout(500)
    page.get_by_role("button", name="임시저장").click()
    page.wait_for_timeout(2000)
    print(f"  → '{gw_type}' 신청서 임시저장 완료")


def main():
    # JSON 파일 선택
    json_path = select_json_file()
    if not json_path:
        print("취소됨.")
        return

    # JSON 파싱
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        show_error("JSON 읽기 실패", f"파일을 읽을 수 없습니다.\n{e}")
        return

    applications = data.get("applications", [])
    if not applications:
        show_info("정보", "JSON에 신청할 휴가증이 없습니다.")
        return

    total_entries = sum(len(a["entries"]) for a in applications)
    total_days = data.get("totalDays", 0)
    confirm_msg = (
        f"신청서 {len(applications)}건 / 인원 {total_entries}명 / 총 {total_days}일\n\n"
        f"자동으로 임시저장만 진행하며, 실제 신청은 그룹웨어에서 직접 검토 후 진행하셔야 합니다.\n\n"
        f"진행하시겠습니까?"
    )
    if not confirm("자동 등록 시작", confirm_msg):
        return

    PROFILE_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        print(f"Edge 실행 (영구 프로필: {PROFILE_DIR})")
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            channel="msedge",
            headless=False,
            viewport={"width": 1366, "height": 900},
            args=["--start-maximized"],
        )

        page = context.pages[0] if context.pages else context.new_page()
        page.goto(GROUPWARE_URL, wait_until="domcontentloaded")

        # 로그인 확인 (메인의 "신청서" 텍스트가 보이면 로그인 상태)
        print("로그인 상태 확인 중...")
        try:
            page.wait_for_selector("text=신청서", timeout=10000)
            print("이미 로그인된 상태로 진입.")
        except PlaywrightTimeoutError:
            show_info(
                "로그인 필요",
                "Edge 창에서 사번/비밀번호로 로그인해 주세요.\n"
                "로그인 완료 후 이 메시지를 닫으면 자동화가 진행됩니다.\n"
                "(다음 실행부터는 자동 로그인됩니다)",
            )
            # 로그인 후 다시 확인
            try:
                page.wait_for_selector("text=신청서", timeout=300000)  # 5분 대기
            except PlaywrightTimeoutError:
                show_error("로그인 실패", "로그인이 완료되지 않았습니다. 다시 실행해 주세요.")
                context.close()
                return

        # 각 신청서 처리
        success = 0
        failures = []
        for idx, application in enumerate(applications, 1):
            try:
                register_application(page, application, idx, len(applications))
                success += 1
            except Exception as e:
                failures.append((application.get("type", "?"), CURRENT_STAGE, str(e)))
                log_error(f"신청서 {idx} ({application.get('type', '?')}) - 단계: {CURRENT_STAGE}", e)
                print(f"  [실패] {application.get('type', '?')} | 단계: {CURRENT_STAGE}")
                print(f"          에러: {e}")
                traceback.print_exc()

        # 결과 보고
        if failures:
            failure_msg = "\n".join([f"- [{t}] 단계 '{stage}': {str(e)[:120]}" for t, stage, e in failures])
            show_error(
                "일부 실패",
                f"성공: {success}건 / 실패: {len(failures)}건\n\n실패 내역:\n{failure_msg}\n\n"
                f"상세 로그: {LOG_FILE}",
            )
        else:
            show_info(
                "완료",
                f"신청서 {success}건 모두 임시저장 완료.\n\n"
                f"그룹웨어에서 검토 후 직접 신청해 주세요.",
            )

        print("\n자동화 완료. Edge 창은 직접 닫아 주세요.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        log_error("main()", e)
        show_error("예기치 못한 오류", f"{e}\n\n상세 로그: {LOG_FILE}")
    finally:
        # 콘솔 창이 자동으로 닫히지 않게
        print("\n" + "=" * 60)
        print("실행 종료. 에러 메시지를 확인하셨다면 아무 키나 눌러 종료하세요.")
        print(f"에러가 있었다면 다음 파일을 확인/공유해 주세요:")
        print(f"  {LOG_FILE}")
        print("=" * 60)
        try:
            input("Press Enter to exit... ")
        except Exception:
            pass
