// 매달 1일 여자 작업자 생휴 잔여를 1로 자동 리셋
// GitHub Actions cron으로 실행 (workflows/monthly-birth-reset.yml)
//
// 필요 환경변수:
//   FIREBASE_SA_KEY  — Firebase Service Account JSON (문자열)
//   FORCE_RESET      — '1' 이면 lastBirthResetYearMonth 무시하고 강제 실행 (수동 트리거용)

const admin = require('firebase-admin');

// 관리자·서무는 리셋 대상에서 제외 (script.js:17 STAFF_ROLES 와 동기화)
const SKIP_EMPLOYEE_IDS = new Set([
  '122210202',  // 이동준 (관리자)
  '122240096',  // 김가영 (서무)
]);

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SA_KEY;
  if (!raw) throw new Error('환경변수 FIREBASE_SA_KEY 가 없습니다.');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('FIREBASE_SA_KEY JSON 파싱 실패: ' + e.message);
  }
}

function currentYearMonthKST() {
  // KST = UTC+9. GitHub Actions는 UTC로 도니 명시적으로 계산
  const nowUtcMs = Date.now();
  const kst = new Date(nowUtcMs + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function main() {
  const sa = loadServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const currentYM = currentYearMonthKST();
  const force = process.env.FORCE_RESET === '1';
  console.log(`[reset-birth] 대상 년월(KST): ${currentYM}, force=${force}`);

  // 이미 이번 달 리셋됐는지 확인
  const resetRef = db.collection('system').doc('balanceReset');
  const resetDoc = await resetRef.get();
  const last = resetDoc.exists ? (resetDoc.data().lastBirthResetYearMonth || '') : '';
  if (!force && last === currentYM) {
    console.log(`[reset-birth] 이미 ${currentYM} 리셋 완료 (last=${last}) — 종료`);
    return;
  }

  // 여자 작업자 사번 수집 (gender !== 'M')
  const workersSnap = await db.collection('workers').get();
  const femaleIds = [];
  workersSnap.forEach(doc => {
    const w = doc.data() || {};
    const empId = String(w.employeeId || '').trim();
    if (!empId || w.gender === 'M') return;
    if (SKIP_EMPLOYEE_IDS.has(empId)) return;  // 관리자·서무 제외
    femaleIds.push(empId);
  });
  console.log(`[reset-birth] 여자 작업자 ${femaleIds.length}명 (관리자·서무 ${SKIP_EMPLOYEE_IDS.size}명 제외)`);

  if (femaleIds.length === 0) {
    await resetRef.set({
      lastBirthResetYearMonth: currentYM,
      lastBirthResetAt: admin.firestore.FieldValue.serverTimestamp(),
      lastBirthResetBy: 'github-actions',
      lastBirthResetCount: 0
    }, { merge: true });
    console.log('[reset-birth] 대상 없음 — 마커만 갱신');
    return;
  }

  // Firestore batch는 최대 500 op — 400개씩 나누어 처리
  const CHUNK = 400;
  for (let i = 0; i < femaleIds.length; i += CHUNK) {
    const chunk = femaleIds.slice(i, i + CHUNK);
    const batch = db.batch();
    chunk.forEach(id => {
      batch.set(db.collection('users').doc(id), { balanceBirth: 1 }, { merge: true });
    });
    await batch.commit();
    console.log(`[reset-birth] users 갱신 ${i + chunk.length}/${femaleIds.length}`);
  }

  // balanceLogs 기록 (각 사번)
  for (let i = 0; i < femaleIds.length; i += CHUNK) {
    const chunk = femaleIds.slice(i, i + CHUNK);
    const batch = db.batch();
    chunk.forEach(id => {
      const logRef = db.collection('balanceLogs').doc();
      batch.set(logRef, {
        empId: id,
        type: 'reset',
        changes: { birth: 1 },
        meta: { reason: 'monthly-reset', month: currentYM, via: 'github-actions' },
        byEmpId: null,
        byName: 'GitHub Actions',
        byUid: null,
        at: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }
  console.log(`[reset-birth] balanceLogs ${femaleIds.length}건 기록`);

  // 마커 업데이트
  await resetRef.set({
    lastBirthResetYearMonth: currentYM,
    lastBirthResetAt: admin.firestore.FieldValue.serverTimestamp(),
    lastBirthResetBy: 'github-actions',
    lastBirthResetCount: femaleIds.length
  }, { merge: true });

  console.log(`[reset-birth] ✅ ${currentYM} 생휴 리셋 완료 (${femaleIds.length}명 → 각 1개)`);
}

main().catch(err => {
  console.error('[reset-birth] 실패:', err);
  process.exit(1);
});
