// Firebase Auth 관리 스크립트 (GitHub Actions 전용)
//
// 브라우저에서는 남의 계정을 건드릴 수 없어 서버 권한이 필요한 작업만 모았다.
//
// 사용:
//   ACTION=status                        node auth-admin.js  이관 현황 집계
//   ACTION=inspect EMP_ID=12224xxxx      node auth-admin.js  한 사람 상태 상세
//   ACTION=claims                        node auth-admin.js  관리자·서무 역할 클레임 부여
//   ACTION=reset  EMP_ID=12224xxxx       node auth-admin.js  비밀번호 초기화 (계정 삭제)
//   ACTION=remove EMP_ID=12224xxxx       node auth-admin.js  퇴직자 완전 삭제 (미리보기)
//   ACTION=remove EMP_ID=... CONFIRM=DELETE  실제 삭제 실행
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

// ---------- inspect: 한 사람 상태 상세 ----------
// 이관이 왜 덜 됐는지 판단하려면 문서에 실제로 무엇이 남아 있는지 봐야 한다.
// 비밀번호 해시는 값 대신 존재 여부와 길이만 찍는다.
async function actionInspect(db) {
  const empId = String(process.env.EMP_ID || '').trim();
  if (!empId) throw new Error('EMP_ID 가 필요합니다. (조회할 작업자 사번)');

  const [authUsers, wSnap, uDoc] = await Promise.all([
    listAuthUsers(),
    db.collection('workers').where('employeeId', '==', empId).get(),
    db.collection('users').doc(empId).get(),
  ]);
  const kst = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d) ? '-'
      : new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' KST';
  };

  console.log(`===== ${empId} 상태 =====`);
  const w = wSnap.empty ? null : (wSnap.docs[0].data() || {});
  console.log(`workers  : ${w ? `${w.name || '-'} / ${w.team || '-'} / ${w.department || '-'}` : '없음'}`);

  const au = authUsers.find((u) => empIdFromEmail(u.email) === empId);
  if (au) {
    const m = au.metadata || {};
    console.log(`Auth     : 있음  uid=${au.uid}`);
    console.log(`           생성 ${kst(m.creationTime)}  최근 로그인 ${kst(m.lastSignInTime)}`);
    console.log(`           claims=${JSON.stringify(au.customClaims || {})}`);
  } else {
    console.log('Auth     : 없음');
  }

  if (!uDoc.exists) {
    console.log('users    : 문서 없음');
    return;
  }
  const d = uDoc.data() || {};
  console.log('users    : 필드 목록');
  Object.keys(d).sort().forEach((k) => {
    const v = d[k];
    let shown;
    if (k === 'password' || k === 'securityAnswer') {
      shown = `(값 숨김, 길이 ${String(v).length})`;
    } else if (v && typeof v.toDate === 'function') {
      shown = kst(v.toDate().toISOString());
    } else {
      shown = JSON.stringify(v);
    }
    console.log(`           ${k} = ${shown}`);
  });
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

  // 사번만 나오면 현장 안내가 안 되므로 이름·팀을 같이 뽑는다.
  const info = new Map();
  workersSnap.forEach((d) => {
    const w = d.data() || {};
    const id = String(w.employeeId || '').trim();
    if (id) info.set(id, { name: w.name || '', team: w.team || '', dept: w.department || '' });
  });
  const label = (id) => {
    const w = info.get(id);
    if (!w) return id;
    const where = [w.dept, w.team].filter(Boolean).join(' / ');
    return `${id}  ${(w.name || '(이름 없음)').padEnd(6, ' ')}${where ? '  ' + where : ''}`;
  };

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
    notMigrated.forEach((id) => console.log('  ' + label(id)));
    console.log('');
  }
  if (stillHashed.length) {
    // 정리 로직은 로그인 성공 시 돈다. 마지막 로그인이 배포(2026-08-03 10:25 KST)
    // 이전이면 아직 한 번도 정리 기회가 없었다는 뜻이다.
    const authBy = new Map(authUsers.map((u) => [empIdFromEmail(u.email), u]));
    const kst = (iso) => {
      if (!iso) return '-';
      const d = new Date(iso);
      if (isNaN(d)) return '-';
      return new Date(d.getTime() + 9 * 3600 * 1000)
        .toISOString().replace('T', ' ').slice(0, 16) + ' KST';
    };
    console.log('[users 문서에 password 필드가 남아 있는 사번]');
    stillHashed.forEach((id) => {
      const u = authBy.get(id);
      const m = (u && u.metadata) || {};
      console.log('  ' + label(id));
      console.log('      Auth 계정 ' + (u ? '있음' : '없음')
        + '   생성 ' + kst(m.creationTime)
        + '   최근 로그인 ' + kst(m.lastSignInTime));
    });
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

// ---------- remove: 퇴직자 완전 삭제 ----------
// 기본은 미리보기(삭제 안 함). CONFIRM=DELETE 를 줘야 실제로 지운다.
async function actionRemove(db) {
  const empId = String(process.env.EMP_ID || '').trim();
  if (!empId) throw new Error('EMP_ID 가 필요합니다. (삭제할 작업자 사번)');
  const confirmed = String(process.env.CONFIRM || '').trim() === 'DELETE';

  console.log(`===== 퇴직자 삭제${confirmed ? '' : ' (미리보기)'}: ${empId} =====`);

  // 1) 대상 확인
  const wSnap = await db.collection('workers').where('employeeId', '==', empId).get();
  if (wSnap.empty) {
    console.log('※ 작업자 명단에서 찾지 못했습니다. 사번을 확인하세요.');
    process.exitCode = 1;
    return;
  }
  const w = wSnap.docs[0].data() || {};
  const name = w.name || empId;
  console.log(`  이름: ${name} / 팀: ${w.team || '-'} / 부서: ${w.department || '-'}`);

  // 2) 삭제 대상 수집
  const userRef = db.collection('users').doc(empId);
  const userSnap = await userRef.get();
  const u = userSnap.exists ? (userSnap.data() || {}) : null;

  // 휴가증은 사번 또는 이름으로 연결된다 (초기 데이터는 사번이 없는 경우가 있음)
  const [byId, byName] = await Promise.all([
    db.collection('leaves').where('employeeId', '==', empId).get(),
    db.collection('leaves').where('name', '==', name).get(),
  ]);
  const leaveDocs = new Map();
  byId.forEach((d) => leaveDocs.set(d.id, d));
  byName.forEach((d) => leaveDocs.set(d.id, d));

  let authUid = null;
  try {
    const au = await admin.auth().getUserByEmail(emailFor(empId));
    authUid = au.uid;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  console.log('');
  console.log('[삭제 대상]');
  console.log(`  workers  : ${wSnap.size}건`);
  console.log(`  users    : ${u ? 1 : 0}건` +
    (u ? `  (연차 ${u.balanceAnnual ?? '-'} / 생휴 ${u.balanceBirth ?? '-'} / 하기 ${u.balanceSummer ?? '-'})` : ''));
  console.log(`  leaves   : ${leaveDocs.size}건`);
  leaveDocs.forEach((d) => {
    const f = d.data() || {};
    console.log(`    - ${f.start || '?'} ~ ${f.end || '?'}  ${f.type || ''}  (${d.id})`);
  });
  console.log(`  Auth 계정: ${authUid ? '있음' : '없음'}`);

  // 3) 백업 출력 — Actions 로그에 남겨 필요 시 복원 근거로 쓴다
  console.log('');
  console.log('[백업 JSON] — 복원이 필요하면 이 내용을 사용하세요');
  console.log(JSON.stringify({
    empId, name,
    worker: w,
    user: u,
    leaves: Array.from(leaveDocs.values()).map((d) => ({ id: d.id, data: d.data() })),
  }, null, 2));

  if (!confirmed) {
    console.log('');
    console.log('>>> 미리보기입니다. 실제로 지우려면 confirm 입력란에 DELETE 를 넣고 다시 실행하세요.');
    return;
  }

  // 4) 삭제
  console.log('');
  console.log('[삭제 실행]');
  const batch = db.batch();
  leaveDocs.forEach((d) => batch.delete(d.ref));
  if (userSnap.exists) batch.delete(userRef);
  wSnap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`  Firestore 삭제 완료 (workers ${wSnap.size} / users ${u ? 1 : 0} / leaves ${leaveDocs.size})`);

  if (authUid) {
    await admin.auth().deleteUser(authUid);
    console.log('  Auth 계정 삭제 완료');
  }

  const remain = await db.collection('workers').get();
  console.log('');
  console.log(`>>> ${name}(${empId}) 삭제 완료. 남은 작업자 ${remain.size}명.`);
  console.log('    각 기기는 다음 접속 시 명단에서 자동으로 사라집니다.');
}

async function main() {
  const action = String(process.env.ACTION || 'status').trim();
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();

  if (action === 'status') return actionStatus(db);
  if (action === 'inspect') return actionInspect(db);
  if (action === 'claims') return actionClaims();
  if (action === 'reset') return actionReset(db);
  if (action === 'remove') return actionRemove(db);
  throw new Error(`알 수 없는 ACTION: ${action} (status | inspect | claims | reset | remove)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
