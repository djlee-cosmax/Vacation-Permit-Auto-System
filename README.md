# 휴가증 자동 반영 프로그램

생산3팀 파우더 성형실. 작업자가 휴대폰으로 휴가증을 작성하면 클라우드에 저장되고,
서무가 하루 한 번 불러와 그룹웨어(COIN)에 자동 등록한다. 종이 휴가원을 대체했다.

2026-05 시작, 작업자 63명 전원 사용, 월평균 115건.

```
주소   https://djlee-cosmax.github.io/Vacation-Permit-Auto-System/
저장   Firebase Firestore (asia-northeast3 · 서울)
인증   Firebase Authentication — 사번 + 비밀번호
```

## 구성

빌드가 없다. 정적 파일을 GitHub Pages 가 그대로 서빙한다.

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 전체. 모달까지 한 파일에 있다 |
| `script.js` | 로직 전부 (3,400줄). 로그인·작성·조회·서무 처리 |
| `style.css` | 스타일 |
| `firestore.rules` | 보안 규칙. **여기가 실제 방어선이다** |
| `scripts/auth-admin.js` | 서버 권한이 필요한 관리 작업 (GitHub Actions 전용) |
| `scripts/reset-birth.js` | 매달 1일 생휴 리셋 |
| `automation/` | 서무 PC 용 그룹웨어 자동 입력 (Python). `automation/README.md` 참고 |
| `docs/` | 매뉴얼 PDF·작업자 안내 PPT 와 그 생성 스크립트 |

## 데이터

| 컬렉션 | 문서 ID | 내용 |
|---|---|---|
| `workers` | 자동 | 작업자 명단 — 이름·사번·팀·부서·휴대폰 |
| `users` | 사번 | 잔여 휴가, 이름·팀·휴대폰 사본, 이관 표시 |
| `leaves` | `lv_...` | 휴가증 — 이름·사번·기간·구분·사유·연락처 |
| `balanceLogs` | 자동 | 잔여 변경 이력. TTL 없음 |
| `system` | 고정 | 생휴 리셋 마커 등 |

**이름·팀·휴대폰이 `workers` 와 `users` 양쪽에 있다.** 일반 작업자는 규칙상
`workers` 전체를 못 읽어서, 본인 정보는 `users` 문서에서 가져온다(`profileFor`).
명단을 고치면 `ACTION=syncprofile` 을 돌려 `users` 쪽을 맞춰야 한다 — 자동으로
따라가지 않는다.

## 규칙이 앱 구조를 정한다

`firestore.rules` 는 장식이 아니다. 규칙을 조이면 **앱 쿼리가 같이 깨진다.**
`list` 는 문서마다 규칙이 평가되어, 남의 문서가 하나라도 걸리면 쿼리 전체가 실패한다.

그래서 작업자 쪽 조회는 전부 본인 사번으로 좁혀 놨다.

```
중복 확인      where('employeeId','==', 내 사번)
처리완료 정리   where('employeeId','==', 내 사번)
내 휴가증      where('employeeId','==', 내 사번)
삭제 감시      작업자는 본인 것만 구독 / 서무·관리자는 전체
```

**조건 없는 `leaves` 전체 조회를 새로 넣으면 작업자 화면이 죽는다.** 서무·관리자
경로에서만 써야 한다.

휴가증의 `employeeId` 는 **로그인 세션의 사번**으로 채운다. 예전에는 명단을 이름으로
찾아 채웠는데, 명단에 없거나 동명이인이면 빈 값이 되어 소유자도 못 읽게 된다.

## 로그인

사번 + 비밀번호. 비밀번호는 Firebase Authentication 이 보관하고 앱은 갖고 있지 않다.

**Firebase 는 6자 이상을 요구해서 '1234' 는 '1234\_\_' 로 패딩된다**(`authPasswordFor`).
`script.js` 와 `scripts/auth-admin.js` 양쪽에 같은 함수가 있으니 한쪽만 고치면
로그인이 깨진다.

역할은 Custom Claims 로 준다. `STAFF_ROLES` 의 사번이 관리자·서무다.
**저장소가 공개라 사번 옆에 실명을 적지 않는다** — 이름은 Firestore 에서 온다.

## 운영

GitHub Actions → **[계정 관리]** 워크플로 (`FIREBASE_SA_KEY` 시크릿 사용).
로컬에서는 못 돌린다.

```
status       이관 현황 집계
inspect      한 사람 상태 (EMP_ID)
rules        배포된 규칙 조회
deployrules  firestore.rules 배포 (CONFIRM=DEPLOY)
testrules    실제 토큰으로 규칙 검증
cleanup      이관 잔여 필드 정리 (CONFIRM=OK)
claims       관리자·서무 역할 클레임
premigrate   서버 이관 (EMP_ID)
syncprofile  users 에 이름·팀·휴대폰 채우기 (CONFIRM=OK) — 명단 수정 후 필수
stats        이용 실적 집계 (읽기 전용)
anonoff      익명 로그인 제공자 끄기
fixleaveids  사번 없는 휴가증 채우기 (CONFIRM=OK)
purge        만료된 휴가증 삭제 (CONFIRM=OK)
ttl          TTL 정책 조회 — 켜기는 결제 계정이 필요해 못 쓴다
testaccount  일반 작업자 경로 확인용 임시 계정 (CONFIRM=OK / DELETE)
reset        비밀번호를 1234 로 재설정 (EMP_ID)
remove       퇴직자 완전 삭제 (EMP_ID, CONFIRM=DELETE)
```

자동으로 도는 것 두 가지.

```
매달 1일 09:00 KST   생휴 리셋
매주 월 09:00 KST    만료 휴가증 정리 (작성 +30일)
```

## 반드시 지킬 것

**저장소가 PUBLIC 이다.** Actions 실행 로그도 누구나 볼 수 있다.
`auth-admin.js` 는 사번만 찍고 실명·연락처는 마스킹한다 — 새 출력을 추가할 때도
같은 규칙을 지킬 것. 백업 JSON 전체를 로그에 찍지 않는다.

**코드를 고치면 `index.html` 의 캐시버스터도 올린다.**
`script.js?v=YYYYMMDD` 를 안 올리면 브라우저가 옛 파일을 계속 쓴다.

**`ACTION=reset` 은 계정을 지우지 않는다.** 지우면 그 사람은 로그인할 때 클라이언트
자가 이관 경로로 빠지는데, 그 경로는 로그인 전에 `users` 를 읽어야 해서 규칙에
막힌다 — 영영 못 들어온다. 비밀번호만 바꿔야 한다.

**규칙을 바꾸면 `testrules` 를 돌린다.** 그리고 `testaccount` 로 실제 화면까지 본다.
관리자·서무 사번으로는 `isStaff()` 가 참이라 작업자 경로가 검증되지 않는다.

**잔여 휴가는 `users` 가 원본이다.** 화면 캐시를 믿고 쓰면 서무가 고친 값이 옛 값으로
덮인다.

## 알려진 것

- `users` 에 성별이 없어, 명단 캐시가 없는 새 기기에서는 남자 작업자에게도
  생휴 카드가 보인다. 표시만의 문제다.
- 사내 배포(Incubation Portal) 이전을 검토 중이다. 쟁점은 외부 공개 가능 여부와,
  현장 인원 대부분이 회사 계정이 없어 COSMAX SSO 를 쓸 수 없다는 점이다.
