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
//   ACTION=cleanup                       node auth-admin.js  이관 잔여 필드 정리 (미리보기)
//   ACTION=cleanup CONFIRM=OK                                실제 정리 실행
//   ACTION=claims                        node auth-admin.js  관리자·서무 역할 클레임 부여
//   ACTION=premigrate EMP_ID=12224xxxx   node auth-admin.js  로그인 못 하는 사람 서버 이관
//   ACTION=premigrate EMP_ID=... CONFIRM=RESETPW             비밀번호 바꿔 쓰던 사람까지
//   ACTION=syncprofile                   node auth-admin.js  users 에 이름·팀·휴대폰 채우기
//   ACTION=syncprofile CONFIRM=OK                            실제 쓰기 (명단 수정 후 필수)
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
    console.log(`  ${t.empId}  ${t.want.name} / ${t.want.team || '-'}` +
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
  console.log(`  이름: ${name} / 팀: ${w.team || '-'} / 부서: ${w.department || '-'}`);

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
  console.log(`>>> ${name}(${empId}) 님 이관 완료. 사번 + ${DEFAULT_PASSWORD} 로 로그인됩니다.`);
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
  if (action === 'rules') return actionRules();
  if (action === 'cleanup') return actionCleanup(db);
  if (action === 'claims') return actionClaims();
  if (action === 'premigrate') return actionPremigrate(db);
  if (action === 'syncprofile') return actionSyncProfile(db);
  if (action === 'deployrules') return actionDeployRules();
  if (action === 'reset') return actionReset(db);
  if (action === 'remove') return actionRemove(db);
  throw new Error(`알 수 없는 ACTION: ${action} (status | inspect | rules | deployrules `
    + `| cleanup | claims | premigrate | syncprofile | reset | remove)`);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
