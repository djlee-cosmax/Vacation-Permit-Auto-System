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
DIALOG_LOG = []     # 그룹웨어가 띄운 다이얼로그 메시지 누적 (응답/검증 메시지)
MISSING_WORKERS = []  # 그리드에 등장하지 않은 작업자 (app_idx, name, employeeId)

def set_stage(stage: str):
    global CURRENT_STAGE
    CURRENT_STAGE = stage
    print(f"  >> {stage}")


def handle_dialog(d):
    """모든 alert/confirm을 자동 수락하고 메시지를 누적"""
    msg = (d.message or "").strip()
    DIALOG_LOG.append({"type": d.type, "msg": msg})
    print(f"  [dialog] {d.type}: {msg}")
    try:
        d.accept()
    except Exception:
        pass


def is_save_success(messages: list[str]) -> bool:
    """다이얼로그 메시지 목록에서 임시저장 성공 패턴 검사"""
    for m in messages:
        if "저장되었습니다" in m or "저장 되었습니다" in m or "저장 완료" in m:
            return True
    return False


def try_click(parent, selectors: list, timeout_each: int = 3000) -> str | None:
    """여러 셀렉터를 순서대로 시도. 성공 시 사용된 셀렉터 반환, 모두 실패 시 None."""
    for sel in selectors:
        try:
            parent.locator(sel).first.click(timeout=timeout_each)
            return sel
        except Exception:
            continue
    return None


def register_application(page, application: dict, app_idx: int, total_apps: int):
    """한 신청서(applications 배열의 한 항목) 등록. 성공 시 True, 실패 시 예외."""
    category = application.get("category", "?")
    entries = application["entries"]
    # 신청서 안에 들어갈 type들 요약 표시
    type_summary = ", ".join(sorted(set(e.get("type", "?") for e in entries)))
    print(f"\n[{app_idx}/{total_apps}] '{category}' 신청서 — 인원 {len(entries)}명 ({type_summary})")

    # 이 신청서 시작 시점의 다이얼로그 인덱스
    dialog_start_idx = len(DIALOG_LOG)

    # 1. 신청서 메뉴 (상단) — 첫 신청서일 때만 (이미 신청서 화면이면 생략)
    set_stage("(1) 상단 '신청서' 메뉴 클릭")
    try:
        page.get_by_role("link", name="신청서").first.click()
        page.wait_for_load_state("domcontentloaded")
    except Exception:
        # 이미 신청서 화면일 가능성
        pass
    page.wait_for_timeout(800)

    # 2. 좌측 메뉴 — 근태/휴가신청 (#divMenu 영역으로 한정)
    set_stage("(2) 좌측 메뉴 '근태/휴가신청' 클릭")
    page.locator("#divMenu").get_by_text("근태/휴가신청").first.click()
    page.wait_for_timeout(3000)  # 메뉴 클릭 후 iframe 로드 대기

    # 콘텐츠는 동적 iframe(iframe_biz_*) 안에서 로드됨 → 그 iframe 컨텍스트로 진입
    content = page.frame_locator('iframe[name*="iframe_biz"]').last

    # 3. 신청서추가 버튼 — iframe 안에서 찾기 + popup/새 페이지 감지
    set_stage("(3) '신청서추가' 버튼 클릭 (iframe 안)")
    pages_before = set(page.context.pages)
    frames_before_count = len(page.frames)
    try:
        with page.context.expect_page(timeout=3000) as popup_info:
            content.get_by_text("신청서추가").first.click()
        new_page = popup_info.value
        print(f"    → 새 페이지(popup) 열림: {new_page.url}")
        new_page.wait_for_load_state("domcontentloaded")
        # 새 페이지가 작업 대상이 됨 (단, 일부 그룹웨어는 iframe 안에서 작업)
        work_page = new_page
        work_context = new_page  # 새 페이지의 main_frame
    except PlaywrightTimeoutError:
        # popup 안 열림 → 같은 페이지에서 iframe이 추가됐을 가능성
        print(f"    → popup 없음 (frames {frames_before_count} → {len(page.frames)})")
        work_page = page
        work_context = page

    page.wait_for_timeout(2000)  # 모달/iframe 로딩 대기

    # 모달이 iframe으로 떴는지 확인 (보통 iframe01 또는 다른 이름)
    # 모든 iframe을 순회하면서 "추가" 버튼이 있는 곳 찾기
    target_frame = None
    for f in work_page.frames:
        if f == work_page.main_frame:
            continue
        try:
            if f.locator('[title="추가"], input[value="추가"], button:has-text("추가"), a:has-text("추가")').count() > 0:
                target_frame = f
                print(f"    → '추가' 버튼이 있는 iframe 발견: name={f.name}, url={f.url[:60]}")
                break
        except Exception:
            continue

    # 4. 추가 버튼 클릭
    set_stage("(4) '추가' 버튼 클릭 (직원찾기 모달 열기)")
    parent = target_frame if target_frame else work_context
    used = try_click(parent, [
        'input[type="button"][value="추가"]',
        'input[value="추가"]',
        'button[title="추가"]',
        '[title="추가"]',
        'button:has-text("추가")',
        'a:has-text("추가")',
        '[onclick*="emp"]',
        '[onclick*="popup"]',
    ])
    if not used:
        raise Exception("'추가' 버튼(직원찾기 모달 열기)을 찾을 수 없습니다. iframe HTML을 확인해 주세요.")
    print(f"    매칭된 셀렉터: {used}")
    page.wait_for_timeout(1500)

    # 직원찾기 모달은 dialogframe_* iframe 안에 있음
    dialog = page.frame_locator('iframe[name^="dialogframe"]').last

    # 5. 기존데이터유지 체크
    set_stage("(5) 기존데이터유지 체크")
    keep_check = dialog.locator("#S_APPEND_YN")
    if not keep_check.is_checked():
        keep_check.check()
    page.wait_for_timeout(400)

    # 6. 각 entry를 순차 검색 — 사번 우선 (동명이인 회피), 없으면 이름
    name_input = dialog.locator("#S_EMP_NM")
    for entry in entries:
        nm = entry["name"]
        emp_id = entry.get("employeeId") or ""
        search_value = emp_id if emp_id else nm
        set_stage(f"(6) 직원 검색: {nm} ({search_value})")
        name_input.fill("")
        name_input.fill(search_value)
        name_input.press("Enter")
        page.wait_for_timeout(900)

    # 7. sheet1 그리드의 전체 선택 — JS API 호출 시도
    set_stage("(7) 검색 결과 전체 선택 (CCHK)")
    # dialog_frame을 직접 가져와서 evaluate
    dialog_frame_obj = None
    for f in page.frames:
        if f.name and f.name.startswith("dialogframe"):
            dialog_frame_obj = f
            break
    if dialog_frame_obj is None:
        raise Exception("dialogframe(직원찾기) 프레임을 찾을 수 없습니다.")
    # sheet1의 모든 행을 체크 (CCHK = 선택 컬럼)
    try:
        dialog_frame_obj.evaluate("""
            (() => {
                const rowCount = sheet1.RowCount();
                const headerRow = sheet1.HeaderRows();
                for (let r = headerRow; r < headerRow + rowCount; r++) {
                    sheet1.SetCellValue(r, "CCHK", 1, 1);
                }
            })()
        """)
    except Exception as ge:
        print(f"    sheet1 전체 선택 JS 실패 → 헤더 체크박스 직접 클릭 시도: {ge}")
        # 백업: 그리드 헤더의 체크박스 클릭
        try:
            dialog.locator('input[type="checkbox"]').first.check()
        except Exception:
            pass
    page.wait_for_timeout(400)

    # 8. 선택 버튼 (#choose01)
    set_stage("(8) 선택 버튼 클릭")
    dialog.locator("#choose01").click()
    page.wait_for_timeout(1500)

    # 9. 신청서 표 입력 — iframe01 안의 IBSheet 그리드 (JS API 사용)
    set_stage("(9) 신청서 표 입력 (근태구분/기간/사유)")
    iframe01_obj = None
    for f in page.frames:
        if f.name == "iframe01":
            iframe01_obj = f
            break
    if iframe01_obj is None:
        raise Exception("iframe01(신청서 작성 화면)을 찾을 수 없습니다.")

    # 그리드의 현재 행 정보 조회 (EMP_NM 매칭용)
    rows_info = iframe01_obj.evaluate("""
        (() => {
            const g = (typeof Grids !== 'undefined' && Grids[0]) || sheet1;
            const hr = g.HeaderRows();
            const rc = g.RowCount();
            const out = [];
            for (let r = hr; r < hr + rc; r++) {
                out.push({
                    rowIdx: r,
                    empNm: g.GetCellValue(r, "EMP_NM"),
                    empId: g.GetCellValue(r, "EMP_ID")
                });
            }
            return out;
        })()
    """)
    print(f"    그리드 행 {len(rows_info)}개 발견")

    # 각 entry를 사번(EMP_ID) 우선, 없으면 이름(EMP_NM)으로 매칭하여 SetCellValue로 입력
    for entry in entries:
        nm = entry["name"]
        emp_id = entry.get("employeeId") or ""
        entry_gw_type = entry.get("groupwareType") or entry.get("type") or ""
        matched = None
        if emp_id:
            matched = next((r for r in rows_info if str(r.get("empId") or "") == emp_id), None)
        if not matched:
            matched = next((r for r in rows_info if r.get("empNm") == nm), None)
        if not matched:
            print(f"    [경고] {nm}({emp_id}) 그리드에서 찾지 못함 — 그룹웨어 직원 명단에 없거나 검색 실패")
            MISSING_WORKERS.append({"app_idx": app_idx, "name": nm, "employeeId": emp_id, "type": entry_gw_type})
            continue
        row_idx = matched["rowIdx"]
        start_ymd = entry["start"].replace("-", "")  # 20260521
        end_ymd = entry["end"].replace("-", "")
        reason = (entry.get("reason") or "").replace("`", "'").replace("\\", "\\\\")
        phone = entry.get("phone") or ""
        iframe01_obj.evaluate(f"""
            (() => {{
                const g = (typeof Grids !== 'undefined' && Grids[0]) || sheet1;
                g.SetCellValue({row_idx}, "ATTEND_CD", "{entry_gw_type}", 1);
                g.SetCellValue({row_idx}, "STA_YMD", "{start_ymd}", 1);
                g.SetCellValue({row_idx}, "END_YMD", "{end_ymd}", 1);
                g.SetCellValue({row_idx}, "ATTEND_RSN_TXT", `{reason}`, 1);
                g.SetCellValue({row_idx}, "EGC_TEL_NO", "{phone}", 1);
                try {{
                    const status = g.GetRowStatus({row_idx});
                    if (status === 'R' || status === 'N' || !status) {{
                        g.SetRowStatus({row_idx}, 'I');
                    }}
                }} catch (e) {{}}
            }})()
        """)
        verify = iframe01_obj.evaluate(f"""
            (() => {{
                const g = (typeof Grids !== 'undefined' && Grids[0]) || sheet1;
                return {{
                    attend: g.GetCellValue({row_idx}, "ATTEND_CD"),
                    sta:    g.GetCellValue({row_idx}, "STA_YMD"),
                    end:    g.GetCellValue({row_idx}, "END_YMD"),
                    rsn:    g.GetCellValue({row_idx}, "ATTEND_RSN_TXT"),
                    tel:    g.GetCellValue({row_idx}, "EGC_TEL_NO"),
                    status: (function(){{ try {{ return g.GetRowStatus({row_idx}); }} catch(e) {{ return '?'; }} }})()
                }};
            }})()
        """)
        print(f"    {nm} (행 {row_idx}, {entry_gw_type}) 입력값: {verify}")

    # 10. 임시저장 — JS 함수 직접 호출
    set_stage("(10) 임시저장 클릭")
    save_result = iframe01_obj.evaluate("""
        (() => {
            try {
                Apply.doSave();
                return { ok: true };
            } catch (e) {
                return { ok: false, err: String(e) };
            }
        })()
    """)
    print(f"    Apply.doSave() 결과: {save_result}")

    # 임시저장 처리 완료까지 대기 (confirm + alert 다이얼로그 2개 + 서버 응답)
    page.wait_for_timeout(5000)

    # "처리도중 입니다" 같은 처리 중 메시지가 사라질 때까지 추가 대기 (최대 15초)
    set_stage("(10.5) 임시저장 처리 완료 대기")
    try:
        for _ in range(30):  # 0.5초 × 30 = 15초
            still_processing = False
            try:
                # 메인 페이지나 iframe에서 처리 중 메시지 검사
                for f in page.frames:
                    try:
                        cnt = f.locator("text=처리도중").count() + f.locator("text=처리 중").count()
                        if cnt > 0:
                            still_processing = True
                            break
                    except Exception:
                        continue
            except Exception:
                break
            if not still_processing:
                break
            page.wait_for_timeout(500)
    except Exception as we:
        print(f"    (처리 대기 중 예외: {we})")

    # 임시저장 후 화면 캡처 (성공 여부 시각 확인용)
    try:
        ts = datetime.now().strftime("%H%M%S")
        shot_path = SCRIPT_DIR / f"after_save_{app_idx}_{ts}.png"
        page.screenshot(path=str(shot_path), full_page=True)
        print(f"    저장 후 캡처: {shot_path.name}")
    except Exception:
        pass

    # 다음 신청서를 위한 안전 대기 (추가 1.5초)
    page.wait_for_timeout(1500)

    # 이 신청서 동안 그룹웨어가 띄운 다이얼로그 메시지들로 성공/실패 판정
    new_dialogs = DIALOG_LOG[dialog_start_idx:]
    dialog_msgs = [d["msg"] for d in new_dialogs]
    if is_save_success(dialog_msgs):
        print(f"  → '{category}' 신청서 임시저장 완료")
    else:
        # 실패: '저장되었습니다' 메시지 없음 → 잔여일수 부족 등 검증 실패
        reason = " / ".join(m for m in dialog_msgs if m) or "(응답 메시지 없음)"
        raise Exception(f"임시저장 실패 — 그룹웨어 응답: {reason}")


def cleanup_debug_files():
    """이전 실행의 디버그 자료 자동 정리 (시작 시 호출)"""
    patterns = ["error_*.png", "error_*.html", "after_save_*.png"]
    removed = 0
    for pattern in patterns:
        for f in SCRIPT_DIR.glob(pattern):
            try:
                f.unlink()
                removed += 1
            except Exception:
                pass
    # last_error.log도 새로 시작 (이전 에러와 혼동 방지)
    if LOG_FILE.exists():
        try:
            LOG_FILE.unlink()
        except Exception:
            pass
    if removed > 0:
        print(f"[정리] 이전 디버그 파일 {removed}개 삭제")


def main():
    # 이전 실행의 디버그 자료 정리
    cleanup_debug_files()

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
            no_viewport=True,  # viewport 고정 해제 → 창 크기에 맞춰짐
            args=["--start-maximized"],
        )

        # alert/confirm 자동 수락 + 메시지 누적
        context.on("dialog", handle_dialog)

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
                failures.append((application.get("category", "?"), CURRENT_STAGE, str(e)))
                log_error(f"신청서 {idx} ({application.get('category', '?')}) - 단계: {CURRENT_STAGE}", e)
                print(f"  [실패] {application.get('category', '?')} | 단계: {CURRENT_STAGE}")
                print(f"          에러: {e}")
                # 에러 시점 페이지 스크린샷 자동 저장 (디버그용)
                try:
                    ts = datetime.now().strftime("%H%M%S")
                    shot_path = SCRIPT_DIR / f"error_screenshot_{ts}.png"
                    page.screenshot(path=str(shot_path), full_page=True)
                    print(f"          스크린샷 저장: {shot_path}")
                    # 메인 HTML
                    html_path = SCRIPT_DIR / f"error_page_{ts}.html"
                    html_path.write_text(page.content(), encoding="utf-8")
                    print(f"          HTML 저장: {html_path}")
                    # 모든 iframe HTML 저장 (어느 iframe에 어떤 콘텐츠가 있는지 추적)
                    try:
                        for i, frame in enumerate(page.frames):
                            if frame == page.main_frame:
                                continue
                            try:
                                safe_name = (frame.name or "noname").replace("/", "_")[:40]
                                iframe_html = SCRIPT_DIR / f"error_iframe_{ts}_{i}_{safe_name}.html"
                                iframe_html.write_text(frame.content(), encoding="utf-8")
                                print(f"          iframe[{i}] {frame.name or '(noname)'} : {iframe_html.name}")
                            except Exception as fe:
                                print(f"          iframe[{i}] 추출 실패: {fe}")
                    except Exception as ife:
                        print(f"          (iframe 순회 실패: {ife})")
                    # 추가로 열린 페이지(popup)도 저장
                    try:
                        all_pages = page.context.pages
                        for j, p2 in enumerate(all_pages):
                            if p2 == page:
                                continue
                            p2_path = SCRIPT_DIR / f"error_popup_{ts}_{j}.html"
                            p2_path.write_text(p2.content(), encoding="utf-8")
                            p2_shot = SCRIPT_DIR / f"error_popup_{ts}_{j}.png"
                            p2.screenshot(path=str(p2_shot), full_page=True)
                            print(f"          popup[{j}] {p2.url[:60]} → {p2_path.name}")
                    except Exception as pe:
                        print(f"          (popup 추출 실패: {pe})")
                except Exception as snap_err:
                    print(f"          (스크린샷 저장 실패: {snap_err})")
                traceback.print_exc()

        # 결과 보고
        # 누락 작업자 (그리드에 안 잡힌 사람) 별도 메시지
        missing_section = ""
        if MISSING_WORKERS:
            mw_lines = ["\n[!] 그리드에서 찾지 못한 작업자 (그룹웨어에 등록되지 않음)"]
            for m in MISSING_WORKERS:
                mw_lines.append(f"  - 신청서 {m['app_idx']} : {m['name']}({m['employeeId']}) / {m['type']}")
            mw_lines.append("→ 그룹웨어 직원 명단에 해당 사번이 없거나 신청서를 작성할 권한이 없을 가능성")
            mw_lines.append("→ 휴가증 사이트의 작업자 명단과 그룹웨어 명단을 비교해 주세요.")
            missing_section = "\n".join(mw_lines)

        if failures:
            lines = []
            for t, stage, e in failures:
                short = str(e)
                if "임시저장 실패" in short:
                    lines.append(f"× [{t}] {short}")
                else:
                    lines.append(f"× [{t}] 단계 '{stage}': {short[:150]}")
            failure_msg = "\n".join(lines)
            show_error(
                "일부 신청서 실패",
                f"성공: {success}건 / 실패: {len(failures)}건\n\n"
                f"실패 내역:\n{failure_msg}\n\n"
                f"※ 실패한 신청서는 그룹웨어에 들어가지 않았습니다.\n"
                f"※ 실패한 작업자의 휴가증을 확인 후 다시 작성·자동등록하거나, 그룹웨어에서 수동 처리해 주세요."
                + missing_section + "\n\n"
                f"상세 로그: {LOG_FILE}",
            )
        elif MISSING_WORKERS:
            show_info(
                "완료 (누락자 있음)",
                f"신청서 {success}건 모두 임시저장 완료.\n"
                + missing_section + "\n\n"
                f"그룹웨어에서 검토 후 직접 신청해 주세요.",
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
