// Firebase Auth 관리 스크립트 (GitHub Actions 전용)
//
// 브라우저에서는 남의 계정을 건드릴 수 없어 서버 권한이 필요한 작업만 모았다.
//
// 사용:
//   ACTION=status                        node auth-admin.js  이관 현황 집계
//   ACTION=inspect EMP_ID=12224xxxx      node auth-admin.js  한 사람 상태 상세
//   ACTION=rules                         node auth-admin.js  현재 배포된 보안 규칙 조회
//   ACTION=deployrules                   node auth-admin.js  firestore.rules 배포 (미리보기)
//   ACTION=deployrules CONFIRM=DEPLOY                        실제 배포
//   ACTION=testrules                     node auth-admin.js  배포된 규칙 시뮬레이션 검증
//   ACTION=cleanup                       node auth-admin.js  이관 잔여 필드 정리 (미리보기)
//   ACTION=cleanup CONFIRM=OK                                실제 정리 실행
//   ACTION=claims                        node auth-admin.js  관리자·서무 역할 클레임 부여
//   ACTION=premigrate EMP_ID=12224xxxx   node auth-admin.js  로그인 못 하는 사람 서버 이관
//   ACTION=premigrate EMP_ID=... CONFIRM=RESETPW             비밀번호 바꿔 쓰던 사람까지
//   ACTION=syncprofile                   node auth-admin.js  users 에 이름·팀·휴대폰 채우기
//   ACTION=syncprofile CONFIRM=OK                            실제 쓰기 (명단 수정 후 필수)
//   ACTION=stats                         node auth-admin.js  휴가증 이용 실적 집계 (읽기 전용)
//   ACTION=anonoff                       node auth-admin.js  익명 로그인 제공자 끄기 (미리보기)
//   ACTION=anonoff CONFIRM=ANONOFF                           실제로 끈다 (되돌리기 ANONON)
//   ACTION=fixleaveids                   node auth-admin.js  사번 없는 휴가증 채우기 (미리보기)
//   ACTION=fixleaveids CONFIRM=OK                            실제로 채운다
//   ACTION=ttl                           node auth-admin.js  휴가증 자동 삭제 정책 조회
//   ACTION=ttl CONFIRM=ON                                    켠다 (결제 계정 필요 — 못 씀)
//   ACTION=purge                         node auth-admin.js  만료된 휴가증 삭제 (미리보기)
//   ACTION=purge CONFIRM=OK                                  실제로 지운다
//   ACTION=leavecheck EMP_ID=사번|이름       node auth-admin.js  잔여·휴가증·이력 대조
//   ACTION=settle                        node auth-admin.js  차감 누락 정산 (미리보기)
//   ACTION=settle CONFIRM=OK                                 실제로 정산
//   ACTION=reset  EMP_ID=12224xxxx       node auth-admin.js  비밀번호를 1234 로 재설정
//   ACTION=remove EMP_ID=12224xxxx       node auth-admin.js  퇴직자 완전 삭제 (미리보기)
//   ACTION=remove EMP_ID=... CONFIRM=DELETE  실제 삭제 실행
//
// 필요 환경변수:
//   FIREBASE_SA_KEY  — Firebase Service Account JSON (문자열)

const admin = require('firebase-admin');

// script.js 의 STAFF_ROLES 와 동기화할 것
// 저장소가 공개라 사번 옆에 실명을 적지 않는다 — 이름은 Firestore 에서 온다.
const STAFF_ROLES = {
  '122210202': 'admin',
  '122240096': 'leader',
};

// script.js 의 AUTH_EMAIL_DOMAIN 과 동기화할 것
// 저장소가 PUBLIC 이라 GitHub Actions 실행 로그를 누구나 열람할 수 있다.
// (2026-08-25 확인 — 익명 요청에 200. 그때까지 쌓인 56건은 삭제했다.)
//
// 그래서 로그에 실명·연락처를 찍지 않는다. 사번은 남긴다 — 관리자는 사번으로
// 작업하고, 사번만으로는 외부에서 개인을 특정하기 어렵다.
const maskName = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '-';
  return s[0] + '*'.repeat(Math.max(1, s.length - 1));
};
// 뒤 4자리를 남기는 흔한 방식은 여기서 쓰면 안 된다 — 이 앱은 뒤 4자리
// (submitterPhone4)로 본인을 판별한다. 앞 3자리만 남기고 나머지를 가린다.
const maskPhone = (v) => {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '-';
  let seen = 0;
  return s.replace(/\d/g, (d) => (++seen <= 3 ? d : '*'));
};
const MASK_KEYS = { name: maskName, phone: maskPhone, securityQuestion: () => '(숨김)' };

const AUTH_EMAIL_DOMAIN = 'vacation.local';
const emailFor = (empId) => `${String(empId).trim()}@${AUTH_EMAIL_DOMAIN}`;
const empIdFromEmail = (email) => String(email || '').split('@')[0];

// script.js 의 DEFAULT_PASSWORD · authPasswordFor 와 동기화할 것.
// Firebase Auth 가 6자 이상을 요구해 기본 비밀번호 '1234' 는 패딩해서 저장한다.
// 사용자는 계속 '1234' 를 입력한다. 이 규칙이 어긋나면 로그인이 안 된다.
const DEFAULT_PASSWORD = '1234';
const authPasswordFor = (pw) => {
  const p = String(pw == null ? '' : pw);
  return p.length >= 6 ? p : (p + '______').slice(0, 6);
};

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

// ---------- cleanup: 이관 잔여 필드 일괄 정리 ----------
// 이관 시 클라이언트의 필드 삭제 쓰기가 실패해도 로그인은 통과시킨다(경고만).
// 그래서 평문 보안답변·비밀번호 해시가 남는 경우가 생긴다.
// 다음 로그인에서 재시도되지만 그 사이 계속 남아 있으므로 서버에서 정리한다.
//
// Auth 계정이 있는 사람만 대상으로 한다 — 미이관자는 password 로 로그인해야 하므로
// 지우면 로그인이 막힌다.
async function actionCleanup(db) {
  const confirm = String(process.env.CONFIRM || '').trim();
  const [authUsers, usersSnap] = await Promise.all([
    listAuthUsers(),
    db.collection('users').get(),
  ]);
  const authIds = new Set(authUsers.map((u) => empIdFromEmail(u.email)));

  const targets = [];
  usersSnap.forEach((d) => {
    const v = d.data() || {};
    const leftover = v.password !== undefined
      || v.securityAnswer !== undefined
      || v.securityQuestion !== undefined;
    if (!leftover && v.authMigrated === true) return;
    if (!leftover) return;                       // 지울 게 없다
    if (!authIds.has(d.id)) return;              // 미이관자는 건드리지 않는다
    targets.push({
      empId: d.id,
      password: v.password !== undefined,
      answer: v.securityAnswer !== undefined,
      question: v.securityQuestion !== undefined,
      migrated: v.authMigrated === true,
    });
  });

  console.log('===== 이관 잔여 필드 정리 =====');
  console.log(`users 문서 ${usersSnap.size}건 / Auth 계정 ${authIds.size}명`);
  console.log(`정리 대상 ${targets.length}명 (Auth 계정 있고 잔여 필드 있음)`);
  console.log('');
  if (!targets.length) {
    console.log('>>> 정리할 문서가 없습니다.');
    return;
  }
  targets.forEach((t) => {
    const what = [t.password && 'password', t.answer && 'securityAnswer',
                  t.question && 'securityQuestion'].filter(Boolean).join(', ');
    console.log(`  ${t.empId}   남은 필드: ${what}   authMigrated=${t.migrated}`);
  });
  console.log('');

  if (confirm !== 'OK') {
    console.log('>>> 미리보기입니다. 실제로 지우려면 CONFIRM=OK 로 다시 실행하세요.');
    return;
  }

  let done = 0;
  for (const t of targets) {
    await db.collection('users').doc(t.empId).set({
      authMigrated: true,
      authMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
      password: admin.firestore.FieldValue.delete(),
      securityAnswer: admin.firestore.FieldValue.delete(),
      securityQuestion: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    done += 1;
    console.log(`  정리 완료: ${t.empId}`);
  }
  console.log('');
  console.log(`>>> ${done}명 정리했습니다.`);
}

// ---------- rules: 현재 배포된 Firestore 보안 규칙 ----------
// 저장소의 firestore.rules 는 아직 배포 전이다. 실제로 적용 중인 규칙을 봐야
// 클라이언트 쓰기가 왜 막혔는지 판단할 수 있다.
async function actionRules() {
  const { JWT } = require('google-auth-library');
  const sa = loadServiceAccount();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const base = `https://firebaserules.googleapis.com/v1/projects/${sa.project_id}`;

  const rel = await client.request({ url: `${base}/releases` });
  const releases = (rel.data && rel.data.releases) || [];
  const fs = releases.find((r) => String(r.name).endsWith('cloud.firestore'));
  if (!fs) {
    console.log('cloud.firestore 릴리스를 찾지 못했습니다.');
    console.log('릴리스 목록:', releases.map((r) => r.name).join(', ') || '(없음)');
    return;
  }
  console.log('===== 현재 배포된 Firestore 규칙 =====');
  console.log(`릴리스   ${fs.name}`);
  console.log(`룰셋     ${fs.rulesetName}`);
  console.log(`생성     ${fs.createTime}`);
  console.log(`갱신     ${fs.updateTime}`);
  console.log('');

  const rs = await client.request({
    url: `https://firebaserules.googleapis.com/v1/${fs.rulesetName}`,
  });
  const files = ((rs.data || {}).source || {}).files || [];
  files.forEach((f) => {
    console.log(`----- ${f.name} -----`);
    console.log(f.content);
  });
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
  console.log(`workers  : ${w ? `${maskName(w.name)} / ${w.team || '-'} / ${w.department || '-'}` : '없음'}`);

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
    } else if (MASK_KEYS[k]) {
      shown = JSON.stringify(MASK_KEYS[k](v));
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
    return `${id}  ${maskName(w.name).padEnd(6, ' ')}${where ? '  ' + where : ''}`;
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
// ---------- testaccount: 일반 작업자 경로 확인용 임시 계정 ----------
//
// 규칙 배포 후 "일반 작업자가 새 기기에서 로그인되는가" 를 사람이 직접 확인하려면
// 일반 사번이 필요하다. 관리자·서무 사번은 STAFF_ROLES 에 박혀 있어 본인 문서
// 읽기가 실패해도 거기서 이름을 가져와 통과한다 — 판별이 안 된다.
//
// **users 문서만 만들고 workers 명단에는 넣지 않는다.**
//   - STAFF_ROLES 에 없으니 순수 일반 작업자 경로를 탄다
//   - 명단(workers) 기준인 서무 화면에는 보이지 않는다
//   - syncprofile 의 '명단에 없는 users 문서' 경고에는 잡힌다 (의도된 것)
//
// 확인이 끝나면 CONFIRM=DELETE 로 반드시 지운다.
const TEST_ACCOUNT = {
  empId: '999000001',
  name: '테스트계정',
  team: '화성',
  phone: '010-0000-0000',
};

async function actionTestAccount(db) {
  const confirm = String(process.env.CONFIRM || '').trim();
  const t = TEST_ACCOUNT;
  const email = emailFor(t.empId);
  const userRef = db.collection('users').doc(t.empId);

  console.log('===== 확인용 임시 계정 =====');
  console.log(`사번      ${t.empId}`);
  console.log(`이메일     ${email}`);

  let authUid = null;
  try {
    authUid = (await admin.auth().getUserByEmail(email)).uid;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  const userSnap = await userRef.get();
  console.log(`현재 상태   Auth ${authUid ? '있음' : '없음'} / users 문서 ${userSnap.exists ? '있음' : '없음'}`);

  if (confirm === 'DELETE') {
    console.log('');
    console.log('[삭제]');
    if (authUid) {
      await admin.auth().deleteUser(authUid);
      console.log('  Auth 계정 삭제');
    }
    if (userSnap.exists) {
      await userRef.delete();
      console.log('  users 문서 삭제');
    }
    const wSnap = await db.collection('workers').where('employeeId', '==', t.empId).get();
    for (const d of wSnap.docs) {
      await d.ref.delete();
      console.log('  workers 명단 항목 삭제');
    }
    // 확인하며 작성한 휴가증도 함께 치운다 — 남기면 서무 화면에 뜬다.
    const lvSnap = await db.collection('leaves').where('employeeId', '==', t.empId).get();
    if (!lvSnap.empty) {
      const batch = db.batch();
      lvSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      console.log(`  남은 휴가증 ${lvSnap.size}장 삭제`);
    }
    console.log('');
    console.log('>>> 임시 계정을 정리했습니다.');
    return;
  }

  if (confirm !== 'OK') {
    console.log('');
    console.log('만들려면  confirm 입력란에 OK');
    console.log('지우려면  confirm 입력란에 DELETE');
    return;
  }

  console.log('');
  console.log('[생성]');
  if (!authUid) {
    await admin.auth().createUser({
      email: email,
      password: authPasswordFor(DEFAULT_PASSWORD),
    });
    console.log(`  Auth 계정 생성 (비밀번호 ${DEFAULT_PASSWORD})`);
  } else {
    await admin.auth().updateUser(authUid, { password: authPasswordFor(DEFAULT_PASSWORD) });
    console.log(`  Auth 계정이 이미 있어 비밀번호만 ${DEFAULT_PASSWORD} 로 맞춤`);
  }

  await userRef.set({
    name: t.name,
    team: t.team,
    phone: t.phone,
    authMigrated: true,
    authMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
    // 잔여가 0이면 작성 단계에서 막혀 작성·취소 경로를 시험할 수 없다.
    balanceAnnual: 3,
    balanceBirth: 0,
    balanceSummer: 0,
  }, { merge: true });
  console.log('  users 문서 생성 (이름·팀·휴대폰, 연차 잔여 3)');

  // reset·premigrate·remove 는 모두 workers 명단을 먼저 확인한다.
  // 명단에 없으면 "찾지 못했습니다" 로 끝나 그 경로를 시험할 수 없다.
  const wSnap = await db.collection('workers').where('employeeId', '==', t.empId).get();
  if (wSnap.empty) {
    await db.collection('workers').doc(t.empId).set({
      employeeId: t.empId,
      name: t.name,
      team: t.team,
      department: '생산3팀',
      phone: t.phone,
    });
    console.log('  workers 명단 항목 생성 (reset·remove 경로 확인용)');
  } else {
    console.log('  workers 명단 항목이 이미 있습니다');
  }

  console.log('');
  console.log('>>> 시크릿 창에서 아래로 로그인해 보세요.');
  console.log(`      사번      ${t.empId}`);
  console.log(`      비밀번호   ${DEFAULT_PASSWORD}`);
  console.log('');
  console.log('    확인할 것 (일반 작업자 경로 — 관리자·서무 계정으로는 검증되지 않는다)');
  console.log('      1. [내 휴가증] 이 열리고 본인 것만 보이는가');
  console.log('      2. 휴가증을 작성할 수 있는가 (연차 1개)');
  console.log('      3. 작성한 것을 [삭제]·[취소] 로 지울 수 있는가');
  console.log('         ← 예전에는 규칙이 isStaff() 뿐이라 여기서 권한 오류가 났다');
  console.log('');
  console.log('    ⚠️ 명단에 넣었으므로 서무 화면 [작업자 명단] 에 보입니다.');
  console.log('       확인이 끝나면 반드시 confirm=DELETE 로 지우세요.');
  console.log('       (남긴 휴가증도 함께 지워집니다)');
}

// ---------- testrules: 실제 토큰으로 배포된 규칙 검증 ----------
//
// 비밀번호 없이 "이 사람이 이 경로를 읽을 수 있는가" 를 확인한다.
//
// Rules API 의 :test(시뮬레이터)는 이 서비스 계정 권한 밖이다 — 룰셋 생성·배포는
// 되는데 :test 만 'caller does not have permission' 이 난다. 대신 **실제로 읽어
// 본다**: 임시 계정에 커스텀 토큰을 발급해 ID 토큰으로 바꾼 뒤 Firestore REST 를
// 호출한다. 시뮬레이터보다 확실하다 — 배포된 규칙이 실제 데이터에 적용된 결과다.
//
//   403 = 규칙이 막음   ·   200/404 = 규칙이 허용 (문서가 없으면 404)
//
// 임시 계정(사번 000000000)을 쓰므로 실제 작업자 계정의 로그인 기록을 건드리지
// 않는다. 끝나면 삭제한다.
async function actionTestRules() {
  const fsMod = require('fs');
  const pathMod = require('path');
  const sa = loadServiceAccount();
  const project = sa.project_id;

  // 웹 API 키는 script.js 의 firebaseConfig 에 있다(공개 값). 한 곳만 두기 위해
  // 하드코딩하지 않고 거기서 읽는다.
  const appJs = fsMod.readFileSync(pathMod.join(__dirname, '..', 'script.js'), 'utf8');
  const keyMatch = appJs.match(/apiKey:\s*"([^"]+)"/);
  if (!keyMatch) throw new Error('script.js 에서 apiKey 를 찾지 못했습니다.');
  const apiKey = keyMatch[1];

  const TEST_EMP = '000000000';
  const testEmail = emailFor(TEST_EMP);
  // 남의 문서 대조용 (읽지 못해야 한다). 규칙이 존재 여부보다 먼저 평가되므로
  // 실재하지 않는 사번이어도 permission-denied 가 나온다 — 실제 사번을 쓸 이유가 없다.
  const REAL_OTHER = '900000002';

  console.log('===== 배포된 규칙 검증 (실제 토큰) =====');
  console.log(`프로젝트   ${project}`);
  console.log(`임시 계정   ${testEmail}`);

  // 배포 상태를 함께 찍어 무엇을 검증했는지 남긴다.
  try {
    const { JWT } = require('google-auth-library');
    const jwt = new JWT({
      email: sa.client_email, key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const rel = await jwt.request({
      url: `https://firebaserules.googleapis.com/v1/projects/${project}/releases`,
    });
    const fsRel = ((rel.data && rel.data.releases) || [])
      .find((r) => String(r.name).endsWith('cloud.firestore'));
    if (fsRel) console.log(`룰셋       ${fsRel.rulesetName}  (갱신 ${fsRel.updateTime})`);
  } catch (e) {
    console.log(`(릴리스 조회 실패: ${e.message})`);
  }

  // 1) 임시 계정 준비
  let uid;
  try {
    const u = await admin.auth().getUserByEmail(testEmail);
    uid = u.uid;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    const u = await admin.auth().createUser({
      email: testEmail,
      password: 'ruletest-' + Date.now(),
    });
    uid = u.uid;
  }

  async function idTokenFor(claims) {
    const custom = await admin.auth().createCustomToken(uid, claims || {});
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }),
      });
    const body = await r.json();
    if (!r.ok || !body.idToken) {
      throw new Error('ID 토큰 발급 실패: ' + JSON.stringify(body));
    }
    return body.idToken;
  }

  const docBase = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

  async function tryRead(idToken, path) {
    const r = await fetch(`${docBase}/${path}`, {
      headers: { Authorization: 'Bearer ' + idToken },
    });
    return r.status;
  }

  // 2) 역할별 토큰. 커스텀 토큰의 sign_in_provider 는 'custom' 이라 익명이 아니다 —
  //    규칙의 signedIn() 을 통과한다. 익명 경로는 Console 에서 이미 껐다.
  const tokens = {
    worker: await idTokenFor({}),
    leader: await idTokenFor({ role: 'leader' }),
    admin: await idTokenFor({ role: 'admin' }),
  };

  // 3) 검사 — [설명, 기대(allow|deny), 토큰, 경로]
  const checks = [
    ['일반 작업자 → 본인 users 읽기',   'allow', 'worker', `users/${TEST_EMP}`],
    ['일반 작업자 → 남의 users 읽기',   'deny',  'worker', `users/${REAL_OTHER}`],
    ['일반 작업자 → users 전체 조회',   'deny',  'worker', 'users?pageSize=1'],
    ['일반 작업자 → workers 전체 조회', 'deny',  'worker', 'workers?pageSize=1'],
    // 조건 없이 전체를 훑는 것은 막혀야 한다 — 남의 휴가증이 섞이기 때문이다.
    // 본인 사번으로 좁힌 쿼리는 아래 4)에서 따로 확인한다.
    ['일반 작업자 → leaves 전체 조회',  'deny',  'worker', 'leaves?pageSize=1'],
    ['일반 작업자 → system 읽기',       'deny',  'worker', 'system/balanceReset'],
    ['일반 작업자 → balanceLogs 조회',  'deny',  'worker', 'balanceLogs?pageSize=1'],
    ['서무 → workers 전체 조회',        'allow', 'leader', 'workers?pageSize=1'],
    ['서무 → users 전체 조회',          'allow', 'leader', 'users?pageSize=1'],
    ['서무 → 남의 users 읽기',          'allow', 'leader', `users/${REAL_OTHER}`],
    ['서무 → system 읽기',              'allow', 'leader', 'system/balanceReset'],
    ['관리자 → workers 전체 조회',      'allow', 'admin',  'workers?pageSize=1'],
  ];

  console.log('');
  let fail = 0;
  for (const [label, expect, who, path] of checks) {
    const status = await tryRead(tokens[who], path);
    const denied = status === 403;
    const ok = (expect === 'deny') === denied;
    if (!ok) fail++;
    console.log(`  ${ok ? 'OK  ' : '!!  '}${expect.padEnd(5)} HTTP ${status}  ${label}`);
  }

  // 4) leaves — 본인 사번으로 좁힌 쿼리는 통과해야 한다.
  //    GET 목록은 막히는 게 정상이므로, 앱이 실제로 쓰는 형태(where)로 확인한다.
  {
    const res = await fetch(`${docBase}:runQuery`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tokens.worker,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'leaves' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'employeeId' },
              op: 'EQUAL',
              value: { stringValue: TEST_EMP },
            },
          },
          limit: 1,
        },
      }),
    });
    const ok = res.status === 200;
    if (!ok) fail++;
    console.log(`  ${ok ? 'OK  ' : '!!  '}allow HTTP ${res.status}  일반 작업자 → 본인 사번으로 좁힌 leaves 조회`);
  }

  // 5) 미인증 — 토큰 없이
  const anonStatus = await (await fetch(`${docBase}/users/${TEST_EMP}`)).status;
  {
    const ok = anonStatus === 403 || anonStatus === 401;
    if (!ok) fail++;
    console.log(`  ${ok ? 'OK  ' : '!!  '}deny  HTTP ${anonStatus}  미인증 → users 읽기`);
  }

  // 6) 임시 계정 정리
  await admin.auth().deleteUser(uid);
  console.log('');
  console.log(`임시 계정 삭제 완료 (${testEmail})`);

  const total = checks.length + 2;   // + 좁힌 leaves 조회 + 미인증
  console.log('');
  console.log(`${total}건 중 ${total - fail}건 기대와 일치` + (fail ? `, ${fail}건 불일치` : ''));
  if (fail) {
    console.log('');
    console.log('>>> 규칙이 의도와 다릅니다. 배포 전 상태로 되돌릴지 검토하세요.');
    process.exitCode = 1;
  } else {
    console.log('>>> 규칙은 의도대로 동작합니다.');
    console.log('    일반 작업자가 본인 users 문서를 읽을 수 있으므로 새 기기 로그인이 됩니다.');
    console.log('    (규칙 판정만 확인했습니다. 앱 화면 동작은 별개로 확인해야 합니다.)');
  }
}

// ---------- syncprofile: users 문서에 이름·팀·휴대폰 채우기 ----------
//
// 로그인은 이름·팀·휴대폰이 필요한데, 예전에는 workers 명단 전체를 받아 거기서
// 찾았다. 보안 규칙 배포(2026-08-06) 후 `workers` 의 list 는 서무·관리자만
// 허용되므로 일반 작업자는 명단을 받을 수 없다. 로컬 캐시에 의존하면 캐시가
// 빈 새 기기·시크릿 창에서 로그인이 막힌다.
//
// 그래서 본인 정보를 본인 users 문서에 둔다 — 규칙이 본인 문서 읽기는 허용한다.
// 규칙을 느슨하게 하지 않고, 로그인이 필요한 최소 권한으로 완결된다.
//
// **명단(workers)을 고친 뒤에는 이걸 다시 돌려야 한다.** 앱은 Firestore workers 를
// 읽기만 하므로(명단 편집은 로컬 캐시) 자동 동기화 지점이 없다.
async function actionSyncProfile(db) {
  const confirmed = String(process.env.CONFIRM || '').trim() === 'OK';
  console.log(`===== users 이름·팀·휴대폰 동기화${confirmed ? '' : ' (미리보기)'} =====`);

  const [workersSnap, usersSnap] = await Promise.all([
    db.collection('workers').get(),
    db.collection('users').get(),
  ]);

  const users = new Map();
  usersSnap.forEach((d) => users.set(d.id, d.data() || {}));

  const toWrite = [];
  const same = [];
  const missingDoc = [];
  workersSnap.forEach((d) => {
    const w = d.data() || {};
    const empId = String(w.employeeId || '').trim();
    if (!empId) return;
    const want = {
      name: w.name || '',
      team: w.team || '',
      phone: w.phone || '',
    };
    const cur = users.get(empId);
    if (!cur) { missingDoc.push({ empId, want }); toWrite.push({ empId, want }); return; }
    if (cur.name === want.name && cur.team === want.team && cur.phone === want.phone) {
      same.push(empId);
      return;
    }
    toWrite.push({ empId, want, from: { name: cur.name, team: cur.team, phone: cur.phone } });
  });

  console.log(`작업자 명단   ${workersSnap.size}명`);
  console.log(`이미 일치     ${same.length}명`);
  console.log(`갱신 대상     ${toWrite.length}명` +
    (missingDoc.length ? `  (users 문서 없어 새로 만드는 건 ${missingDoc.length}명)` : ''));

  toWrite.slice(0, 20).forEach((t) => {
    const f = t.from;
    console.log(`  ${t.empId}  ${maskName(t.want.name)} / ${t.want.team || '-'}` +
      (f ? `   (이전: ${f.name || '-'} / ${f.team || '-'})` : '   ← 문서 생성'));
  });
  if (toWrite.length > 20) console.log(`  ... 외 ${toWrite.length - 20}명`);

  // 명단에 없는 users 문서 — 퇴직 처리가 덜 된 흔적일 수 있다.
  const workerIds = new Set();
  workersSnap.forEach((d) => {
    const id = String((d.data() || {}).employeeId || '').trim();
    if (id) workerIds.add(id);
  });
  const orphan = [];
  users.forEach((v, id) => { if (!workerIds.has(id)) orphan.push(id); });
  if (orphan.length) {
    console.log('');
    console.log(`※ 명단에 없는 users 문서 ${orphan.length}건 — 퇴직 처리 확인 필요`);
    orphan.slice(0, 20).forEach((id) => console.log(`   ${id}`));
  }

  if (!confirmed) {
    console.log('');
    console.log('>>> 미리보기입니다. 실제로 쓰려면 confirm 입력란에 OK 를 넣고 다시 실행하세요.');
    return;
  }

  console.log('');
  console.log('[쓰기 실행]');
  let n = 0;
  for (let i = 0; i < toWrite.length; i += 400) {
    const batch = db.batch();
    toWrite.slice(i, i + 400).forEach((t) => {
      batch.set(db.collection('users').doc(t.empId), t.want, { merge: true });
      n++;
    });
    await batch.commit();
  }
  console.log(`  ${n}명 갱신 완료`);
  console.log('');
  console.log('>>> 이제 일반 작업자도 새 기기에서 로그인할 수 있습니다.');
  console.log('    명단을 고친 뒤에는 이 작업을 다시 실행하세요.');
}

// ---------- deployrules: firestore.rules 배포 ----------
//
// firebase CLI 를 쓰지 않는다 (이 저장소에 firebase.json 이 없고 CLI 로그인도
// 없다). ACTION=rules 와 같은 서비스 계정으로 Rules REST API 를 직접 호출한다.
//
// 순서: 룰셋 생성 → 릴리스가 그 룰셋을 가리키게 갱신.
// 룰셋 생성 단계에서 문법 검사가 이뤄지므로, 규칙이 잘못됐으면 릴리스 전에 막힌다.
//
// 기본은 미리보기다. CONFIRM=DEPLOY 를 줘야 실제로 배포한다 —
// 규칙을 잘못 올리면 전 직원이 로그인하지 못한다.
async function actionDeployRules() {
  const fsMod = require('fs');
  const pathMod = require('path');
  const { JWT } = require('google-auth-library');

  const file = pathMod.join(__dirname, '..', 'firestore.rules');
  if (!fsMod.existsSync(file)) throw new Error(`규칙 파일이 없습니다: ${file}`);
  const content = fsMod.readFileSync(file, 'utf8');

  const confirmed = String(process.env.CONFIRM || '').trim() === 'DEPLOY';
  const sa = loadServiceAccount();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const base = `https://firebaserules.googleapis.com/v1/projects/${sa.project_id}`;
  const releaseName = `projects/${sa.project_id}/releases/cloud.firestore`;

  console.log(`===== Firestore 규칙 배포${confirmed ? '' : ' (미리보기)'} =====`);
  console.log(`프로젝트  ${sa.project_id}`);
  console.log(`파일      firestore.rules  ${content.length.toLocaleString()}자 / ` +
              `${content.split('\n').length}줄`);

  // 현재 릴리스
  let current = null;
  try {
    const rel = await client.request({ url: `${base}/releases` });
    const releases = (rel.data && rel.data.releases) || [];
    current = releases.find((r) => String(r.name).endsWith('cloud.firestore')) || null;
  } catch (e) {
    console.log(`  (현재 릴리스 조회 실패: ${e.message})`);
  }
  console.log(`현재 룰셋  ${current ? current.rulesetName : '(없음)'}`);
  if (current) console.log(`현재 갱신  ${current.updateTime}`);

  // 이관이 안 끝났으면 배포하지 않는다 — 규칙을 올리면 미이관자가 로그인 못 한다.
  const db = admin.firestore();
  const [authUsers, workersSnap] = await Promise.all([
    listAuthUsers(),
    db.collection('workers').get(),
  ]);
  const authIds = new Set(authUsers.map((u) => empIdFromEmail(u.email)));
  const notMigrated = [];
  workersSnap.forEach((d) => {
    const v = d.data() || {};
    const id = String(v.employeeId || '').trim();
    if (id && !authIds.has(id)) notMigrated.push(`${id} ${v.name || ''}`);
  });

  console.log('');
  console.log(`이관 현황  ${authIds.size} / ${workersSnap.size}명`);
  if (notMigrated.length) {
    console.log('');
    console.log('※ 아직 이관되지 않은 작업자가 있어 배포를 중단합니다.');
    notMigrated.forEach((s) => console.log(`   ${s}`));
    console.log('');
    console.log('  ACTION=premigrate 로 미리 이관하거나 본인 로그인을 기다린 뒤 다시 실행하세요.');
    process.exitCode = 1;
    return;
  }
  console.log('  전원 이관 완료 — 배포 가능');

  if (!confirmed) {
    console.log('');
    console.log('>>> 미리보기입니다. 실제로 배포하려면 confirm 입력란에 DEPLOY 를 넣고 다시 실행하세요.');
    return;
  }

  // 룰셋 생성 (여기서 문법 검사가 된다)
  console.log('');
  console.log('[배포 실행]');
  const created = await client.request({
    url: `${base}/rulesets`,
    method: 'POST',
    data: { source: { files: [{ name: 'firestore.rules', content }] } },
  });
  const rulesetName = created.data.name;
  console.log(`  룰셋 생성 완료  ${rulesetName}`);

  // 릴리스 갱신
  await client.request({
    url: `https://firebaserules.googleapis.com/v1/${releaseName}`,
    method: 'PATCH',
    data: { release: { name: releaseName, rulesetName } },
  });
  console.log(`  릴리스 갱신 완료  ${releaseName}`);

  console.log('');
  console.log('>>> 배포 완료. 즉시 적용됩니다.');
  console.log('    남은 일: Firebase Console → Authentication → Sign-in method');
  console.log('             에서 "익명" 을 사용 중지해야 익명 접근 경로가 완전히 닫힙니다.');
  if (current) console.log(`    되돌리려면 이전 룰셋: ${current.rulesetName}`);
}

// ---------- premigrate: 로그인할 수 없는 사람을 서버에서 미리 이관 ----------
//
// 이관은 원래 자가 진행이다 — 로그인하는 순간(평문 비밀번호를 아는 유일한 시점)
// 브라우저가 Auth 계정을 만든다. 그런데 휴직처럼 한동안 로그인할 수 없는 사람이
// 있으면 전원 이관이 끝나지 않아 보안 규칙을 배포할 수 없다.
//
// 규칙을 배포하면 자가 이관 경로가 막힌다 — 이관 전 로그인은 익명 인증으로
// users 문서를 읽어 비밀번호를 확인하는데, 새 규칙이 익명을 사용자로 인정하지
// 않는다. 그래서 복직 후에도 로그인이 안 된다.
//
// **기본 비밀번호(1234) 상태인 사람만** 대상으로 한다. 그 경우 서버가 만드는
// 계정의 비밀번호가 어차피 1234 라서 본인 입장에서 달라지는 게 없다.
// 비밀번호를 바꿔 쓰던 사람은 해시만 있어 평문을 알 수 없으므로, 미리 이관하면
// 비밀번호가 1234 로 바뀌어 버린다. 그건 본인 모르게 할 일이 아니라서
// CONFIRM=RESETPW 를 요구한다.
async function actionPremigrate(db) {
  const empId = String(process.env.EMP_ID || '').trim();
  if (!empId) throw new Error('EMP_ID 가 필요합니다. (미리 이관할 작업자 사번)');
  const allowPwReset = String(process.env.CONFIRM || '').trim() === 'RESETPW';

  console.log(`===== 서버 이관: ${empId} =====`);

  const wSnap = await db.collection('workers').where('employeeId', '==', empId).get();
  if (wSnap.empty) {
    console.log('※ 작업자 명단에서 찾지 못했습니다. 사번을 다시 확인하세요.');
    process.exitCode = 1;
    return;
  }
  const w = wSnap.docs[0].data() || {};
  const name = w.name || empId;
  console.log(`  이름: ${maskName(name)} / 팀: ${w.team || '-'} / 부서: ${w.department || '-'}`);

  // 이미 Auth 계정이 있으면 손대지 않는다.
  try {
    await admin.auth().getUserByEmail(emailFor(empId));
    console.log(`  이미 Auth 계정이 있습니다 — 이관 완료 상태입니다. 아무것도 하지 않습니다.`);
    return;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  const userRef = db.collection('users').doc(empId);
  const userSnap = await userRef.get();
  const u = userSnap.exists ? (userSnap.data() || {}) : {};

  if (u.password !== undefined && !allowPwReset) {
    console.log('');
    console.log('※ 이 분은 비밀번호를 직접 바꿔 쓰고 있습니다 (password 필드 존재).');
    console.log('  해시만 있어 평문을 알 수 없으므로, 지금 미리 이관하면 비밀번호가');
    console.log(`  ${DEFAULT_PASSWORD} 로 바뀝니다. 본인 동의 없이 할 일이 아닙니다.`);
    console.log('');
    console.log('  선택:');
    console.log('   1) 본인이 직접 로그인할 때까지 기다린다 (권장)');
    console.log('   2) 본인에게 알린 뒤 confirm 입력란에 RESETPW 를 넣고 다시 실행한다');
    process.exitCode = 1;
    return;
  }

  const pwChanged = u.password !== undefined;
  await admin.auth().createUser({
    email: emailFor(empId),
    password: authPasswordFor(DEFAULT_PASSWORD),
  });
  console.log(`  Auth 계정 생성 완료 (${emailFor(empId)})`);

  // 브라우저 자가 이관과 같은 뒷정리를 한다.
  await userRef.set({
    authMigrated: true,
    authMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
    password: admin.firestore.FieldValue.delete(),
    securityQuestion: admin.firestore.FieldValue.delete(),
    securityAnswer: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  console.log('  users 문서 정리 완료 (authMigrated=true, 인증 잔여 필드 제거)');

  console.log('');
  console.log(`>>> ${maskName(name)}(${empId}) 님 이관 완료. 사번 + ${DEFAULT_PASSWORD} 로 로그인됩니다.`);
  if (pwChanged) {
    console.log(`    ⚠️ 기존 비밀번호는 무효가 됐습니다. 본인에게 ${DEFAULT_PASSWORD} 를 알려주세요.`);
  } else {
    console.log('    원래 기본 비밀번호 상태였으므로 본인 입장에서 달라지는 것은 없습니다.');
  }
  console.log('    로그인 직후 새 비밀번호 등록 안내가 자동으로 표시됩니다.');
}

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

  // 계정을 지우면 안 된다.
  //
  // 지우면 그 사람은 로그인할 때 클라이언트의 자가 이관 경로(migrateThenLogin)
  // 로 빠지는데, 그 경로는 users 문서를 먼저 읽는다. 2026-08-06 배포한 규칙은
  // users get 에 signedIn() 을 요구하므로 로그인 전에는 읽히지 않는다. 익명
  // 로그인도 2026-08-24 에 껐다. 결국 초기화된 사람은 영영 못 들어온다.
  // (이승연 사례 — 초기화 후 이틀간 로그인 불가, premigrate 로 복구)
  //
  // 계정을 남겨 두고 비밀번호만 바꾸면 1순위 Auth 로그인이 바로 통과해서
  // 자가 이관 경로를 아예 타지 않는다.
  try {
    const user = await admin.auth().getUserByEmail(emailFor(empId));
    await admin.auth().updateUser(user.uid, {
      password: authPasswordFor(DEFAULT_PASSWORD),
    });
    console.log(`  비밀번호를 ${DEFAULT_PASSWORD} 로 재설정했습니다 (${maskName(name)})`);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      // 계정이 없는 사람 = 옛 reset 으로 지워졌거나 아직 이관 전.
      // 여기서 만들어 줘야 로그인이 된다.
      await admin.auth().createUser({
        email: emailFor(empId),
        password: authPasswordFor(DEFAULT_PASSWORD),
      });
      console.log(`  Auth 계정이 없어 새로 만들었습니다 (${maskName(name)})`);
    } else {
      throw e;
    }
  }

  // Firestore 잔여 인증 필드 정리 + 요청 플래그 해제.
  // authMigrated 는 지우지 않는다 — 계정이 살아 있으므로 이관된 상태가 맞다.
  await db.collection('users').doc(empId).set({
    authMigrated: true,
    authMigratedAt: admin.firestore.FieldValue.serverTimestamp(),
    password: admin.firestore.FieldValue.delete(),
    securityQuestion: admin.firestore.FieldValue.delete(),
    securityAnswer: admin.firestore.FieldValue.delete(),
    pwResetRequested: admin.firestore.FieldValue.delete(),
    pwResetRequestedAt: admin.firestore.FieldValue.delete(),
    pwResetRequestedBy: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  console.log('');
  console.log(`>>> ${maskName(name)}(${empId}) 님은 이제 사번 + ${DEFAULT_PASSWORD} 로 로그인할 수 있습니다.`);
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
  const w = wSnap.empty ? {} : (wSnap.docs[0].data() || {});
  let name = w.name || '';

  if (wSnap.empty) {
    // 명단에 없어도 users·leaves 가 남아 있으면 지울 수 있게 한다 —
    // 이미 퇴직 처리한 사람의 유령 문서 정리용이다.
    // 2026-08-06 실측: 생휴 월 리셋이 서무 기기의 옛 캐시 명단으로 돌면서
    // 삭제한 사번의 users 문서를 set(merge) 로 되살렸다.
    const leftoverUser = await db.collection('users').doc(empId).get();
    const leftoverLeaves = await db.collection('leaves')
      .where('employeeId', '==', empId).limit(1).get();
    if (!leftoverUser.exists && leftoverLeaves.empty) {
      console.log('※ 작업자 명단에도, 남은 문서에도 없습니다. 사번을 확인하세요.');
      process.exitCode = 1;
      return;
    }
    name = (leftoverUser.exists && (leftoverUser.data() || {}).name) || empId;
    console.log(`  ※ 명단에는 없습니다 — 이미 퇴직 처리된 사번의 잔여 문서 정리입니다.`);
  }

  name = name || empId;
  console.log(`  이름: ${maskName(name)} / 팀: ${w.team || '-'} / 부서: ${w.department || '-'}`);

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

  // 3) 지워질 것 요약
  //
  // 예전에는 여기서 백업 JSON 전체를 찍었다. 저장소가 PUBLIC 이라 Actions 로그가
  // 누구나 열람 가능해서 전화번호·휴가 사유가 그대로 공개됐다(2026-08-25 확인).
  // 복원 근거를 공개된 곳에 두는 것은 애초에 맞지 않는다 — 요약만 남긴다.
  console.log('');
  console.log('[지워질 것] — 되돌릴 수 없습니다. 사번을 다시 확인하세요.');
  console.log(`  workers ${wSnap.size}건 · users ${u ? 1 : 0}건 · leaves ${leaveDocs.size}건`
    + ` · Auth ${authUid ? 1 : 0}건`);

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
  console.log(`>>> ${maskName(name)}(${empId}) 삭제 완료. 남은 작업자 ${remain.size}명.`);
  console.log('    각 기기는 다음 접속 시 명단에서 자동으로 사라집니다.');
}

// ---------- settle: 처리됐는데 차감 안 된 휴가증을 서버에서 정산 ----------
//
// 왜 서버에서 하는가.
//   브라우저 차감은 화면 목록(leaves 배열)을 보고 계산한다. 새로고침·다른 PC·
//   목록 비움 중 하나만 걸려도 조용히 건너뛴다. 게다가 건너뛸 때 뜨는 문구가
//   "이미 차감됐거나…" 라 정상으로 읽힌다. 실제로 2026-05 개시 이후 balanceLogs
//   에 deduct 기록이 단 한 건도 없다 — 넉 달 내내 차감이 안 됐고 서무가 manual
//   로 메워 왔다.
//
//   서버에서 "processed=true 인데 deductedAt 이 없는 휴가증" 을 직접 찾으면
//   화면 상태와 무관하게 항상 같은 답이 나온다.
//
// 계산 규칙은 script.js 와 같아야 한다 — 어긋나면 잔여가 두 벌로 갈린다.
//   연차·반차·반반차 → 연차에서 일수만큼
//   생휴            → 생휴에서 개수만큼
//   하기휴가         → 하기휴가에서 개수만큼
//   경조·결근        → 차감 없음
const TYPE_WEIGHT = {
  '연차': 1,
  '반차(오전)': 0.5, '반차(오후)': 0.5,
  '반반차(오전)': 0.25, '반반차(오후)': 0.25,
  '생휴': 1,
  '하기휴가': 3,
  '경조': 1,
  '결근': 1, '결근(오전)': 0.5, '결근(오후)': 0.5,
};
const TYPE_RENAME = { '무결': '결근' };

function leaveItemsOf(v) {
  const rename = (t) => TYPE_RENAME[t] || t;
  if (Array.isArray(v.items) && v.items.length) {
    return v.items.map((it) => ({ type: rename(it && it.type), count: it && it.count }));
  }
  if (v.type) return [{ type: rename(v.type), count: 1 }];
  return [];
}

async function actionSettle(db) {
  const confirmed = String(process.env.CONFIRM || '').trim() === 'OK';
  console.log(`===== 차감 정산${confirmed ? '' : ' (미리보기)'} =====`);

  // 항목마다 "언제부터 안 빠졌는가" 가 다르다. 하나로 자르면 틀린다.
  //
  //   연차     서무가 2026-08-11 에 그룹웨어 실제 잔여와 대조해 손으로 맞췄다.
  //            그 시점 값은 그때까지 쓴 것이 반영된 값이다 → 그 뒤 것만 차감.
  //   생휴     서무는 손대지 않았다. 대신 매달 1일 1개로 리셋된다
  //            → 마지막 리셋 뒤에 쓴 것만 차감. 지난달 것을 지금 빼면 안 된다.
  //   하기휴가  서무도 안 건드렸고 리셋도 없다 → 개시 이후 전부 차감.
  //
  // manual 로그의 changes 에 birth·summer 가 같이 찍혀 있지만, 그건
  // saveWorkerBalances 가 행 전체를 기록하기 때문이지 건드렸다는 뜻이 아니다.
  const lastManual = new Map();   // 연차 기준
  const lastReset = new Map();    // 생휴 기준
  const blSnap = await db.collection('balanceLogs').get();
  blSnap.forEach((d) => {
    const v = d.data() || {};
    const id = String(v.empId || '').trim();
    const at = v.at && typeof v.at.toDate === 'function' ? v.at.toDate() : null;
    if (!id || !at) return;
    if (v.type === 'manual') {
      if (!lastManual.has(id) || at > lastManual.get(id)) lastManual.set(id, at);
    } else if (v.type === 'reset') {
      if (!lastReset.has(id) || at > lastReset.get(id)) lastReset.set(id, at);
    }
  });

  const snap = await db.collection('leaves').get();
  const byEmp = new Map();   // empId -> { annual, birth, summer, refs[], lines[] }
  let skippedNoId = 0, notProcessed = 0, already = 0, future = 0;
  let beforeManual = 0, beforeReset = 0;

  snap.forEach((d) => {
    const v = d.data() || {};
    if (v.processed !== true) { notProcessed++; return; }
    if (v.deductedAt) { already++; return; }
    const empId = String(v.employeeId || '').trim();
    if (!empId) { skippedNoId++; return; }

    // 아직 오지 않은 휴가는 차감하지 않는다.
    // 생휴는 매달 1일 1개로 리셋된다(reset-birth). 9월 생휴를 8월에 빼 두면
    // 9/1 리셋이 1로 되돌리고, 그 휴가증은 이미 deductedAt 이 찍혀 다시는
    // 차감되지 않는다 — 9월 내내 1개가 남는다.
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (v.start && String(v.start) > today) { future++; return; }

    const pAt = v.processedAt && typeof v.processedAt.toDate === 'function'
      ? v.processedAt.toDate() : null;
    const cutAnnual = lastManual.get(empId);
    const cutBirth = lastReset.get(empId);
    const skipAnnual = cutAnnual && pAt && pAt <= cutAnnual;
    const skipBirth = cutBirth && pAt && pAt <= cutBirth;

    if (!byEmp.has(empId)) {
      byEmp.set(empId, { annual: 0, birth: 0, summer: 0, refs: [], lines: [] });
    }
    const e = byEmp.get(empId);
    e.refs.push(d.ref);
    leaveItemsOf(v).forEach((it) => {
      const type = it.type;
      const count = parseFloat(it.count) || 0;
      if (count <= 0) return;
      if (type === '연차' || String(type).startsWith('반차') || String(type).startsWith('반반차')) {
        if (skipAnnual) { beforeManual++; return; }
        const days = (TYPE_WEIGHT[type] || 0) * count;
        if (days > 0) { e.annual += days; e.lines.push(`${type} ${count}개(-${days})`); }
      } else if (type === '생휴') {
        if (skipBirth) { beforeReset++; return; }
        e.birth += count; e.lines.push(`생휴 ${count}개`);
      } else if (type === '하기휴가') {
        e.summer += count; e.lines.push(`하기휴가 ${count}개`);
      }
    });
  });

  const targets = [...byEmp.entries()].filter(([, e]) => e.annual > 0 || e.birth > 0 || e.summer > 0);
  console.log(`휴가증 ${snap.size}장 · 미처리 ${notProcessed} · 이미 차감 ${already}`
    + ` · 사번없음 ${skippedNoId}`);
  console.log('');
  console.log('[제외한 것]');
  console.log(`  아직 오지 않은 휴가            ${future}장`);
  console.log(`  연차 — 서무 수기 조정 이전     ${beforeManual}건  (그룹웨어 대조로 이미 반영)`);
  console.log(`  생휴 — 지난달 리셋 이전        ${beforeReset}건  (리셋으로 이미 되돌아감)`);
  console.log(`  하기휴가                       제외 없음 (수기 조정·리셋 대상 아님)`);
  console.log('');
  console.log(`정산 대상 ${targets.length}명`);

  if (!targets.length) {
    console.log('');
    console.log('>>> 정산할 것이 없습니다.');
    return;
  }

  // 현재 잔여를 읽어 차감 후 값을 보여준다. 마이너스가 되는 사람은 따로 표시.
  const rows = [];
  for (const [empId, e] of targets) {
    const uDoc = await db.collection('users').doc(empId).get();
    const u = uDoc.exists ? (uDoc.data() || {}) : {};
    const nowA = typeof u.balanceAnnual === 'number' ? u.balanceAnnual : 0;
    const nowB = typeof u.balanceBirth === 'number' ? u.balanceBirth : 0;
    const nowS = typeof u.balanceSummer === 'number' ? u.balanceSummer : 0;
    rows.push({
      empId, e,
      after: {
        annual: Math.round((nowA - e.annual) * 100) / 100,
        birth: nowB - e.birth,
        summer: nowS - e.summer,
      },
      before: { annual: nowA, birth: nowB, summer: nowS },
    });
  }

  console.log('');
  console.log('[대상]  사번  휴가증  연차 → / 생휴 → / 하기 →');
  rows.sort((a, b) => a.empId.localeCompare(b.empId));
  const minus = [];
  rows.forEach((r) => {
    const parts = [];
    if (r.e.annual > 0) parts.push(`연차 ${r.before.annual}→${r.after.annual}`);
    if (r.e.birth > 0) parts.push(`생휴 ${r.before.birth}→${r.after.birth}`);
    if (r.e.summer > 0) parts.push(`하기 ${r.before.summer}→${r.after.summer}`);
    console.log(`  ${r.empId}  ${String(r.e.refs.length).padStart(2)}장  ${parts.join(' · ')}`);
    if (r.after.annual < 0 || r.after.birth < 0 || r.after.summer < 0) minus.push(r.empId);
  });

  if (minus.length) {
    console.log('');
    console.log(`⚠ 차감하면 마이너스가 되는 사번 ${minus.length}명 — ${minus.join(', ')}`);
    console.log('  서무가 manual 로 이미 메워 둔 경우일 수 있습니다. 확인 후 진행하세요.');
  }

  if (!confirmed) {
    console.log('');
    console.log('>>> 미리보기입니다. 반영하려면 confirm 입력란에 OK 를 넣고 다시 실행하세요.');
    return;
  }

  console.log('');
  console.log('[반영]');
  let done = 0;
  for (const r of rows) {
    const upd = {};
    if (r.e.annual > 0) upd.balanceAnnual = r.after.annual;
    if (r.e.birth > 0) upd.balanceBirth = r.after.birth;
    if (r.e.summer > 0) upd.balanceSummer = r.after.summer;
    await db.collection('users').doc(r.empId).set(upd, { merge: true });

    await db.collection('balanceLogs').add({
      empId: r.empId,
      type: 'deduct',
      changes: { annual: -(r.e.annual || 0), birth: -(r.e.birth || 0), summer: -(r.e.summer || 0) },
      meta: { via: 'github-actions', reason: 'settle', leaves: r.e.refs.length },
      byEmpId: null,
      byName: 'GitHub Actions',
      byUid: null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 같은 휴가증을 두 번 차감하지 않도록 표시한다.
    const batch = db.batch();
    r.e.refs.forEach((ref) => batch.update(ref, {
      deductedAt: admin.firestore.FieldValue.serverTimestamp(),
    }));
    await batch.commit();
    done++;
  }
  console.log(`  ${done}명 반영 완료`);
  console.log('');
  console.log('>>> 정산 완료. leavecheck 로 개별 확인할 수 있습니다.');
}

// ---------- leavecheck: 한 사람의 잔여·휴가증·변경 이력 대조 ----------
//
// "잔여가 안 맞는다" 문의를 받았을 때 쓴다. 세 곳을 나란히 놓아야 원인이 보인다.
//   users        지금 잔여
//   leaves       무엇을 언제 썼는지 · 처리됐는지 · 차감됐는지(deductedAt)
//   balanceLogs  잔여가 언제 왜 바뀌었는지
//
// EMP_ID 에 사번 또는 이름 아무거나 넣는다 — 숫자면 사번, 아니면 이름으로 찾는다.
// 로그가 공개라 이름은 가리고 사번만 찍는다.
async function actionLeaveCheck(db) {
  const raw = String(process.env.EMP_ID || '').trim();
  if (!raw) throw new Error('EMP_ID 가 필요합니다. (사번 또는 이름, 쉼표로 여럿)');

  // 쉼표로 여럿 — 마이너스로 떨어지는 사람들을 한 번에 훑을 때 쓴다.
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length > 1) {
    for (const one of list) {
      process.env.EMP_ID = one;
      await actionLeaveCheckOne(db, one);
      console.log('');
      console.log('─'.repeat(60));
    }
    process.env.EMP_ID = raw;
    return;
  }
  return actionLeaveCheckOne(db, list[0]);
}

async function actionLeaveCheckOne(db, q) {
  const wAll = await db.collection('workers').get();
  const byId = [];
  wAll.forEach((d) => {
    const v = d.data() || {};
    const id = String(v.employeeId || '').trim();
    const nm = String(v.name || '').trim();
    if (id === q || nm === q) byId.push({ id, nm, team: v.team || '-' });
  });

  if (!byId.length) {
    console.log(`※ 명단에서 찾지 못했습니다: ${/^\d+$/.test(q) ? q : '(이름)'}`);
    process.exitCode = 1;
    return;
  }
  if (byId.length > 1) {
    console.log('※ 같은 이름이 여럿입니다. 사번으로 다시 실행하세요.');
    byId.forEach((w) => console.log(`   ${w.id}  ${maskName(w.nm)} / ${w.team}`));
    process.exitCode = 1;
    return;
  }

  const { id: empId, nm, team } = byId[0];
  console.log(`===== 잔여 대조: ${empId} =====`);
  console.log(`대상   ${maskName(nm)} / ${team}`);

  // 1) 지금 잔여
  const uDoc = await db.collection('users').doc(empId).get();
  const u = uDoc.exists ? (uDoc.data() || {}) : {};
  console.log('');
  console.log('[현재 잔여]');
  console.log(`  연차 ${u.balanceAnnual ?? '-'}  ·  생휴 ${u.balanceBirth ?? '-'}`
    + `  ·  하기휴가 ${u.balanceSummer ?? '-'}`);

  // 2) 휴가증
  const lv = await db.collection('leaves').where('employeeId', '==', empId).get();
  console.log('');
  console.log(`[휴가증 ${lv.size}장]  처리=서무 취합됨 · 차감=잔여에서 빠짐`);
  const rows = [];
  lv.forEach((d) => {
    const v = d.data() || {};
    const items = Array.isArray(v.items) ? v.items : [];
    const kinds = items.map((it) => `${(it && it.type) || '?'} ${(it && it.count) || 1}개`).join(', ');
    rows.push({
      start: v.start || '?',
      end: v.end || '?',
      kinds: kinds || '(항목없음)',
      processed: v.processed === true,
      deducted: !!v.deductedAt,
    });
  });
  rows.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  rows.forEach((r) => {
    console.log(`  ${r.start} ~ ${r.end}  ${r.kinds.padEnd(22, ' ')}`
      + `  처리 ${r.processed ? 'O' : 'X'}  차감 ${r.deducted ? 'O' : 'X'}`);
  });
  const notDeducted = rows.filter((r) => r.processed && !r.deducted);
  if (notDeducted.length) {
    console.log('');
    console.log(`  ⚠ 처리는 됐는데 차감이 안 된 휴가증 ${notDeducted.length}장`);
  }

  // 3) 잔여 변경 이력
  const bl = await db.collection('balanceLogs').where('empId', '==', empId).get();
  const logs = [];
  bl.forEach((d) => {
    const v = d.data() || {};
    const at = v.at && typeof v.at.toDate === 'function' ? v.at.toDate() : null;
    logs.push({ at, type: v.type || '?', changes: v.changes || {}, by: v.byName || '' });
  });
  logs.sort((a, b) => (a.at && b.at ? a.at - b.at : 0));
  console.log('');
  console.log(`[잔여 변경 이력 ${logs.length}건]`);
  logs.slice(-15).forEach((l) => {
    const c = l.changes;
    const parts = ['annual', 'birth', 'summer']
      .filter((k) => c[k] !== undefined && c[k] !== 0)
      .map((k) => `${k} ${c[k] > 0 ? '+' : ''}${c[k]}`);
    const when = l.at
      ? new Date(l.at.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
      : '(날짜없음)';
    console.log(`  ${when}  ${String(l.type).padEnd(7, ' ')} ${parts.join(' · ') || '-'}`
      + (l.by ? `  (${maskName(l.by)})` : ''));
  });
  if (!logs.some((l) => l.type === 'deduct')) {
    console.log('');
    console.log('  ⚠ deduct 기록이 없습니다 — 이 사람은 자동 차감이 한 번도 안 됐습니다.');
  }
}

// ---------- purge: 만료된 휴가증 직접 삭제 ----------
//
// Firestore TTL 정책은 결제 계정이 붙은 프로젝트에서만 만들 수 있다
// (2026-08-25 확인 — "Project has billing disabled"). 이 프로젝트는 Spark
// 무료이고, 사내 배포로 옮길 예정이라 결제 계정을 붙일 이유가 없다.
//
// TTL 이 하려던 일을 여기서 직접 한다. Admin SDK 는 데이터 삭제 권한이 있다
// — 아까 막힌 것은 필드 설정 변경이었지 데이터가 아니다.
//
// 스케줄 워크플로에서 돌 때는 CONFIRM 없이 실행하고 PURGE_AUTO=1 을 준다.
async function actionPurge(db) {
  const auto = String(process.env.PURGE_AUTO || '').trim() === '1';
  const confirmed = auto || String(process.env.CONFIRM || '').trim() === 'OK';

  console.log(`===== 만료된 휴가증 삭제${confirmed ? '' : ' (미리보기)'} =====`);

  const now = new Date();
  const snap = await db.collection('leaves').get();
  const expired = [];
  let noField = 0;
  snap.forEach((d) => {
    const v = (d.data() || {}).expiresAt;
    const t = v && typeof v.toDate === 'function' ? v.toDate() : null;
    if (!t) { noField++; return; }
    if (t <= now) expired.push(d.ref);
  });

  console.log(`휴가증 ${snap.size}장 · 만료 ${expired.length}장 · 남을 것 ${snap.size - expired.length}장`
    + (noField ? ` · expiresAt 없는 문서 ${noField}장(건너뜀)` : ''));

  if (!expired.length) {
    console.log('>>> 지울 것이 없습니다.');
    return;
  }
  if (!confirmed) {
    console.log('');
    console.log('>>> 미리보기입니다. 지우려면 confirm 입력란에 OK 를 넣고 다시 실행하세요.');
    console.log('    되돌릴 수 없습니다.');
    return;
  }

  // batch 는 한 번에 500건까지
  for (let i = 0; i < expired.length; i += 400) {
    const chunk = expired.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
    console.log(`  삭제 ${Math.min(i + chunk.length, expired.length)}/${expired.length}`);
  }

  const left = await db.collection('leaves').get();
  console.log('');
  console.log(`>>> ${expired.length}장 삭제 완료. 남은 휴가증 ${left.size}장.`);
}

// ---------- ttl: 휴가증 자동 삭제 정책 ----------
//
// script.js 가 expiresAt 에 30일 뒤를 넣지만, 필드만으로는 지워지지 않는다.
// Firestore 에 "이 필드를 TTL 로 쓴다" 고 등록해야 한다.
//
// Console 에서 켜도 되지만 손으로 하면 켜졌는지 확인할 방법이 없어 여기 둔다.
// 기본은 조회. CONFIRM=ON 으로 켜고, OFF 로 끈다.
//
// ⚠️ 켜면 이미 만료된 문서가 지워진다. 되돌릴 수 없다.
async function actionTtl(db) {
  const { JWT } = require('google-auth-library');
  const want = String(process.env.CONFIRM || '').trim();  // ON | OFF | (빈값=조회)
  const sa = loadServiceAccount();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const field = `projects/${sa.project_id}/databases/(default)/collectionGroups/leaves/fields/expiresAt`;
  const url = `https://firestore.googleapis.com/v1/${field}`;

  console.log('===== 휴가증 자동 삭제(TTL) =====');
  console.log('컬렉션 그룹  leaves  ·  필드  expiresAt');

  const read = async () => {
    const r = await client.request({ url });
    return (r.data && r.data.ttlConfig) || null;
  };

  let cfg = await read();
  console.log(`현재 상태    ${cfg ? `켜짐 (state=${cfg.state || '-'})` : '꺼짐'}`);

  // 지금 지워질 문서가 몇 장인지 먼저 센다 — 켜기 전에 알아야 한다.
  const now = new Date();
  const lv = await db.collection('leaves').get();
  let expired = 0;
  lv.forEach((d) => {
    const v = (d.data() || {}).expiresAt;
    const t = v && typeof v.toDate === 'function' ? v.toDate() : null;
    if (t && t <= now) expired++;
  });
  console.log(`휴가증       ${lv.size}장 · 이미 만료된 것 ${expired}장`);

  if (want !== 'ON' && want !== 'OFF') {
    console.log('');
    console.log('>>> 조회만 했습니다.');
    console.log(`    켜려면 confirm=ON  (만료된 ${expired}장이 지워집니다. 되돌릴 수 없습니다)`);
    console.log('    끄려면 confirm=OFF');
    return;
  }

  // 읽기는 되는데 쓰기는 IAM 에서 막힌다. Firebase Admin SDK 서비스 계정은
  // 데이터는 다 만질 수 있어도 필드 설정(색인·TTL) 변경 권한은 없다.
  // 권한을 더 주기보다 Console 에서 켜는 편이 낫다 — 조회는 여기서 되므로
  // 켜졌는지 확인하는 수단은 남는다.
  try {
    await client.request({
      url: `${url}?updateMask=ttlConfig`,
      method: 'PATCH',
      data: want === 'ON' ? { ttlConfig: {} } : {},
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/permission/i.test(msg)) throw e;
    console.log('');
    console.log('※ 서비스 계정에 필드 설정 변경 권한이 없습니다. Console 에서 켜세요.');
    console.log('');
    console.log('   Google Cloud Console → Firestore → 유지 시간(TTL) → 정책 만들기');
    console.log('     컬렉션 그룹     leaves');
    console.log('     타임스탬프 필드  expiresAt');
    console.log('');
    console.log('   켠 뒤 이 액션을 confirm 없이 다시 돌리면 켜졌는지 확인됩니다.');
    process.exitCode = 1;
    return;
  }
  cfg = await read();
  console.log('');
  console.log(`>>> ${want === 'ON' ? '켰습니다' : '껐습니다'}. 현재 ${cfg ? `켜짐 (state=${cfg.state || '-'})` : '꺼짐'}.`);
  if (want === 'ON') {
    console.log('    반영에 시간이 걸립니다(보통 24시간 안). 다음 날 stats 로 남은 장수를 확인하세요.');
  }
}

// ---------- fixleaveids: 사번 없는 휴가증에 사번 채우기 ----------
//
// leaves 규칙을 employeeId 기준으로 조이기 전에 돌려야 한다. employeeId 가 빈
// 문서는 소유자도 읽지 못하게 되기 때문이다.
//
// 빈 값이 생기는 이유: script.js 가 명단을 "이름" 으로 찾아 채운다. 명단에
// 없거나 동명이인이면 못 찾는다. 코드 쪽도 로그인 사번을 쓰도록 함께 고친다.
//
// 기본은 미리보기. CONFIRM=OK 를 줘야 실제로 쓴다.
async function actionFixLeaveIds(db) {
  const confirmed = String(process.env.CONFIRM || '').trim() === 'OK';
  console.log(`===== 휴가증 사번 채우기${confirmed ? '' : ' (미리보기)'} =====`);

  const [wSnap, lvSnap] = await Promise.all([
    db.collection('workers').get(),
    db.collection('leaves').get(),
  ]);

  // 이름 → 사번. 동명이인은 아예 후보에서 뺀다 — 엉뚱한 사람 것이 되면
  // 그 사람이 남의 휴가증을 읽게 된다. 못 채우는 편이 낫다.
  const byName = new Map();
  const dupNames = new Set();
  wSnap.forEach((d) => {
    const v = d.data() || {};
    const n = String(v.name || '').trim();
    const id = String(v.employeeId || '').trim();
    if (!n || !id) return;
    if (byName.has(n)) dupNames.add(n);
    else byName.set(n, id);
  });
  dupNames.forEach((n) => byName.delete(n));

  const targets = [];
  lvSnap.forEach((d) => {
    const v = d.data() || {};
    if (String(v.employeeId || '').trim()) return;
    targets.push({ ref: d.ref, id: d.id, name: String(v.name || '').trim(),
                   start: v.start || '?', end: v.end || '?' });
  });

  console.log(`  휴가증 ${lvSnap.size}장 중 사번 없는 문서 ${targets.length}장`);
  if (!targets.length) {
    console.log('>>> 채울 것이 없습니다.');
    return;
  }

  let fill = 0;
  const skipped = [];
  for (const t of targets) {
    const id = byName.get(t.name);
    if (!id) {
      // 실명은 찍지 않는다 — 공개 로그다. 문서 ID 로 찾아갈 수 있다.
      skipped.push(`${t.id} (${t.start}~${t.end}) — ${dupNames.has(t.name) ? '동명이인' : '명단에 없는 이름'}`);
      continue;
    }
    console.log(`  ${t.id}  ${t.start}~${t.end}  → ${id}`);
    if (confirmed) await t.ref.update({ employeeId: id });
    fill++;
  }

  if (skipped.length) {
    console.log('');
    console.log('[건너뜀] — 손으로 확인해야 합니다');
    skipped.forEach((s) => console.log('  ' + s));
  }

  console.log('');
  if (confirmed) {
    console.log(`>>> ${fill}장에 사번을 채웠습니다. 건너뛴 것 ${skipped.length}장.`);
  } else {
    console.log(`>>> 미리보기입니다. 채우려면 confirm 입력란에 OK 를 넣고 다시 실행하세요.`);
    console.log(`    채울 수 있는 것 ${fill}장 · 건너뛸 것 ${skipped.length}장`);
  }
}

// 휴가증 이용 실적 집계 — 제안 보고의 효과금액 산출에 쓴다.
//
// **읽기 전용이고 이름·사번은 찍지 않는다.** 개인정보 시스템이라 집계 숫자만 낸다.
//
// 두 곳을 함께 센다.
//   leaves      휴가증 원본. expiresAt(30일) 이 걸려 있어 TTL 정책이 켜져 있으면
//               오래된 건이 지워진다 — 실제 남은 기간을 함께 찍어 확인한다.
//   balanceLogs 차감 이력. TTL 이 없어 오픈 이후가 다 남아 있다.
//               type='deduct' 한 건이 휴가증 한 건이다.
async function actionStats(db) {
  const ym = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '(날짜없음)');
  const toDate = (v) => {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    if (v instanceof Date) return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v);
    return null;
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const table = (m) => [...m.entries()].sort().map(([k, v]) => `    ${k}  ${String(v).padStart(5)}`).join('\n');

  console.log('===== 휴가증 이용 실적 =====');
  console.log('(집계 전용 — 이름·사번은 출력하지 않습니다)');

  // ── leaves ────────────────────────────────────────────────
  // 구분·개수는 items[] 안에 있다. 휴가증 한 장에 여러 줄이 들어갈 수 있다.
  const lv = await db.collection('leaves').get();
  const byMonth = new Map(), byType = new Map();
  let processed = 0, days = 0, items = 0, minD = null, maxD = null;
  let noEmpId = 0, noEmpIdRecent = 0;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const people = new Set();
  lv.forEach((doc) => {
    const d = doc.data() || {};
    const created = toDate(d.serverCreatedAt) || toDate(d.createdAt) || toDate(d.start);
    bump(byMonth, ym(created));
    (Array.isArray(d.items) ? d.items : []).forEach((it) => {
      items++;
      bump(byType, (it && it.type) || '(구분없음)');
    });
    if (d.processed === true) processed++;
    days += Number(d.days) || 0;
    // 사번으로 센다. submittedBy 는 익명 인증 시절 세션마다 달라져 인원수가 아니다.
    if (d.employeeId) people.add(String(d.employeeId).trim());
    else {
      // employeeId 는 명단을 "이름" 으로 찾아 채운다(script.js). 명단에 없거나
      // 동명이인이면 빈 값이 된다. leaves 규칙을 employeeId 기준으로 조이면
      // 이런 문서는 소유자도 못 읽는다 — 조이기 전에 몇 건인지 알아야 한다.
      noEmpId++;
      if (created && created >= thirtyDaysAgo) noEmpIdRecent++;
    }
    if (created) {
      if (!minD || created < minD) minD = created;
      if (!maxD || created > maxD) maxD = created;
    }
  });
  console.log(`\n[leaves] 휴가증 ${lv.size}장 · 항목 ${items}줄 · 처리완료 ${processed}장`);
  console.log(`  작성 인원 ${people.size}명 (사번 기준) · 휴가 일수 합계 ${days}일`);
  console.log(`  사번 없는 문서 ${noEmpId}장 (최근 30일 내 ${noEmpIdRecent}장)`
    + (noEmpId ? '  ← leaves 규칙을 사번 기준으로 조이기 전에 확인' : ''));
  if (minD) console.log(`  남아 있는 기간: ${minD.toISOString().slice(0, 10)} ~ ${maxD.toISOString().slice(0, 10)}`);
  console.log('  월별 (휴가증 장 수)');
  console.log(table(byMonth));
  console.log('  구분별 (항목 줄 수)');
  console.log(table(byType));

  // 월평균은 온전한 달만 쓴다 — 첫 달·마지막 달은 잘려 있다
  const mo = [...byMonth.entries()].sort().filter(([k]) => k !== '(날짜없음)');
  if (mo.length >= 3) {
    const mid = mo.slice(1, -1);
    const sum = mid.reduce((s, [, v]) => s + v, 0);
    console.log(`\n  ▶ 월평균 ${(sum / mid.length).toFixed(1)}장/월 `
      + `(${mid[0][0]} ~ ${mid[mid.length - 1][0]} · 온전한 달만)`);
  }

  // ── balanceLogs ───────────────────────────────────────────
  const bl = await db.collection('balanceLogs').get();
  const logMonth = new Map(), logType = new Map(), deductMonth = new Map();
  bl.forEach((doc) => {
    const d = doc.data() || {};
    const at = toDate(d.at);
    bump(logMonth, ym(at));
    bump(logType, d.type || '(없음)');
    if (d.type === 'deduct') bump(deductMonth, ym(at));
  });
  // ── 익명 계정 ─────────────────────────────────────────────
  // 2026-08-06 규칙 배포로 익명은 데이터를 못 읽는다. 다만 Console 의 익명
  // 제공자가 아직 켜져 있어 계정 자체는 계속 만들어질 수 있다. 몇 개나
  // 쌓였는지 보이면 끄는 판단이 쉬워진다.
  const all = await listAuthUsers();
  const anon = all.filter((u) => !u.email && (!u.providerData || !u.providerData.length));
  const real = all.length - anon.length;
  console.log(`\n[Auth 계정] 총 ${all.length}개 · 사번 계정 ${real}개 · 익명 ${anon.length}개`);
  if (anon.length) {
    const byMonth = new Map();
    let last = null;
    anon.forEach((u) => {
      const c = u.metadata && u.metadata.creationTime ? new Date(u.metadata.creationTime) : null;
      bump(byMonth, ym(c));
      if (c && (!last || c > last)) last = c;
    });
    console.log('  생성 월별');
    console.log(table(byMonth));
    if (last) {
      console.log(`  마지막 생성: ${last.toISOString().slice(0, 10)}`);
      const days = Math.floor((Date.now() - last.getTime()) / 86400000);
      console.log(days >= 7
        ? `  → ${days}일째 새로 안 생겼습니다. 익명 제공자를 꺼도 영향 없습니다.`
        : `  → ${days}일 전에도 만들어졌습니다. 옛 화면을 열어 둔 사용자가 있을 수 있습니다.`);
    }
  } else {
    console.log('  → 익명 계정이 없습니다.');
  }

  console.log(`\n[balanceLogs] 총 ${bl.size}건 (TTL 없음)`);
  console.log('  기록 유형별');
  console.log(table(logType));
  if (deductMonth.size) {
    console.log('  월별 차감(deduct)');
    console.log(table(deductMonth));
  } else {
    console.log('  ※ deduct 기록 없음 — 잔여 차감이 수기(manual)로 이뤄지고 있습니다.');
    console.log('     따라서 건수 근거는 leaves 쪽을 씁니다.');
  }
}

// ---------- anonoff: 익명 로그인 제공자 끄기 ----------
// 2026-08-06 규칙 배포로 익명은 데이터를 못 읽지만, 제공자가 켜져 있으면
// 계정은 계속 만들어진다. 쓰지 않는 인증 경로라 닫는다. Console 설정이지만
// Identity Toolkit Admin API 로 같은 값을 바꿀 수 있다.
//
// 되돌리려면 Console 에서 다시 켜거나 CONFIRM=ANONON 으로 실행한다.
async function actionAnonOff() {
  const { JWT } = require('google-auth-library');
  const sa = loadServiceAccount();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${sa.project_id}/config`;

  const cur = await client.request({ url });
  const now = !!(((cur.data || {}).signIn || {}).anonymous || {}).enabled;
  console.log('===== 익명 로그인 제공자 =====');
  console.log(`현재 상태  ${now ? '켜짐' : '꺼짐'}`);

  const confirm = String(process.env.CONFIRM || '').trim();
  const want = confirm === 'ANONON' ? true : false;

  if (now === want) {
    console.log(`이미 ${want ? '켜져' : '꺼져'} 있습니다 — 바꿀 것이 없습니다.`);
    return;
  }
  if (confirm !== 'ANONOFF' && confirm !== 'ANONON') {
    console.log('');
    console.log(`[모의 실행] 익명 로그인을 ${now ? '끕니다' : '켭니다'}.`);
    console.log('실제로 바꾸려면 CONFIRM=ANONOFF (되돌리려면 CONFIRM=ANONON) 로 다시 실행하세요.');
    return;
  }

  await client.request({
    url: `${url}?updateMask=signIn.anonymous.enabled`,
    method: 'PATCH',
    data: { signIn: { anonymous: { enabled: want } } },
  });

  const after = await client.request({ url });
  const val = !!(((after.data || {}).signIn || {}).anonymous || {}).enabled;
  console.log('');
  console.log(`바꾼 뒤 상태  ${val ? '켜짐' : '꺼짐'}`);
  console.log(val === want ? '>>> 반영됐습니다.' : '>>> 반영되지 않았습니다 — 권한을 확인하세요.');
}

async function main() {
  const action = String(process.env.ACTION || 'status').trim();
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const db = admin.firestore();

  if (action === 'status') return actionStatus(db);
  if (action === 'inspect') return actionInspect(db);
  if (action === 'rules') return actionRules();
  if (action === 'cleanup') return actionCleanup(db);
  if (action === 'claims') return actionClaims();
  if (action === 'premigrate') return actionPremigrate(db);
  if (action === 'syncprofile') return actionSyncProfile(db);
  if (action === 'deployrules') return actionDeployRules();
  if (action === 'testrules') return actionTestRules();
  if (action === 'testaccount') return actionTestAccount(db);
  if (action === 'reset') return actionReset(db);
  if (action === 'remove') return actionRemove(db);
  if (action === 'stats') return actionStats(db);
  if (action === 'anonoff') return actionAnonOff();
  if (action === 'fixleaveids') return actionFixLeaveIds(db);
  if (action === 'ttl') return actionTtl(db);
  if (action === 'purge') return actionPurge(db);
  if (action === 'leavecheck') return actionLeaveCheck(db);
  if (action === 'settle') return actionSettle(db);
  throw new Error(`알 수 없는 ACTION: ${action} (status | inspect | rules | deployrules `
    + `| testrules | cleanup | claims | premigrate | syncprofile | stats | anonoff `
    + `| fixleaveids | reset | remove)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
