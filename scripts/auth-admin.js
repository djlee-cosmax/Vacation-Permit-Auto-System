// Firebase Auth 관리 스크립트 (GitHub Actions 전용)
//
// 브라우저에서는 남의 계정을 건드릴 수 없어 서버 권한이 필요한 작업만 모았다.
//
// 사용:
//   ACTION=status                 node auth-admin.js   이관 현황 집계
//   ACTION=claims                 node auth-admin.js   관리자·서무 역할 클레임 부여
//   ACTION=reset EMP_ID=12224xxxx node auth-admin.js   비밀번호 초기화 (계정 삭제)
//
// 필요 환경변수:
//   FIREBASE_SA_KEY  — Firebase Service Account JSON (문자열)

const admin = require('firebase-admin');

// script.js 의 STAFF_ROLES 와 동기화할 것
const STAFF_ROLES = {
  '122210202': 'admin',   // 이동준
  '122240096': 'leader',  // 김가영 (서무)
};

// script.js 의 AUTH_EMAIL_DOMAIN 과 동기화할 것
const AUTH_EMAIL_DOMAIN = 'vacation.local';
const emailFor = (empId) => `${String(empId).trim()}@${AUTH_EMAIL_DOMAIN}`;
const empIdFromEmail = (email) => String(email || '').split('@')[0];

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SA_KEY;
  if (!raw) throw new Error('환경변수 FIREBASE_SA_KEY 가 없습니다.');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('FIREBASE_SA_KEY JSON 파싱 실패: ' + e.message);
  }
}

async function listAuthUsers() {
  const out = [];
  let pageToken;
  do {
    const res = await admin.auth().listUsers(1000, pageToken);
    res.users.forEach((u) => {
      if (u.email && u.email.endsWith('@' + AUTH_EMAIL_DOMAIN)) out.push(u);
    });
    pageToken = res.pageToken;
  } while (pageToken);
  return out;
}

// ---------- status: 이관 현황 ----------
async function actionStatus(db) {
  const [authUsers, workersSnap, usersSnap] = await Promise.all([
    listAuthUsers(),
    db.collection('workers').get(),
    db.collection('users').get(),
  ]);

  const authIds = new Set(authUsers.map((u) => empIdFromEmail(u.email)));
  const workerIds = workersSnap.docs
    .map((d) => String((d.data() || {}).employeeId || '').trim())
    .filter(Boolean);

  // 아직 Firestore 에 비밀번호 해시가 남아 있는 = 미이관 사용자
  const stillHashed = [];
  usersSnap.forEach((d) => {
    const v = d.data() || {};
    if (v.password && !v.authMigrated) stillHashed.push(d.id);
  });

  const migrated = workerIds.filter((id) => authIds.has(id));
  const notMigrated = workerIds.filter((id) => !authIds.has(id));

  console.log('===== Firebase Auth 이관 현황 =====');
  console.log(`작업자 명단      : ${workerIds.length}명`);
  console.log(`Auth 계정 생성됨 : ${migrated.length}명`);
  console.log(`미이관           : ${notMigrated.length}명`);
  console.log(`비밀번호 해시 잔존: ${stillHashed.length}건`);
  console.log('');

  if (notMigrated.length) {
    console.log('[미이관 사번] — 아직 한 번도 로그인하지 않았거나 기본 비밀번호 상태');
    notMigrated.forEach((id) => console.log('  ' + id));
    console.log('');
  }
  if (stillHashed.length) {
    console.log('[users 문서에 password 필드가 남아 있는 사번]');
    stillHashed.forEach((id) => console.log('  ' + id));
    console.log('');
  }

  const ready = notMigrated.length === 0 && stillHashed.length === 0;
  console.log(ready
    ? '>>> 전원 이관 완료. Firestore 보안 규칙을 배포해도 됩니다.'
    : '>>> 아직 미이관자가 있습니다. 지금 규칙을 배포하면 이들이 로그인하지 못합니다.');

  // 초기화 요청 접수 건 표시
  const pending = [];
  usersSnap.forEach((d) => {
    if ((d.data() || {}).pwResetRequested) pending.push(d.id);
  });
  if (pending.length) {
    console.log('');
    console.log('[비밀번호 초기화 요청 접수됨] — ACTION=reset 으로 처리하세요');
    pending.forEach((id) => console.log('  ' + id));
  }
}

// ---------- claims: 역할 부여 ----------
async function actionClaims() {
  console.log('===== 역할 클레임 부여 =====');
  for (const [empId, role] of Object.entries(STAFF_ROLES)) {
    try {
      const user = await admin.auth().getUserByEmail(emailFor(empId));
      await admin.auth().setCustomUserClaims(user.uid, { role, empId });
      console.log(`  ${empId} → role=${role} 적용`);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        console.log(`  ${empId} → 계정 없음 (아직 로그인 전). 로그인 후 다시 실행하세요.`);
      } else {
        console.log(`  ${empId} → 실패: ${e.message}`);
      }
    }
  }
  console.log('');
  console.log('※ 클레임은 다음 로그인(또는 토큰 갱신) 시점부터 반영됩니다.');
}

// ---------- reset: 비밀번호 초기화 ----------
async function actionReset(db) {
  const empId = String(process.env.EMP_ID || '').trim();
  if (!empId) throw new Error('EMP_ID 가 필요합니다. (초기화할 작업자 사번)');

  console.log(`===== 비밀번호 초기화: ${empId} =====`);

  // 명단에 있는 사번인지 확인 — 오타로 엉뚱한 계정을 지우지 않도록
  const wSnap = await db.collection('workers').where('employeeId', '==', empId).get();
  if (wSnap.empty) {
    console.log('※ 작업자 명단에서 찾지 못했습니다. 사번을 다시 확인하세요.');
    process.exitCode = 1;
    return;
  }
  const name = (wSnap.docs[0].data() || {}).name || empId;

  try {
    const user = await admin.auth().getUserByEmail(emailFor(empId));
    await admin.auth().deleteUser(user.uid);
    console.log(`  Auth 계정 삭제 완료 (${name})`);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      console.log(`  Auth 계정이 없습니다 — 이미 초기 상태입니다 (${name})`);
    } else {
      throw e;
    }
  }

  // Firestore 잔여 인증 필드 정리 + 요청 플래그 해제
  await db.collection('users').doc(empId).set({
    authMigrated: admin.firestore.FieldValue.delete(),
    authMigratedAt: admin.firestore.FieldValue.delete(),
    password: admin.firestore.FieldValue.delete(),
    securityQuestion: admin.firestore.FieldValue.delete(),
    securityAnswer: admin.firestore.FieldValue.delete(),
    pwResetRequested: admin.firestore.FieldValue.delete(),
    pwResetRequestedAt: admin.firestore.FieldValue.delete(),
    pwResetRequestedBy: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  console.log('');
  console.log(`>>> ${name}(${empId}) 님은 이제 사번 + 1234 로 로그인할 수 있습니다.`);
  console.log('    로그인 직후 새 비밀번호 등록 안내가 자동으로 표시됩니다.');
}

async function main() {
  const action = String(process.env.ACTION || 'status').trim();
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();

  if (action === 'status') return actionStatus(db);
  if (action === 'claims') return actionClaims();
  if (action === 'reset') return actionReset(db);
  throw new Error(`알 수 없는 ACTION: ${action} (status | claims | reset)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
