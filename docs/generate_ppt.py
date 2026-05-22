"""작업자 안내용 PPT 생성"""
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

SCRIPT_DIR = Path(__file__).resolve().parent
OUT = SCRIPT_DIR / "휴가증 자동 반영 프로그램 안내 (작업자용).pptx"

# COSMAX 색상
RED = RGBColor(0xC8, 0x10, 0x2E)
DARK_RED = RGBColor(0xA3, 0x0D, 0x24)
DARK = RGBColor(0x1A, 0x1A, 0x1A)
GRAY = RGBColor(0x77, 0x77, 0x77)
LIGHT_GRAY = RGBColor(0xF5, 0xF5, 0xF5)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GREEN = RGBColor(0x2E, 0x7D, 0x32)
LIGHT_RED = RGBColor(0xFF, 0xF5, 0xF5)


def set_text(tf, text, size=18, bold=False, color=DARK, align=PP_ALIGN.LEFT):
    tf.clear()
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.name = "맑은 고딕"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color


def add_paragraph(tf, text, size=14, bold=False, color=DARK, align=PP_ALIGN.LEFT, space_before=4):
    p = tf.add_paragraph()
    p.alignment = align
    p.space_before = Pt(space_before)
    run = p.add_run()
    run.text = text
    run.font.name = "맑은 고딕"
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return p


def add_rect(slide, x, y, w, h, fill_color, line_color=None):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if line_color is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_color
    shape.shadow.inherit = False
    return shape


def add_rounded_rect(slide, x, y, w, h, fill_color, line_color=None):
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    shape.adjustments[0] = 0.15
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_color
    if line_color is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_color
    shape.shadow.inherit = False
    return shape


def add_text(slide, x, y, w, h, text, size=18, bold=False, color=DARK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = Pt(2); tf.margin_right = Pt(2); tf.margin_top = Pt(2); tf.margin_bottom = Pt(2)
    tf.vertical_anchor = anchor
    set_text(tf, text, size=size, bold=bold, color=color, align=align)
    return tf


def page_footer(slide, n, total):
    add_text(slide, Inches(0.4), Inches(7.0), Inches(12.6), Inches(0.3),
             f"COSMAX · 생산3팀 파우더 성형실    |    {n} / {total}",
             size=9, color=GRAY, align=PP_ALIGN.RIGHT)


def main():
    prs = Presentation()
    # 16:9 와이드
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]
    TOTAL = 9

    # ===== 슬라이드 1: 표지 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, prs.slide_height, WHITE)
    # 왼쪽 빨간 띠
    add_rect(s, 0, 0, Inches(0.4), prs.slide_height, RED)
    add_text(s, Inches(1.0), Inches(1.5), Inches(11.5), Inches(0.5),
             "COSMAX · 생산3팀 파우더 성형실", size=16, bold=True, color=RED)
    add_text(s, Inches(1.0), Inches(2.4), Inches(11.5), Inches(1.5),
             "휴가증 자동 반영 프로그램", size=48, bold=True, color=DARK)
    add_text(s, Inches(1.0), Inches(4.0), Inches(11.5), Inches(0.6),
             "현장 작업자 안내", size=22, color=GRAY)
    add_rect(s, Inches(1.0), Inches(4.7), Inches(2.0), Pt(3), RED)
    add_text(s, Inches(1.0), Inches(5.5), Inches(11.5), Inches(1.0),
             "본인 휴대폰으로 직접 휴가증을 작성하세요.", size=18, color=DARK)
    add_text(s, Inches(1.0), Inches(6.7), Inches(11.5), Inches(0.4),
             "발행: 2026-05-22  ·  담당: 이동준", size=11, color=GRAY)

    # ===== 슬라이드 2: 무엇이 바뀌나? =====
    s = prs.slides.add_slide(blank)
    # 상단 타이틀
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "어떻게 바뀌나요?", size=28, bold=True, color=WHITE)
    # 본문 - 2개 카드 (이전 vs 변경)
    # 이전
    add_rounded_rect(s, Inches(0.8), Inches(1.7), Inches(5.7), Inches(4.5), LIGHT_GRAY)
    add_text(s, Inches(1.0), Inches(2.0), Inches(5.3), Inches(0.6),
             "❌  이전 방식", size=18, bold=True, color=GRAY)
    add_text(s, Inches(1.0), Inches(2.9), Inches(5.3), Inches(3.0),
             "• 종이 휴가증 작성\n\n• 휴가증함에 제출\n\n• 담당자가 매일 수거\n\n• 서무가 그룹웨어에 일일이 입력",
             size=15, color=DARK)
    # 변경 (오른쪽)
    add_rounded_rect(s, Inches(6.8), Inches(1.7), Inches(5.7), Inches(4.5), LIGHT_RED)
    add_text(s, Inches(7.0), Inches(2.0), Inches(5.3), Inches(0.6),
             "✓  새 방식", size=18, bold=True, color=RED)
    add_text(s, Inches(7.0), Inches(2.9), Inches(5.3), Inches(3.0),
             "• 본인 휴대폰으로 사이트 접속\n\n• 본인 휴가증 직접 작성\n\n• 클라우드에 자동 저장\n\n• 서무가 한 번에 자동 등록",
             size=15, color=DARK)
    add_text(s, Inches(0.8), Inches(6.4), Inches(11.7), Inches(0.6),
             "→ 작성자는 그대로 본인. 종이 대신 휴대폰으로!",
             size=18, bold=True, color=RED, align=PP_ALIGN.CENTER)
    page_footer(s, 2, TOTAL)

    # ===== 슬라이드 3: 사이트 접속 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "1. 사이트 접속하기", size=28, bold=True, color=WHITE)
    # 사이트 주소 박스
    add_rounded_rect(s, Inches(1.5), Inches(2.0), Inches(10.3), Inches(1.2), LIGHT_RED)
    add_text(s, Inches(1.5), Inches(2.0), Inches(10.3), Inches(1.2),
             "https://djlee-cosmax.github.io/Vacation-Permit-Auto-System/",
             size=20, bold=True, color=RED, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)
    add_text(s, Inches(1.0), Inches(3.6), Inches(11.3), Inches(0.6),
             "휴대폰 브라우저(Safari / Chrome)에서 위 주소로 접속",
             size=18, color=DARK)
    # 권장 박스
    add_rounded_rect(s, Inches(1.0), Inches(4.5), Inches(11.3), Inches(2.0), LIGHT_GRAY)
    add_text(s, Inches(1.3), Inches(4.7), Inches(10.8), Inches(0.5),
             "💡 휴대폰 홈 화면에 추가하면 앱처럼 사용 가능",
             size=16, bold=True, color=DARK_RED)
    add_text(s, Inches(1.3), Inches(5.3), Inches(10.8), Inches(1.1),
             "• iOS Safari: 하단 공유 버튼 → \"홈 화면에 추가\"\n• Android Chrome: 우상단 ⋮ → \"홈 화면에 추가\"",
             size=14, color=DARK)
    page_footer(s, 3, TOTAL)

    # ===== 슬라이드 4: 로그인 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "2. 로그인하기", size=28, bold=True, color=WHITE)
    # 단계 카드 3개
    steps = [
        ("①", "사번 입력", "본인의 9자리 사번"),
        ("②", "비밀번호", "초기 비밀번호:\n1234"),
        ("③", "로그인", "[로그인] 클릭"),
    ]
    for i, (num, title, desc) in enumerate(steps):
        x = Inches(0.7 + i * 4.2)
        add_rounded_rect(s, x, Inches(1.8), Inches(4.0), Inches(3.5), LIGHT_RED)
        add_text(s, x, Inches(2.0), Inches(4.0), Inches(0.8),
                 num, size=42, bold=True, color=RED, align=PP_ALIGN.CENTER)
        add_text(s, x, Inches(3.0), Inches(4.0), Inches(0.5),
                 title, size=20, bold=True, color=DARK, align=PP_ALIGN.CENTER)
        add_text(s, x, Inches(3.7), Inches(4.0), Inches(1.5),
                 desc, size=14, color=GRAY, align=PP_ALIGN.CENTER)

    # 비밀번호 변경 안내 박스
    add_rounded_rect(s, Inches(1.0), Inches(5.7), Inches(11.3), Inches(1.1), LIGHT_GRAY)
    add_text(s, Inches(1.3), Inches(5.85), Inches(10.8), Inches(0.8),
             "⚠️ 첫 로그인 후 상단 [비밀번호 변경] → 새 비밀번호(숫자 6자리 이상) + 보안 질문 등록",
             size=15, bold=True, color=DARK_RED, anchor=MSO_ANCHOR.MIDDLE)
    page_footer(s, 4, TOTAL)

    # ===== 슬라이드 5: 휴가증 작성 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "3. 휴가증 작성하기", size=28, bold=True, color=WHITE)
    # 단계 리스트 (왼쪽)
    add_text(s, Inches(0.8), Inches(1.5), Inches(7.0), Inches(0.5),
             "왼쪽 [휴가증 작성] 카드에서:", size=16, bold=True, color=DARK)
    steps = [
        ("1.", "구분 선택", "연차 / 반차 / 반반차 / 생휴 / 하기휴가 / 결근"),
        ("2.", "개수 입력", "예: 연차 2개"),
        ("3.", "기간 선택", "시작일 ~ 종료일"),
        ("4.", "사유 입력", "휴가 사유"),
        ("5.", "[+ 추가] 클릭", "클라우드에 자동 저장"),
    ]
    for i, (n, t, d) in enumerate(steps):
        y = Inches(2.2 + i * 0.8)
        add_text(s, Inches(0.8), y, Inches(0.5), Inches(0.6),
                 n, size=18, bold=True, color=RED)
        add_text(s, Inches(1.4), y, Inches(2.5), Inches(0.6),
                 t, size=16, bold=True, color=DARK)
        add_text(s, Inches(4.0), y, Inches(4.0), Inches(0.6),
                 d, size=14, color=GRAY)

    # 오른쪽 안내 박스
    add_rounded_rect(s, Inches(8.5), Inches(1.5), Inches(4.3), Inches(5.0), LIGHT_RED)
    add_text(s, Inches(8.7), Inches(1.7), Inches(4.0), Inches(0.5),
             "💡 알아두세요", size=16, bold=True, color=RED)
    add_text(s, Inches(8.7), Inches(2.3), Inches(4.0), Inches(4.5),
             "• 이름과 연락처는 자동 채워집니다\n  (수정 불가)\n\n"
             "• 한 사람이 여러 유형을 사용할 땐\n  유형별로 따로 작성\n  (예: 연차 + 반차 → 휴가증 2건)\n\n"
             "• 작성하면 즉시 클라우드에 저장되어\n  서무에게 자동 전달됩니다",
             size=13, color=DARK)
    page_footer(s, 5, TOTAL)

    # ===== 슬라이드 6: 휴가 유형 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "휴가 유형", size=28, bold=True, color=WHITE)
    # 표
    rows = [
        ("구분", "1개당 일수", "비고"),
        ("연차", "1.0일", "종일"),
        ("반차(오전/오후)", "0.5일", "오전: 12:50 출근 / 오후: 12:00 퇴근"),
        ("반반차(오전/오후)", "0.25일", "오전: 10:00 출근 / 오후: 15:00 퇴근"),
        ("생휴", "1.0일", "생리 휴가"),
        ("하기휴가", "3.0일", "1개 = 연속 3일"),
        ("결근 (전/오전/오후)", "1.0 / 0.5일", "연차 잔여 없을 때"),
    ]
    tbl_x = Inches(1.0)
    tbl_y = Inches(1.7)
    tbl_w = Inches(11.3)
    rh = Inches(0.65)
    cols = [Inches(3.5), Inches(2.5), Inches(5.3)]
    for ri, row in enumerate(rows):
        y = tbl_y + rh * ri
        is_header = (ri == 0)
        # 행 배경
        bg = RED if is_header else (LIGHT_GRAY if ri % 2 == 0 else WHITE)
        add_rect(s, tbl_x, y, tbl_w, rh, bg)
        # 셀
        x = tbl_x
        for ci, txt in enumerate(row):
            add_text(s, x + Inches(0.2), y, cols[ci] - Inches(0.2), rh,
                     txt, size=14, bold=is_header,
                     color=WHITE if is_header else DARK, anchor=MSO_ANCHOR.MIDDLE)
            x += cols[ci]
    page_footer(s, 6, TOTAL)

    # ===== 슬라이드 7: 내 휴가증 조회 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "4. 내 휴가증 확인하기", size=28, bold=True, color=WHITE)
    add_text(s, Inches(0.8), Inches(1.5), Inches(11.7), Inches(0.6),
             "상단 [내 휴가증] 버튼을 누르면 본인 휴가가 등록됐는지 확인 가능", size=16, color=DARK)

    # 흐름 박스
    add_rounded_rect(s, Inches(0.8), Inches(2.5), Inches(3.7), Inches(2.0), LIGHT_RED)
    add_text(s, Inches(0.9), Inches(2.6), Inches(3.5), Inches(0.5),
             "① 본인 인증", size=18, bold=True, color=RED, align=PP_ALIGN.CENTER)
    add_text(s, Inches(0.9), Inches(3.2), Inches(3.5), Inches(1.3),
             "이름 + 휴대폰 마지막 4자리 입력 → [조회]", size=13, color=DARK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    add_rounded_rect(s, Inches(4.8), Inches(2.5), Inches(3.7), Inches(2.0), LIGHT_RED)
    add_text(s, Inches(4.9), Inches(2.6), Inches(3.5), Inches(0.5),
             "② 등록 확인", size=18, bold=True, color=RED, align=PP_ALIGN.CENTER)
    add_text(s, Inches(4.9), Inches(3.2), Inches(3.5), Inches(1.3),
             "처리 완료된 본인 휴가증이 ✓ 표시로 나옴", size=13, color=DARK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    add_rounded_rect(s, Inches(8.8), Inches(2.5), Inches(3.7), Inches(2.0), LIGHT_RED)
    add_text(s, Inches(8.9), Inches(2.6), Inches(3.5), Inches(0.5),
             "③ 최근 14일", size=18, bold=True, color=RED, align=PP_ALIGN.CENTER)
    add_text(s, Inches(8.9), Inches(3.2), Inches(3.5), Inches(1.3),
             "최근 14일 내 휴가증만 표시", size=13, color=DARK, align=PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)

    # 잘못 작성 시 안내
    add_rounded_rect(s, Inches(0.8), Inches(5.0), Inches(11.7), Inches(1.7), LIGHT_GRAY)
    add_text(s, Inches(1.0), Inches(5.2), Inches(11.3), Inches(0.5),
             "⚠️ 잘못 작성한 휴가증은?", size=16, bold=True, color=DARK_RED)
    add_text(s, Inches(1.0), Inches(5.8), Inches(11.3), Inches(0.8),
             "작성 직후 우측 카드의 [삭제] 버튼으로 취소. 서무 처리 후엔 별도 요청 필요.",
             size=14, color=DARK)
    page_footer(s, 7, TOTAL)

    # ===== 슬라이드 8: 자주 묻는 질문 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, Inches(1.0), RED)
    add_text(s, Inches(0.5), Inches(0.2), Inches(12.3), Inches(0.6),
             "자주 묻는 질문", size=28, bold=True, color=WHITE)

    qa = [
        ("Q. 비밀번호를 잊어버렸어요.",
         "→ 로그인 화면 [비밀번호 찾기] 클릭 → 보안 질문 답변 후 새 비밀번호 설정"),
        ("Q. 사번이 등록되어 있지 않다고 나와요.",
         "→ 관리자(이동준)에게 명단 추가 요청"),
        ("Q. 휴가증을 잘못 작성했어요.",
         "→ 작성 직후 우측 카드 [삭제] 클릭. 서무 처리 후에는 서무에게 별도 요청"),
        ("Q. 화면이 이상하거나 옛 디자인이 보여요.",
         "→ 상단 ↻ 아이콘 클릭 / 또는 시크릿 창으로 접속"),
        ("Q. ⚠ 서버 저장 실패 알림이 떠요.",
         "→ 인터넷 연결 확인 후 다시 작성 (저장 실패한 휴가증은 서버에 전달되지 않음)"),
    ]
    for i, (q, a) in enumerate(qa):
        y = Inches(1.5 + i * 1.05)
        add_text(s, Inches(0.8), y, Inches(11.7), Inches(0.4),
                 q, size=15, bold=True, color=DARK)
        add_text(s, Inches(1.0), y + Inches(0.45), Inches(11.5), Inches(0.5),
                 a, size=13, color=GRAY)
    page_footer(s, 8, TOTAL)

    # ===== 슬라이드 9: 마무리 =====
    s = prs.slides.add_slide(blank)
    add_rect(s, 0, 0, prs.slide_width, prs.slide_height, RED)
    add_text(s, Inches(0.5), Inches(2.0), Inches(12.3), Inches(1.0),
             "감사합니다", size=54, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    add_rect(s, Inches(5.5), Inches(3.4), Inches(2.3), Pt(3), WHITE)
    add_text(s, Inches(0.5), Inches(4.0), Inches(12.3), Inches(0.6),
             "휴가증은 본인이 직접, 빠르고 정확하게.", size=20, color=WHITE, align=PP_ALIGN.CENTER)
    add_text(s, Inches(0.5), Inches(5.5), Inches(12.3), Inches(0.5),
             "문의 — 관리자 이동준 (생산3팀)", size=14, color=WHITE, align=PP_ALIGN.CENTER)
    add_text(s, Inches(0.5), Inches(6.1), Inches(12.3), Inches(0.4),
             "사이트:  djlee-cosmax.github.io/Vacation-Permit-Auto-System/", size=12, color=WHITE, align=PP_ALIGN.CENTER)

    prs.save(str(OUT))
    print(f"PPT 생성 완료: {OUT}")
    print(f"크기: {OUT.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
