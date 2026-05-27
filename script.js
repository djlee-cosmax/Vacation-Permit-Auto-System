// ============ 휴가증 자동 반영 프로그램 ============

// ----- 로그인 / 세션 -----
var DEFAULT_PASSWORD = '1234';
// 보안 질문 옵션 (비밀번호 찾기용)
var SECURITY_QUESTIONS = [
  '어머니의 성함은?',
  '가장 좋아하는 음식은?',
  '처음 다닌 초등학교 이름은?',
  '본인의 별명은?',
  '좋아하는 색상은?',
  '좋아하는 운동·취미는?',
  '가장 기억에 남는 여행지는?',
  '첫 애완동물의 이름은?'
];
// 관리자 / 서무 사번 (workers.json 외 별도 권한 부여)
var STAFF_ROLES = {
  '122210202': { role: 'admin', name: '이동준' },
  '122240096': { role: 'leader', name: '김가영' }
};

function getSession() {
  try {
    var raw = localStorage.getItem('p5_session');
    if (!raw) return null;
    var s = JSON.parse(raw);
    if (s.expires && new Date(s.expires) > new Date()) return s;
    localStorage.removeItem('p5_session');
    return null;
  } catch (e) { return null; }
}

// 세션 자동 갱신 — 활동 시마다 만료 시간을 30일로 리셋
function touchSession() {
  try {
    var raw = localStorage.getItem('p5_session');
    if (!raw) return;
    var s = JSON.parse(raw);
    if (!s.expires || new Date(s.expires) <= new Date()) return; // 이미 만료
    s.expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem('p5_session', JSON.stringify(s));
  } catch (e) {}
}

function login() {
  var empId = document.getElementById('loginEmpId').value.trim();
  var pw = document.getElementById('loginPw').value;
  if (!empId) { showToast('사번을 입력해 주세요.', 'error'); return; }
  if (!pw) { showToast('비밀번호를 입력해 주세요.', 'error'); return; }

  // 1) 관리자/서무 사번 우선 확인
  var staff = STAFF_ROLES[empId];
  var name, role, team, worker;
  if (staff) {
    name = staff.name;
    role = staff.role;
    team = '';
  } else {
    // 2) 작업자 명단에서 매칭
    worker = workers.find(function(w) { return String(w.employeeId || '').trim() === empId; });
    if (!worker) { showToast('등록되지 않은 사번입니다.', 'error'); return; }
    name = worker.name;
    role = 'worker';
    team = worker.team || '';
  }

  // 3) Firestore users/{empId} 문서에서 비밀번호 조회 (없으면 기본 1234)
  // Firestore가 준비되지 않은 경우 기본 PW로 폴백
  function finalizeLogin(storedPw) {
    if (pw !== storedPw) { showToast('비밀번호가 일치하지 않습니다.', 'error'); return; }
    var isInitialPw = (storedPw === DEFAULT_PASSWORD);
    doLoginSuccess(empId, name, role, team, worker, isInitialPw);
  }
  if (FB_DB) {
    FB_DB.collection('users').doc(empId).get()
      .then(function(doc) {
        var storedPw = (doc.exists && doc.data().password) ? doc.data().password : DEFAULT_PASSWORD;
        finalizeLogin(storedPw);
      })
      .catch(function() {
        finalizeLogin(DEFAULT_PASSWORD);
      });
  } else {
    finalizeLogin(DEFAULT_PASSWORD);
  }
}

function doLoginSuccess(empId, name, role, team, worker, isInitialPw) {

  // 권한 localStorage 설정 (모바일에서는 권한 자체가 비활성되므로 PC에서만 효과 있음)
  if (role === 'admin') {
    localStorage.setItem('p5_admin', '1');
    localStorage.setItem('p5_leader', '1');
  } else if (role === 'leader') {
    localStorage.removeItem('p5_admin');
    localStorage.setItem('p5_leader', '1');
  } else {
    localStorage.removeItem('p5_admin');
    localStorage.removeItem('p5_leader');
  }

  // PC 환경이면 권한 클래스 즉시 적용
  if (window.innerWidth > 600) {
    if (role === 'admin') document.documentElement.classList.add('admin-mode');
    else document.documentElement.classList.remove('admin-mode');
    if (role === 'admin' || role === 'leader') document.documentElement.classList.add('leader-mode');
    else document.documentElement.classList.remove('leader-mode');
  }

  // 아이디 저장 체크 상태에 따라 사번 저장 / 제거
  var rememberEl = document.getElementById('loginRemember');
  if (rememberEl && rememberEl.checked) {
    localStorage.setItem('p5_remembered_id', empId);
  } else {
    localStorage.removeItem('p5_remembered_id');
  }

  // 30일 세션
  var expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  var phone = worker ? (worker.phone || '') : '';
  var session = { empId: empId, name: name, team: team, role: role, phone: phone, expires: expires.toISOString() };
  localStorage.setItem('p5_session', JSON.stringify(session));
  document.documentElement.classList.add('authenticated');
  // 기존 role 클래스 제거 후 새 role 추가 (재로그인 대응)
  ['role-admin', 'role-leader', 'role-worker'].forEach(function(c) {
    document.documentElement.classList.remove(c);
  });
  document.documentElement.classList.add('role-' + role);
  showToast(name + '님 환영합니다.', 'success');

  // 일반 작업자만: 본인 식별자 자동 채움 (휴가증 작성 시 phone4 자동 사용)
  if (role === 'worker' && worker && !getMyInfo() && worker.phone) {
    var phone4 = getPhone4(worker.phone);
    if (phone4) setMyInfo(worker.name, phone4);
  }
  // 작성 폼의 이름·연락처 자동 채움 + readonly
  applyWorkerProfileToForm();
  refreshUserNameDisplay();

  // 초기 비밀번호(1234) 사용 중이면 변경 권장 안내 + 모달 자동 오픈
  if (isInitialPw) {
    setTimeout(function() {
      alert('보안을 위해 비밀번호를 변경해 주세요.\n(초기 비밀번호 1234 사용 중)');
      openChangePwModal();
    }, 600);
  } else if (FB_DB) {
    // 비밀번호 변경했지만 보안 질문 미등록이면 등록 안내
    FB_DB.collection('users').doc(empId).get().then(function(doc) {
      if (doc.exists && doc.data().password && !doc.data().securityQuestion) {
        setTimeout(function() {
          alert('보안 질문이 등록되지 않았습니다.\n비밀번호 찾기를 위해 등록해 주세요.');
          openChangePwModal();
        }, 600);
      }
    }).catch(function() {});
  }
}

// 비밀번호 변경 모달
function openChangePwModal() {
  if (!getSession()) { showToast('먼저 로그인해 주세요.', 'error'); return; }
  document.getElementById('currentPw').value = '';
  document.getElementById('newPw').value = '';
  document.getElementById('newPwConfirm').value = '';
  document.getElementById('securityAnswer').value = '';

  // 보안 질문 드롭다운 채우기
  var sel = document.getElementById('securityQuestion');
  sel.innerHTML = '<option value="">선택하지 않음</option>' +
    SECURITY_QUESTIONS.map(function(q) { return '<option value="' + escapeHtml(q) + '">' + escapeHtml(q) + '</option>'; }).join('');

  // 기존 보안 질문 (있으면 선택)
  var session = getSession();
  if (FB_DB && session) {
    FB_DB.collection('users').doc(session.empId).get()
      .then(function(doc) {
        if (doc.exists && doc.data().securityQuestion) {
          sel.value = doc.data().securityQuestion;
        }
      })
      .catch(function() {});
  }

  document.getElementById('changePwModal').style.display = 'flex';
  setTimeout(function() { document.getElementById('currentPw').focus(); }, 50);
}

function closeChangePwModal() {
  document.getElementById('changePwModal').style.display = 'none';
}

function changePassword() {
  var session = getSession();
  if (!session) { showToast('로그인 정보가 없습니다.', 'error'); return; }
  var empId = session.empId;
  var cur = document.getElementById('currentPw').value;
  var newPw = document.getElementById('newPw').value;
  var confirmPw = document.getElementById('newPwConfirm').value;

  if (!cur) { showToast('현재 비밀번호를 입력해 주세요.', 'error'); return; }
  if (!newPw) { showToast('새 비밀번호를 입력해 주세요.', 'error'); return; }
  if (!/^[0-9]+$/.test(newPw)) { showToast('새 비밀번호는 숫자만 입력 가능합니다.', 'error'); return; }
  if (newPw.length < 6 || newPw.length > 10) { showToast('새 비밀번호는 숫자 6~10자리여야 합니다.', 'error'); return; }
  if (newPw !== confirmPw) { showToast('새 비밀번호 확인이 일치하지 않습니다.', 'error'); return; }
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }

  // 현재 PW 확인 → 새 PW 저장
  FB_DB.collection('users').doc(empId).get()
    .then(function(doc) {
      var storedPw = (doc.exists && doc.data().password) ? doc.data().password : DEFAULT_PASSWORD;
      if (cur !== storedPw) {
        showToast('현재 비밀번호가 일치하지 않습니다.', 'error');
        throw new Error('PW_MISMATCH');
      }
      var question = document.getElementById('securityQuestion').value;
      var answer = document.getElementById('securityAnswer').value.trim();
      if (!question || !answer) {
        showToast('보안 질문과 답변을 입력해 주세요.\n(비밀번호 찾기에 필요합니다)', 'error');
        throw new Error('SECURITY_QUESTION_REQUIRED');
      }
      var dataToSave = {
        password: newPw,
        securityQuestion: question,
        securityAnswer: answer,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      return FB_DB.collection('users').doc(empId).set(dataToSave, { merge: true });
    })
    .then(function() {
      closeChangePwModal();
      showToast('비밀번호가 변경되었습니다.', 'success');
    })
    .catch(function(err) {
      if (err && (err.message === 'PW_MISMATCH' || err.message === 'SECURITY_QUESTION_REQUIRED')) return;
      console.error('비밀번호 변경 실패:', err);
      showToast('변경 실패: ' + (err.message || err), 'error');
    });
}

// 비밀번호 찾기 — 사번 입력 → 보안 질문 표시 → 답변 확인 → 새 PW 설정
var forgotEmpIdCache = '';

function openForgotPwModal() {
  forgotEmpIdCache = '';
  document.getElementById('forgotEmpId').value = '';
  document.getElementById('forgotAnswer').value = '';
  document.getElementById('forgotNewPw').value = '';
  document.getElementById('forgotNewPwConfirm').value = '';
  document.getElementById('forgotPwStep1').style.display = '';
  document.getElementById('forgotPwStep2').style.display = 'none';
  document.getElementById('forgotPwModal').style.display = 'flex';
  setTimeout(function() { document.getElementById('forgotEmpId').focus(); }, 50);
}

function closeForgotPwModal() {
  document.getElementById('forgotPwModal').style.display = 'none';
}

function forgotPwLookup() {
  var empId = document.getElementById('forgotEmpId').value.trim();
  if (!empId) { showToast('사번을 입력해 주세요.', 'error'); return; }
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }

  FB_DB.collection('users').doc(empId).get()
    .then(function(doc) {
      if (!doc.exists || !doc.data().securityQuestion || !doc.data().securityAnswer) {
        showToast('등록된 보안 질문이 없습니다. 관리자(이동준)에게 비밀번호 초기화를 요청해 주세요.', 'error');
        return;
      }
      forgotEmpIdCache = empId;
      document.getElementById('forgotQuestion').textContent = doc.data().securityQuestion;
      document.getElementById('forgotPwStep1').style.display = 'none';
      document.getElementById('forgotPwStep2').style.display = '';
      setTimeout(function() { document.getElementById('forgotAnswer').focus(); }, 50);
    })
    .catch(function(err) {
      console.error(err);
      showToast('조회 실패: ' + (err.message || err), 'error');
    });
}

function forgotPwReset() {
  var empId = forgotEmpIdCache;
  if (!empId) return;
  var answer = document.getElementById('forgotAnswer').value.trim();
  var newPw = document.getElementById('forgotNewPw').value;
  var confirmPw = document.getElementById('forgotNewPwConfirm').value;

  if (!answer) { showToast('답변을 입력해 주세요.', 'error'); return; }
  if (!newPw) { showToast('새 비밀번호를 입력해 주세요.', 'error'); return; }
  if (!/^[0-9]+$/.test(newPw)) { showToast('새 비밀번호는 숫자만 입력 가능합니다.', 'error'); return; }
  if (newPw.length < 6 || newPw.length > 10) { showToast('새 비밀번호는 숫자 6~10자리여야 합니다.', 'error'); return; }
  if (newPw !== confirmPw) { showToast('새 비밀번호 확인이 일치하지 않습니다.', 'error'); return; }

  FB_DB.collection('users').doc(empId).get()
    .then(function(doc) {
      var storedAnswer = doc.exists ? (doc.data().securityAnswer || '') : '';
      if (answer !== storedAnswer) {
        showToast('답변이 일치하지 않습니다.', 'error');
        throw new Error('ANSWER_MISMATCH');
      }
      var storedPw = (doc.exists && doc.data().password) ? doc.data().password : DEFAULT_PASSWORD;
      if (newPw === storedPw) {
        showToast('새 비밀번호가 기존 비밀번호와 동일합니다.\n다른 비밀번호를 입력해 주세요.', 'error');
        throw new Error('SAME_PW');
      }
      return FB_DB.collection('users').doc(empId).set({
        password: newPw,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    })
    .then(function() {
      closeForgotPwModal();
      // 로그인 화면 사번 자동 채움
      var loginEmp = document.getElementById('loginEmpId');
      if (loginEmp) loginEmp.value = empId;
      showToast('비밀번호가 재설정되었습니다. 새 비밀번호로 로그인해 주세요.', 'success');
    })
    .catch(function(err) {
      if (err && (err.message === 'ANSWER_MISMATCH' || err.message === 'SAME_PW')) return;
      console.error('비밀번호 재설정 실패:', err);
      showToast('재설정 실패: ' + (err.message || err), 'error');
    });
}

// 상단바 우측에 로그인한 사용자 이름 표시
function refreshUserNameDisplay() {
  var el = document.getElementById('userNameDisplay');
  if (!el) return;
  var session = getSession();
  if (session && session.name) {
    el.textContent = session.name + '님';
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// 작업자 로그인 시 휴가증 작성 폼의 이름·연락처를 자동 채우고 readonly 처리
function applyWorkerProfileToForm() {
  var nameInput = document.getElementById('leaveName');
  var phoneInput = document.getElementById('leavePhone');
  if (!nameInput || !phoneInput) return;
  var session = getSession();
  if (session && session.role === 'worker') {
    if (session.name) nameInput.value = session.name;
    nameInput.readOnly = true;
    nameInput.classList.add('locked-input');
    if (session.phone) phoneInput.value = session.phone;
    phoneInput.readOnly = true;
    phoneInput.classList.add('locked-input');
    // 자동완성 드롭다운 숨김
    var sg = document.getElementById('nameSuggestions');
    if (sg) sg.style.display = 'none';
  } else {
    nameInput.readOnly = false;
    nameInput.classList.remove('locked-input');
    phoneInput.readOnly = false;
    phoneInput.classList.remove('locked-input');
  }
}

function logout() {
  if (!confirm('로그아웃하시겠습니까?')) return;
  localStorage.removeItem('p5_session');
  localStorage.removeItem('p5_admin');
  localStorage.removeItem('p5_leader');
  document.documentElement.classList.remove('authenticated');
  document.documentElement.classList.remove('admin-mode');
  document.documentElement.classList.remove('leader-mode');
  ['role-admin', 'role-leader', 'role-worker'].forEach(function(c) {
    document.documentElement.classList.remove(c);
  });
  // 사번은 "아이디 저장"에 따라 유지 (체크박스 상태에 맞춰 복원)
  var rememberedId = localStorage.getItem('p5_remembered_id');
  document.getElementById('loginEmpId').value = rememberedId || '';
  document.getElementById('loginRemember').checked = !!rememberedId;
  document.getElementById('loginPw').value = '';
  refreshUserNameDisplay();
  showToast('로그아웃되었습니다.', 'success');
}

// ----- Firebase 초기화 (클라우드 공유 휴가증 저장소) -----
var firebaseConfig = {
  apiKey: "AIzaSyBK_OijdnrC0_fAFr8vQ91jWIMv7aIu3uQ",
  authDomain: "vacation-manage-auto-system.firebaseapp.com",
  projectId: "vacation-manage-auto-system",
  storageBucket: "vacation-manage-auto-system.firebasestorage.app",
  messagingSenderId: "707114921205",
  appId: "1:707114921205:web:d2d840a81961de6ec5a9bc"
};
var FB_DB = null;
var FB_UID = null;
try {
  if (typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    FB_DB = firebase.firestore();
    firebase.auth().signInAnonymously()
      .then(function(cred) {
        FB_UID = cred.user.uid;
        console.log('Firebase 익명 인증:', FB_UID);
        // 본인이 작성하고 서버에서 처리 완료된 휴가증은 우측 카드에서 자동 제거
        setTimeout(cleanupProcessedLeavesFromCloud, 200);
      })
      .catch(function(err) { console.warn('Firebase 익명 인증 실패:', err); });
  }
} catch (e) {
  console.warn('Firebase 초기화 실패:', e);
}

// ----- 본인 정보 (localStorage) -----
// 한 번 작성한 휴대폰은 본인 정보를 기억 → 다음 작성/조회 시 자동 사용
function getMyInfo() {
  try { return JSON.parse(localStorage.getItem('p5_me')) || null; }
  catch (e) { return null; }
}
function setMyInfo(name, phone4) {
  if (!name || !phone4) return;
  localStorage.setItem('p5_me', JSON.stringify({ name: name, phone4: phone4 }));
}
// 비밀번호 보기 / 숨기기 토글
function togglePwVisibility(inputId, btn) {
  var input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
    btn.title = '비밀번호 숨기기';
  } else {
    input.type = 'password';
    btn.textContent = '👁';
    btn.title = '비밀번호 보기';
  }
}

function getPhone4(phone) {
  if (!phone) return '';
  var digits = String(phone).replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

// ----- 권한 (사번 기반 — 로그인 시 설정됨) -----
// 모바일에서는 권한 자체를 비활성 (작업자 모드만)
var ADMIN_MODE = localStorage.getItem('p5_admin') === '1';
var LEADER_MODE = localStorage.getItem('p5_leader') === '1';
if (window.innerWidth <= 600) {
  ADMIN_MODE = false;
  LEADER_MODE = false;
}
if (ADMIN_MODE) document.documentElement.classList.add('admin-mode');
if (LEADER_MODE) document.documentElement.classList.add('leader-mode');

// ----- 데이터 -----
var workers = JSON.parse(localStorage.getItem('p5_workers') || '[]');
// worker: { name, employeeId, team, phone }

// workers.json (코드 내장 기본 명단) — 페이지 로드 시 fetch
var DEFAULT_WORKERS = [];
fetch('workers.json', { cache: 'no-cache' })
  .then(function(r) { return r.ok ? r.json() : []; })
  .then(function(data) {
    DEFAULT_WORKERS = Array.isArray(data) ? data : [];
    // localStorage 명단이 비어있으면 기본 명단으로 자동 채움
    if (workers.length === 0 && DEFAULT_WORKERS.length > 0) {
      workers = DEFAULT_WORKERS.slice();
      localStorage.setItem('p5_workers', JSON.stringify(workers));
    }
  })
  .catch(function() {}); // workers.json 없거나 실패해도 무시

var leaves = JSON.parse(localStorage.getItem('p5_leaves') || '[]');
// leave: { id, name, employeeId, team, type, start, end, reason, phone, createdAt }

// 구분 옵션 (드롭다운에 표시되는 순서)
var LEAVE_TYPES = ['연차', '반차(오전)', '반차(오후)', '반반차(오전)', '반반차(오후)', '생휴', '하기휴가', '결근', '결근(오전)', '결근(오후)'];

// 구분별 1개당 일수 가중치 (경조는 호환을 위해 매핑은 유지)
var TYPE_WEIGHT = {
  '연차': 1,
  '반차(오전)': 0.5,
  '반차(오후)': 0.5,
  '반반차(오전)': 0.25,
  '반반차(오후)': 0.25,
  '생휴': 1,
  '하기휴가': 3,  // 1개 = 3일 (연속 3일 휴가)
  '경조': 1,
  '결근': 1,
  '결근(오전)': 0.5,
  '결근(오후)': 0.5
};

// 입력된 기간 전체를 차지하는 유형 (count 무시, 일수는 영업일 수)
var FULL_RANGE_TYPES = ['하기휴가'];

// 구분별 출퇴근 안내 (반차/반반차 + 결근 오전/오후)
var TYPE_TIMES = {
  '반차(오전)':   '오후 12시 50분 출근',
  '반차(오후)':   '오후 12시 퇴근',
  '반반차(오전)': '오전 10시 출근',
  '반반차(오후)': '오후 3시 퇴근',
  '결근(오전)':   '오후 12시 50분 출근',
  '결근(오후)':   '오후 12시 퇴근'
};

// 그룹웨어 휴가 유형 매핑 (우리 양식 → 그룹웨어 드롭다운 옵션 텍스트)
var GROUPWARE_TYPE_MAPPING = {
  '연차': '연차',
  '반차(오전)': '반차(오전)',
  '반차(오후)': '반차(오후)',
  '반반차(오전)': '반반차(오전)',
  '반반차(오후)': '반반차(오후)',
  '생휴': '생휴',
  '하기휴가': '하기휴가',
  '경조': '경조휴가',
  '결근': '결근',
  '결근(오전)': '결근(오전)',
  '결근(오후)': '결근(오후)'
};

// 항목 1개의 일수 = 가중치 × 개수
function calcItemDays(item) {
  var w = TYPE_WEIGHT[item.type] || 0;
  var c = parseFloat(item.count) || 0;
  return w * c;
}

// 항목 배열의 총 일수
function calcTotalDays(items) {
  return (items || []).reduce(function(s, it) { return s + calcItemDays(it); }, 0);
}

// 기존 type 명칭 → 신 명칭 매핑 (호환성)
var TYPE_RENAME = {
  '무결': '결근'
};
function renameType(t) { return TYPE_RENAME[t] || t; }

// 기존(단일 type) leave 데이터를 items 배열로 정규화 (호환성)
function normalizeLeaveItems(l) {
  var arr;
  if (l.items && l.items.length > 0) {
    arr = l.items.map(function(it) { return { type: renameType(it.type), count: it.count }; });
  } else if (l.type) {
    arr = [{ type: renameType(l.type), count: 1 }];
  } else {
    arr = [];
  }
  return arr;
}

// 일수 포맷 (정수면 정수, 아니면 소수점 2자리)
function fmtDays(n) {
  if (n == null) return '';
  if (n % 1 === 0) return n + '일';
  return n.toFixed(2).replace(/\.?0+$/, '') + '일';
}

// ----- 유틸 -----
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function dateToStr(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function uuid() { return 'lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  setTimeout(function() { t.className = 'toast'; }, 2200);
}

function formatPhone(input) {
  var v = input.value.replace(/[^0-9]/g, '');
  if (v.length > 11) v = v.slice(0, 11);
  if (v.length >= 8) {
    input.value = v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7);
  } else if (v.length >= 4) {
    input.value = v.slice(0, 3) + '-' + v.slice(3);
  } else {
    input.value = v;
  }
}

// 한국 공휴일 제외 + 주말 제외 영업일 수 계산 (작성된 휴가 일수 참고용)
var KR_HOLIDAYS_SHORT = {
  '2025-01-01':1,'2025-01-28':1,'2025-01-29':1,'2025-01-30':1,'2025-03-01':1,'2025-03-03':1,
  '2025-05-05':1,'2025-05-06':1,'2025-06-06':1,'2025-08-15':1,'2025-10-03':1,
  '2025-10-05':1,'2025-10-06':1,'2025-10-07':1,'2025-10-08':1,'2025-10-09':1,'2025-12-25':1,
  '2026-01-01':1,'2026-02-16':1,'2026-02-17':1,'2026-02-18':1,'2026-03-01':1,'2026-03-02':1,
  '2026-05-05':1,'2026-05-24':1,'2026-05-25':1,'2026-06-03':1,'2026-06-06':1,'2026-08-15':1,'2026-08-17':1,
  '2026-09-24':1,'2026-09-25':1,'2026-09-26':1,'2026-09-28':1,'2026-10-03':1,'2026-10-05':1,'2026-10-09':1,'2026-12-25':1,
  '2027-01-01':1,'2027-02-06':1,'2027-02-07':1,'2027-02-08':1,'2027-02-09':1,'2027-03-01':1,
  '2027-05-05':1,'2027-05-13':1,'2027-06-06':1,'2027-08-15':1,'2027-08-16':1,
  '2027-09-14':1,'2027-09-15':1,'2027-09-16':1,'2027-10-03':1,'2027-10-04':1,'2027-10-09':1,'2027-10-11':1,'2027-12-25':1,'2027-12-27':1
};
function countWorkdays(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  var s = new Date(startStr);
  var e = new Date(endStr);
  if (e < s) return 0;
  var n = 0;
  var d = new Date(s);
  while (d <= e) {
    var dow = d.getDay();
    var key = dateToStr(d);
    if (dow !== 0 && dow !== 6 && !KR_HOLIDAYS_SHORT[key]) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

// ----- 초기화 -----
(function init() {
  // 기존 leave 데이터에 옛 type명(예: '무결')이 있으면 신 명칭으로 마이그레이션
  var migrated = false;
  leaves.forEach(function(l) {
    if (l.type && TYPE_RENAME[l.type]) { l.type = TYPE_RENAME[l.type]; migrated = true; }
    if (l.items && l.items.length > 0) {
      l.items.forEach(function(it) {
        if (TYPE_RENAME[it.type]) { it.type = TYPE_RENAME[it.type]; migrated = true; }
      });
    }
  });
  if (migrated) saveLeaves();

  var today = new Date();
  document.getElementById('todayLabel').textContent =
    today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

  var todayStr = dateToStr(today);
  document.getElementById('leaveStart').value = todayStr;
  document.getElementById('leaveEnd').value = todayStr;

  // 기간 변경 시 합계 갱신 (하기휴가 등 영업일 기반 type 위해)
  document.getElementById('leaveStart').addEventListener('change', refreshFormTotals);
  document.getElementById('leaveEnd').addEventListener('change', refreshFormTotals);

  refreshFormTotals();
  renderLeaveList();
  // 작업자 로그인 상태면 본인 정보 자동 채움 + readonly
  applyWorkerProfileToForm();
  // 상단바 사용자 이름 표시
  refreshUserNameDisplay();

  // 로그인 화면에 저장된 사번 자동 채움 (체크박스 동기화)
  var rememberedId = localStorage.getItem('p5_remembered_id');
  var loginEmpInput = document.getElementById('loginEmpId');
  var loginRememberEl = document.getElementById('loginRemember');
  if (rememberedId && loginEmpInput) loginEmpInput.value = rememberedId;
  if (loginRememberEl) loginRememberEl.checked = !!rememberedId;

  // 세션 자동 갱신 — 사이트 들어올 때마다 만료 시간 30일 연장
  touchSession();
})();

function refreshFormTotals() {
  var type = document.getElementById('leaveType').value;
  var count = parseInt(document.getElementById('leaveCount').value, 10) || 1;
  if (FULL_RANGE_TYPES.indexOf(type) !== -1) {
    // 하기휴가 등: count 1 고정
    var countEl = document.getElementById('leaveCount');
    countEl.value = '1';
    countEl.disabled = true;
    count = 1;
  } else {
    document.getElementById('leaveCount').disabled = false;
  }
  var days = (TYPE_WEIGHT[type] || 0) * count;
  document.getElementById('leaveItemsTotal').textContent = fmtDays(days);
}

// ----- 자동완성 (이름) -----
var activeSuggestionIdx = -1;

function onNameInput() {
  var q = document.getElementById('leaveName').value.trim();
  var box = document.getElementById('nameSuggestions');
  if (!q) {
    box.style.display = 'none';
    return;
  }
  var matches = workers.filter(function(w) {
    return w.name && w.name.indexOf(q) !== -1;
  }).slice(0, 8);
  if (matches.length === 0) {
    box.style.display = 'none';
    return;
  }
  box.innerHTML = matches.map(function(w, i) {
    var sub = [w.employeeId, w.team].filter(Boolean).join(' / ');
    return '<div class="suggestion-item" data-idx="' + i + '" onmousedown="pickSuggestion(' + i + ')">' +
      w.name + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>';
  }).join('');
  box._matches = matches;
  box.style.display = 'block';
  activeSuggestionIdx = -1;
}

function pickSuggestion(i) {
  var box = document.getElementById('nameSuggestions');
  var w = (box._matches || [])[i];
  if (!w) return;
  document.getElementById('leaveName').value = w.name;
  if (w.phone) document.getElementById('leavePhone').value = w.phone;
  hideNameSuggestions();
}

function hideNameSuggestions() {
  setTimeout(function() {
    document.getElementById('nameSuggestions').style.display = 'none';
  }, 150);
}

// ----- 휴가증 추가 -----
function addLeave() {
  var name = document.getElementById('leaveName').value.trim();
  var type = document.getElementById('leaveType').value;
  var count = parseInt(document.getElementById('leaveCount').value, 10) || 1;
  var start = document.getElementById('leaveStart').value;
  var end = document.getElementById('leaveEnd').value;
  var reason = document.getElementById('leaveReason').value.trim();
  var phone = document.getElementById('leavePhone').value.trim();

  if (!name) { showToast('이름을 입력해 주세요.', 'error'); return; }
  if (!type) { showToast('구분을 선택해 주세요.', 'error'); return; }
  if (!count || count < 1) { showToast('개수를 1 이상으로 입력해 주세요.', 'error'); return; }
  if (!start) { showToast('시작일을 입력해 주세요.', 'error'); return; }
  if (!end) { showToast('종료일을 입력해 주세요.', 'error'); return; }
  if (end < start) { showToast('종료일이 시작일보다 이전입니다.\n기간을 다시 확인해 주세요.', 'error'); return; }
  if (!reason) { showToast('사유를 입력해 주세요.', 'error'); return; }
  if (!phone) { showToast('연락처를 입력해 주세요.', 'error'); return; }

  // 중복 / 초과 차단 — 같은 날짜에 기존 휴가 + 신규 휴가 합산이 1일 초과하면 막기
  function getDayWeight(t) {
    return FULL_RANGE_TYPES.indexOf(t) !== -1 ? 1 : (TYPE_WEIGHT[t] || 0);
  }
  var newDayWeight = getDayWeight(type);
  var checkDates = getWorkdaysList(start, end);
  for (var di = 0; di < checkDates.length; di++) {
    var dateStr = checkDates[di];
    var dayTotal = newDayWeight;
    leaves.forEach(function(l) {
      if (l.name !== name) return;
      if (dateStr < l.start || dateStr > l.end) return;
      (l.items || []).forEach(function(it) {
        dayTotal += getDayWeight(it.type);
      });
    });
    if (dayTotal > 1.0) {
      showToast('해당 날짜(' + dateStr + ')에 이미 등록된 휴가가 있어\n합계가 1일을 초과합니다.\n기존 휴가증을 삭제한 후 다시 작성해 주세요.', 'error');
      return;
    }
  }

  // 명단 매칭 (있으면 사번/근무지 자동 채움)
  var matched = workers.find(function(w) { return w.name === name; });
  if (FULL_RANGE_TYPES.indexOf(type) !== -1) count = 1;  // 하기휴가: count 강제 1
  var days = (TYPE_WEIGHT[type] || 0) * count;
  // 본인 식별자: 연락처에서 마지막 4자리 추출
  var phone4 = getPhone4(phone);
  setMyInfo(name, phone4);  // localStorage에 본인 정보 저장 (다음 작성·조회 시 자동 사용)
  var leave = {
    id: uuid(),
    name: name,
    employeeId: matched ? (matched.employeeId || '') : '',
    team: matched ? (matched.team || '') : '',
    items: [{ type: type, count: count }],
    days: days,
    start: start,
    end: end,
    reason: reason,
    phone: phone,
    submitterPhone4: phone4,
    createdAt: new Date().toISOString()
  };

  leaves.unshift(leave);
  saveLeaves();
  renderLeaveList();
  resetForm();
  uploadLeaveToCloud(leave);  // Firestore에도 저장 (실패해도 로컬은 유지)
  showToast(name + ' / ' + type + ' ' + count + '개 (' + fmtDays(days) + ') 추가됨', 'success');
}

// ----- Firestore 업로드/삭제 -----
function uploadLeaveToCloud(leave) {
  if (!FB_DB || !FB_UID) {
    setTimeout(function() {
      showToast('⚠ 서버 연결 안 됨\n휴가증이 서무에게 전달되지 않을 수 있습니다.', 'error');
    }, 800);
    return;
  }
  var doc = Object.assign({}, leave);
  doc.submittedBy = FB_UID;
  doc.processed = false;  // 서무가 [처리 완료] 시 true로 변경
  doc.serverCreatedAt = firebase.firestore.FieldValue.serverTimestamp();
  // 14일 후 자동 삭제용 TTL 필드
  doc.expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  FB_DB.collection('leaves').doc(leave.id).set(doc)
    .catch(function(err) {
      console.warn('Firestore 저장 실패:', err);
      setTimeout(function() {
        showToast('⚠ 서버 저장 실패\n인터넷 연결 확인 후 다시 작성해 주세요.', 'error');
      }, 800);
    });
}

function deleteLeaveFromCloud(id) {
  if (!FB_DB) return;
  FB_DB.collection('leaves').doc(id).delete()
    .catch(function(err) { console.warn('Firestore 삭제 실패:', err); });
}

// 본인이 작성한 휴가증 중 서버에서 처리 완료(processed=true)된 건 우측 카드에서 자동 제거
// 페이지 로드 + 인증 완료 시 호출
function cleanupProcessedLeavesFromCloud() {
  if (!FB_DB || !FB_UID || leaves.length === 0) return;
  FB_DB.collection('leaves')
    .where('processed', '==', true)
    .get()
    .then(function(snapshot) {
      var processedIds = {};
      snapshot.forEach(function(doc) {
        var d = doc.data();
        if (d.submittedBy === FB_UID) processedIds[doc.id] = true;
      });
      var before = leaves.length;
      leaves = leaves.filter(function(l) { return !processedIds[l.id]; });
      if (leaves.length !== before) {
        saveLeaves();
        renderLeaveList();
      }
    })
    .catch(function(err) { console.warn('processed cleanup 실패:', err); });
}

function saveLeaves() {
  localStorage.setItem('p5_leaves', JSON.stringify(leaves));
}

function resetForm() {
  document.getElementById('leaveName').value = '';
  document.getElementById('leaveType').value = '연차';
  document.getElementById('leaveCount').value = '1';
  var today = dateToStr(new Date());
  document.getElementById('leaveStart').value = today;
  document.getElementById('leaveEnd').value = today;
  document.getElementById('leaveReason').value = '';
  document.getElementById('leavePhone').value = '';
  refreshFormTotals();
  // 작업자 로그인 상태면 이름·연락처 다시 본인 정보로
  applyWorkerProfileToForm();
  document.getElementById('leaveReason').focus();
}

function removeLeave(id) {
  if (!confirm('이 휴가증을 삭제하시겠습니까?')) return;
  leaves = leaves.filter(function(l) { return l.id !== id; });
  saveLeaves();
  renderLeaveList();
  deleteLeaveFromCloud(id);
}

function resetAllLeaves() {
  if (leaves.length === 0) {
    showToast('초기화할 휴가증이 없습니다.', 'error');
    return;
  }
  if (!confirm('작성된 휴가증 ' + leaves.length + '건을 모두 삭제하시겠습니까?\n이 동작은 되돌릴 수 없습니다.\n\n(서버에 업로드된 휴가증은 삭제되지 않습니다)')) return;
  leaves = [];
  saveLeaves();
  renderLeaveList();
  showToast('로컬 휴가증 전체 초기화됨.', 'success');
}

// ----- 내 휴가증 모달 (개인이 본인 휴가증 조회/취소) -----
var myLeavesCache = [];

function openMyLeavesModal() {
  // localStorage에 본인 정보 있으면 자동 채움 (수정 가능)
  var me = getMyInfo();
  document.getElementById('myAuthName').value = me ? me.name : '';
  document.getElementById('myAuthPhone4').value = me ? me.phone4 : '';
  document.getElementById('myLeavesList').innerHTML = '<div class="my-leaves-empty">조회 정보를 입력하고 조회 버튼을 눌러 주세요.</div>';
  document.getElementById('myLeavesModal').style.display = 'flex';
  // 본인 정보 있으면 자동 조회
  if (me && me.name && me.phone4) fetchMyLeaves();
}

function closeMyLeavesModal() {
  document.getElementById('myLeavesModal').style.display = 'none';
  myLeavesCache = [];
}

function fetchMyLeaves() {
  var name = document.getElementById('myAuthName').value.trim();
  var phone4 = document.getElementById('myAuthPhone4').value.trim();
  if (!name) { showToast('이름을 입력해 주세요.', 'error'); return; }
  if (!/^[0-9]{4}$/.test(phone4)) { showToast('휴대폰 마지막 4자리를 숫자로 정확히 입력해 주세요.', 'error'); return; }
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }
  if (!FB_UID) { showToast('인증 진행 중입니다. 잠시 후 다시 시도해 주세요.', 'error'); return; }

  // localStorage 본인 정보 갱신 (조회 성공 시 작성도 본인으로 인식)
  setMyInfo(name, phone4);

  var fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  document.getElementById('myLeavesList').innerHTML = '<div class="my-leaves-empty">조회 중...</div>';

  // 작업자 모드: 서무가 처리 완료한 휴가증만 표시
  var sess = getSession();
  var workerMode = (sess && sess.role === 'worker');

  FB_DB.collection('leaves')
    .where('name', '==', name)
    .get()
    .then(function(snapshot) {
      var results = [];
      snapshot.forEach(function(doc) {
        var d = doc.data();
        if (d.submitterPhone4 !== phone4) return;
        if (workerMode && d.processed !== true) return;
        var t = d.serverCreatedAt && d.serverCreatedAt.toDate ? d.serverCreatedAt.toDate() : null;
        if (t && t < fourteenDaysAgo) return;
        results.push({
          docId: doc.id,
          id: d.id,
          name: d.name,
          items: d.items || [],
          days: d.days,
          start: d.start,
          end: d.end,
          reason: d.reason,
          submittedBy: d.submittedBy,
          processed: d.processed === true,
          serverCreatedAt: t
        });
      });
      // 최신순 정렬
      results.sort(function(a, b) {
        return (b.serverCreatedAt ? b.serverCreatedAt.getTime() : 0) - (a.serverCreatedAt ? a.serverCreatedAt.getTime() : 0);
      });
      myLeavesCache = results;
      renderMyLeavesList(results);
    })
    .catch(function(err) {
      console.error('내 휴가증 조회 실패:', err);
      document.getElementById('myLeavesList').innerHTML = '<div class="my-leaves-empty error">조회 실패: ' + (err.message || err) + '</div>';
    });
}

function renderMyLeavesList(items) {
  var listEl = document.getElementById('myLeavesList');
  if (items.length === 0) {
    listEl.innerHTML = '<div class="my-leaves-empty">최근 14일 내 작성된 휴가증이 없습니다.</div>';
    return;
  }
  listEl.innerHTML = items.map(function(l, i) {
    // 처리 완료된 휴가증은 그룹웨어에 이미 등록됨 → 취소 불가
    // 같은 휴대폰 + 미처리 휴가증만 취소 가능
    var canDelete = (l.submittedBy === FB_UID) && !l.processed;
    var typesText = (l.items || []).map(function(it) {
      return it.type + (it.count > 1 ? ' × ' + it.count : '');
    }).join(', ');
    var periodText = l.start === l.end ? l.start : (l.start + ' ~ ' + l.end);
    var createdText = l.serverCreatedAt ? l.serverCreatedAt.toLocaleString('ko-KR') : '';
    var footerRight;
    if (canDelete) {
      footerRight = '<button class="my-leave-del" onclick="deleteMyLeave(\'' + l.docId + '\')">취소</button>';
    } else if (l.processed) {
      footerRight = '<span class="my-leave-processed">✓ 처리 완료</span>';
    } else {
      footerRight = '<span class="my-leave-locked" title="다른 휴대폰에서 작성된 휴가증입니다.">🔒 다른 휴대폰</span>';
    }
    return '<div class="my-leave-card">' +
      '<div class="my-leave-card-head">' +
        '<div class="my-leave-card-type">' + escapeHtml(typesText) + '</div>' +
        '<div class="my-leave-card-days">' + fmtDays(l.days) + '</div>' +
      '</div>' +
      '<div class="my-leave-card-period">' + escapeHtml(periodText) + '</div>' +
      '<div class="my-leave-card-reason">' + escapeHtml(l.reason || '') + '</div>' +
      '<div class="my-leave-card-footer">' +
        '<span class="my-leave-card-created">' + escapeHtml(createdText) + ' 작성</span>' +
        footerRight +
      '</div>' +
    '</div>';
  }).join('');
}

function deleteMyLeave(docId) {
  if (!confirm('이 휴가증을 취소(삭제)하시겠습니까?\n취소 후엔 되돌릴 수 없습니다.')) return;
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }
  FB_DB.collection('leaves').doc(docId).delete()
    .then(function() {
      // 로컬 leaves 배열에서도 제거 (있다면)
      var target = myLeavesCache.find(function(l) { return l.docId === docId; });
      if (target) {
        leaves = leaves.filter(function(l) { return l.id !== target.id; });
        saveLeaves();
        renderLeaveList();
      }
      showToast('취소 완료', 'success');
      fetchMyLeaves();  // 목록 새로고침
    })
    .catch(function(err) {
      console.error('삭제 실패:', err);
      showToast('취소 실패: ' + (err.message || err) + ' (작성한 휴대폰에서 시도해 주세요)', 'error');
    });
}

// ----- 서무: 미처리 휴가증(최근 7일)을 서버에서 가져오기 -----
function fetchTodayLeavesFromCloud() {
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }
  if (!FB_UID) { showToast('인증 진행 중입니다. 잠시 후 다시 시도해 주세요.', 'error'); return; }

  var sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  showToast('서버에서 휴가증을 가져오는 중...', '');
  FB_DB.collection('leaves')
    .get()
    .then(function(snapshot) {
      var fetched = [];
      var docsToMark = [];  // 처리 완료로 마크할 문서 refs
      snapshot.forEach(function(doc) {
        var data = doc.data();
        if (data.processed === true) return;
        var t = data.serverCreatedAt && data.serverCreatedAt.toDate ? data.serverCreatedAt.toDate() : null;
        if (t && t < sevenDaysAgo) return;
        docsToMark.push(doc.ref);
        delete data.submittedBy;
        delete data.expiresAt;
        delete data.serverCreatedAt;
        delete data.processed;
        fetched.push(data);
      });
      if (fetched.length === 0) {
        showToast('미처리 휴가증이 없습니다.', 'error');
        return;
      }
      var existingIds = {};
      leaves.forEach(function(l) { existingIds[l.id] = 1; });
      var newOnes = fetched.filter(function(l) { return !existingIds[l.id]; });
      if (newOnes.length === 0) {
        showToast('이미 모두 가져온 상태입니다. (서버 ' + fetched.length + '건 = 로컬과 동일)', '');
        return;
      }
      if (!confirm(
        '서버에서 미처리 휴가증 ' + fetched.length + '건을 발견했습니다.\n' +
        '그 중 ' + newOnes.length + '건이 현재 화면에 없는 새 휴가증입니다.\n\n' +
        '추가하시겠습니까?'
      )) return;
      newOnes.forEach(function(l) { leaves.unshift(l); });
      saveLeaves();
      renderLeaveList();

      // 가져온 휴가증을 즉시 처리 완료로 자동 마크 (작업자 수정 방지)
      var batch = FB_DB.batch();
      var processedAt = firebase.firestore.FieldValue.serverTimestamp();
      docsToMark.forEach(function(ref) {
        batch.update(ref, { processed: true, processedAt: processedAt, processedBy: FB_UID });
      });
      batch.commit()
        .then(function() {
          showToast(newOnes.length + '건 추가 + 처리 완료 자동 마크됨.\n[파일로 내보내기] → run.bat 진행하세요.', 'success');
        })
        .catch(function(err) {
          console.warn('처리 완료 자동 마크 실패:', err);
          showToast(newOnes.length + '건 추가됨.\n⚠ 처리 완료 마크 실패 — 수동으로 [처리 완료] 필요', 'error');
        });
    })
    .catch(function(err) {
      console.error('Firestore 조회 실패:', err);
      showToast('가져오기 실패: ' + (err.message || err), 'error');
    });
}

// ----- 서무: 현재 화면 휴가증들을 클라우드에서 [처리 완료]로 마크 -----
function markLeavesAsProcessed() {
  if (!FB_DB) { showToast('서버 연결 안 됨', 'error'); return; }
  if (leaves.length === 0) {
    showToast('처리 완료 표시할 휴가증이 없습니다.', 'error');
    return;
  }
  if (!confirm(
    '현재 화면의 휴가증 ' + leaves.length + '건을 [처리 완료]로 표시하시겠습니까?\n\n' +
    '※ 처리 완료 표시 후 [서버에서 불러오기]를 해도 이 휴가증들은 더 이상 가져오지 않습니다.\n' +
    '※ 자동화 프로그램으로 그룹웨어 등록까지 완료된 후에 눌러주세요.'
  )) return;

  showToast('처리 완료 표시 중...', '');
  var batch = FB_DB.batch();
  var processedAt = firebase.firestore.FieldValue.serverTimestamp();
  leaves.forEach(function(l) {
    var ref = FB_DB.collection('leaves').doc(l.id);
    batch.update(ref, { processed: true, processedAt: processedAt, processedBy: FB_UID });
  });

  batch.commit()
    .then(function() {
      var count = leaves.length;
      // 로컬에서도 비움 (다음 불러오기는 새로 작성된 것만)
      leaves = [];
      saveLeaves();
      renderLeaveList();
      showToast(count + '건 처리 완료 표시됨. 다음 [서버에서 불러오기]는 새 휴가증만 가져옵니다.', 'success');
    })
    .catch(function(err) {
      console.error('처리 완료 표시 실패:', err);
      showToast('처리 완료 표시 실패: ' + (err.message || err), 'error');
    });
}

function renderLeaveList() {
  var list = document.getElementById('leaveList');
  document.getElementById('listCount').textContent = leaves.length + '건';

  if (leaves.length === 0) {
    list.innerHTML = '<div class="empty-state">아직 작성된 휴가증이 없습니다.</div>';
    return;
  }

  list.innerHTML = leaves.map(function(l) {
    var items = normalizeLeaveItems(l);
    var days = (l.days != null) ? l.days : calcTotalDays(items);
    var periodText = l.start === l.end ? l.start : (l.start + ' ~ ' + l.end);
    if (days > 0) periodText += ' <span class="leave-days">' + fmtDays(days) + '</span>';

    // 구분 배지들 (항목별)
    var typeBadges = items.map(function(it) {
      var cls = 'leave-type-' + it.type.replace(/[()·]/g, '-').replace(/-+/g, '-').replace(/-+$/, '');
      var label = it.type + (it.count > 1 ? ' x' + it.count : '');
      return '<span class="leave-item-type ' + cls + '">' + label + '</span>';
    }).join(' ');

    var sub = [l.employeeId, l.team].filter(Boolean).join(' / ');
    return '<div class="leave-item">' +
      '<div class="leave-item-head">' +
        '<div><span class="leave-item-name">' + escapeHtml(l.name) + '</span>' +
          (sub ? '<span class="leave-item-sub">' + escapeHtml(sub) + '</span>' : '') +
        '</div>' +
        '<div class="leave-item-types">' + typeBadges + '</div>' +
      '</div>' +
      '<div class="leave-item-body">' +
        '<div><span class="label">기간</span> ' + periodText + '</div>' +
        '<div><span class="label">사유</span> ' + escapeHtml(l.reason) + '</div>' +
        '<div><span class="label">연락처</span> ' + escapeHtml(l.phone) + '</div>' +
      '</div>' +
      '<div class="leave-item-actions">' +
        '<button class="btn-mini danger" onclick="removeLeave(\'' + l.id + '\')">삭제</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// ----- 작업자 명단 모달 -----
var workerModalState = [];
var workerSearchQuery = '';

function openWorkerModal() {
  workerModalState = workers.map(function(w) { return Object.assign({}, w); });
  workerSearchQuery = '';
  var searchInput = document.getElementById('workerSearch');
  if (searchInput) {
    searchInput.value = '';
    // role에 따라 placeholder 변경 (일반 작업자는 사번 빠짐)
    var session = getSession();
    if (session && session.role === 'worker') {
      searchInput.placeholder = '이름·근무지·연락처로 검색';
    } else {
      searchInput.placeholder = '이름·사번·근무지·연락처로 검색';
    }
  }
  renderWorkerTable();
  document.getElementById('workerHint').textContent = '현재 ' + workers.length + '명 등록됨';
  document.getElementById('workerModal').style.display = 'flex';
}

function onWorkerSearch(value) {
  workerSearchQuery = (value || '').trim().toLowerCase();
  renderWorkerTable();
}
function closeWorkerModal() {
  document.getElementById('workerModal').style.display = 'none';
}

function renderWorkerTable() {
  var tbody = document.getElementById('workerTableBody');
  if (workerModalState.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ccc;padding:24px">명단이 비어있습니다.</td></tr>';
    return;
  }
  // 이름 가나다순 정렬 + 검색 필터 (원본 인덱스 보존)
  var view = workerModalState.map(function(w, idx) { return { w: w, idx: idx }; });
  view.sort(function(a, b) {
    return (a.w.name || '').localeCompare(b.w.name || '', 'ko');
  });
  if (workerSearchQuery) {
    view = view.filter(function(item) {
      var hay = ((item.w.name || '') + ' ' + (item.w.employeeId || '') + ' ' + (item.w.team || '') + ' ' + (item.w.phone || '')).toLowerCase();
      return hay.indexOf(workerSearchQuery) !== -1;
    });
  }

  if (view.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ccc;padding:24px">검색 결과가 없습니다.</td></tr>';
    return;
  }

  tbody.innerHTML = view.map(function(item) {
    var w = item.w;
    var i = item.idx;  // 원본 workerModalState 인덱스 (편집·삭제 시 사용)
    if (ADMIN_MODE) {
      return '<tr>' +
        '<td><input type="text" value="' + escapeHtml(w.name || '') + '" oninput="updateWorker(' + i + ',\'name\',this.value)"></td>' +
        '<td><input type="text" value="' + escapeHtml(w.employeeId || '') + '" oninput="updateWorker(' + i + ',\'employeeId\',this.value)"></td>' +
        '<td><input type="text" value="' + escapeHtml(w.team || '') + '" oninput="updateWorker(' + i + ',\'team\',this.value)"></td>' +
        '<td><input type="text" value="' + escapeHtml(w.phone || '') + '" oninput="updateWorker(' + i + ',\'phone\',this.value)"></td>' +
        '<td><button class="worker-row-del" onclick="deleteWorkerRow(' + i + ')">×</button></td>' +
      '</tr>';
    } else {
      // 비관리자: 텍스트만 표시 (편집 불가)
      return '<tr>' +
        '<td class="worker-readonly-cell">' + escapeHtml(w.name || '') + '</td>' +
        '<td class="worker-readonly-cell">' + escapeHtml(w.employeeId || '') + '</td>' +
        '<td class="worker-readonly-cell">' + escapeHtml(w.team || '') + '</td>' +
        '<td class="worker-readonly-cell">' + escapeHtml(w.phone || '') + '</td>' +
        '<td></td>' +
      '</tr>';
    }
  }).join('');
}

function updateWorker(idx, key, val) {
  if (workerModalState[idx]) workerModalState[idx][key] = val;
}

function addWorkerRow() {
  workerModalState.push({ name: '', employeeId: '', team: '', phone: '' });
  renderWorkerTable();
}

function deleteWorkerRow(idx) {
  workerModalState.splice(idx, 1);
  renderWorkerTable();
}

function resetToDefaultWorkers() {
  if (DEFAULT_WORKERS.length === 0) {
    // 다시 한 번 fetch 시도 (초기 로드 실패한 경우)
    fetch('workers.json', { cache: 'no-cache' })
      .then(function(r) { return r.ok ? r.json() : []; })
      .then(function(data) {
        DEFAULT_WORKERS = Array.isArray(data) ? data : [];
        if (DEFAULT_WORKERS.length === 0) {
          showToast('서버에 등록된 기본 명단이 없습니다.', 'error');
          return;
        }
        if (!confirm('현재 명단을 서버 기본 명단(' + DEFAULT_WORKERS.length + '명)으로 재설정합니다.\n계속하시겠습니까?')) return;
        workerModalState = DEFAULT_WORKERS.map(function(w) { return Object.assign({}, w); });
        renderWorkerTable();
        showToast('기본 명단으로 재설정되었습니다. 저장 버튼을 눌러 확정해 주세요.', 'success');
      });
    return;
  }
  if (!confirm('현재 명단을 서버 기본 명단(' + DEFAULT_WORKERS.length + '명)으로 재설정합니다.\n계속하시겠습니까?')) return;
  workerModalState = DEFAULT_WORKERS.map(function(w) { return Object.assign({}, w); });
  renderWorkerTable();
  showToast('기본 명단으로 재설정되었습니다. 저장 버튼을 눌러 확정해 주세요.', 'success');
}

function saveWorkerList() {
  // 빈 이름 행 제거
  workers = workerModalState.filter(function(w) { return w.name && w.name.trim(); }).map(function(w) {
    return {
      name: (w.name || '').trim(),
      employeeId: (w.employeeId || '').trim(),
      team: (w.team || '').trim(),
      phone: (w.phone || '').trim()
    };
  });
  localStorage.setItem('p5_workers', JSON.stringify(workers));
  closeWorkerModal();
  showToast(workers.length + '명 저장되었습니다.', 'success');
}

// ----- 엑셀 파일 업로드 -----
function onWorkerFileSelected(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data = new Uint8Array(ev.target.result);
      var wb = XLSX.read(data, { type: 'array' });
      var sheetName = wb.SheetNames[0];
      var ws = wb.Sheets[sheetName];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

      // 헤더 행 자동 감지 (이름, 사번 컬럼 찾기)
      var headerRow = -1, nameCol = -1, idCol = -1, teamCol = -1, phoneCol = -1;
      for (var i = 0; i < Math.min(rows.length, 5); i++) {
        for (var c = 0; c < rows[i].length; c++) {
          var h = String(rows[i][c] || '').trim();
          if (h === '이름' || h === '성명') { nameCol = c; headerRow = i; }
          if (h === '사번' || h === '사원번호' || h.indexOf('사번') !== -1) idCol = c;
          if (h === '근무지' || h === '조' || h === '소속' || h === '팀' || h === '설비') teamCol = c;
          if (h === '연락처' || h === '전화' || h.indexOf('연락') !== -1 || h.indexOf('휴대') !== -1) phoneCol = c;
        }
        if (headerRow !== -1) break;
      }
      if (headerRow === -1 || nameCol === -1) {
        showToast('이름 컬럼을 찾을 수 없습니다. 헤더에 "이름"이 있어야 합니다.', 'error');
        return;
      }

      var imported = [];
      for (var r = headerRow + 1; r < rows.length; r++) {
        var row = rows[r];
        var n = String(row[nameCol] || '').trim();
        if (!n) continue;
        imported.push({
          name: n,
          employeeId: idCol !== -1 ? String(row[idCol] || '').trim() : '',
          team: teamCol !== -1 ? String(row[teamCol] || '').trim() : '',
          phone: phoneCol !== -1 ? String(row[phoneCol] || '').trim() : ''
        });
      }
      if (imported.length === 0) {
        showToast('데이터가 없습니다.', 'error');
        return;
      }
      // 기존 모달 상태에 병합 (중복 이름은 덮어쓰기)
      var existingByName = {};
      workerModalState.forEach(function(w) { if (w.name) existingByName[w.name] = w; });
      imported.forEach(function(w) {
        if (existingByName[w.name]) Object.assign(existingByName[w.name], w);
        else workerModalState.push(w);
      });
      renderWorkerTable();
      showToast(imported.length + '명 불러왔습니다.', 'success');
    } catch (err) {
      console.error(err);
      showToast('파일 처리 오류: ' + (err.message || err), 'error');
    }
  };
  reader.readAsArrayBuffer(file);
  // 같은 파일 재선택 가능하게 input 초기화
  e.target.value = '';
}

// ----- 영업일 리스트 (start~end 사이 주말/공휴일 제외) -----
function getWorkdaysList(start, end) {
  if (!start || !end) return [];
  var list = [];
  var s = new Date(start);
  var e = new Date(end);
  if (e < s) return [];
  var d = new Date(s);
  while (d <= e) {
    var dow = d.getDay();
    var key = dateToStr(d);
    if (dow !== 0 && dow !== 6 && !KR_HOLIDAYS_SHORT[key]) {
      list.push(key);
    }
    d.setDate(d.getDate() + 1);
  }
  return list;
}

// ----- 한 휴가증을 그룹웨어 신청서 entry(들)로 분해 -----
// 다중 items를 영업일 순서대로 1개씩 할당하고 같은 type 연속 구간끼리 묶음
function splitLeaveToEntries(l) {
  var items = normalizeLeaveItems(l);
  var dates = getWorkdaysList(l.start, l.end);
  // items 펼치기: [연차, 연차, 반차(오후)] 형태로
  // 하기휴가 등 영업일 전체 차지 유형은 dates 수만큼 펼침
  var flat = [];
  items.forEach(function(it) {
    var n = parseInt(it.count, 10) || 1;
    if (FULL_RANGE_TYPES.indexOf(it.type) !== -1) {
      for (var i = 0; i < dates.length; i++) flat.push(it.type);
    } else {
      for (var j = 0; j < n; j++) flat.push(it.type);
    }
  });
  // 각 영업일에 1개씩 할당 (가능한 한)
  var slots = [];
  var maxN = Math.min(dates.length, flat.length);
  for (var i = 0; i < maxN; i++) slots.push({ date: dates[i], type: flat[i] });
  // 같은 type 연속 구간 묶음
  var groups = [];
  var cur = null;
  slots.forEach(function(s) {
    if (!cur || cur.type !== s.type) {
      cur = { type: s.type, dates: [s.date] };
      groups.push(cur);
    } else {
      cur.dates.push(s.date);
    }
  });
  // entry 객체로 변환
  return groups.map(function(g) {
    var dayCount;
    if (FULL_RANGE_TYPES.indexOf(g.type) !== -1) {
      // 하기휴가 등: 1개당 weight (3일) 고정, dates 길이 무관
      dayCount = TYPE_WEIGHT[g.type] || 0;
    } else {
      dayCount = (TYPE_WEIGHT[g.type] || 0) * g.dates.length;
    }
    return {
      name: l.name,
      employeeId: l.employeeId || '',
      workplace: l.team || '',
      type: g.type,
      start: g.dates[0],
      end: g.dates[g.dates.length - 1],
      days: dayCount,
      time: TYPE_TIMES[g.type] || '',
      reason: l.reason || '',
      phone: l.phone || '',
      sourceLeaveId: l.id || null
    };
  });
}

// ----- 신청서 분배 — 한 신청서 안 동일 작업자 중복 금지 (라운드로빈) -----
function distributeApplications(entries) {
  if (!entries || entries.length === 0) return [];
  // 작업자별 그룹화 (employeeId 우선, 없으면 name)
  var byEmp = {};
  entries.forEach(function(e) {
    var key = e.employeeId || e.name;
    if (!byEmp[key]) byEmp[key] = [];
    byEmp[key].push(e);
  });
  // 슬롯 수 = max(작업자별 entries 수)
  var maxN = 0;
  Object.keys(byEmp).forEach(function(k) {
    if (byEmp[k].length > maxN) maxN = byEmp[k].length;
  });
  // 빈 신청서 슬롯 N개 생성 후 라운드로빈 분배
  var apps = [];
  for (var i = 0; i < maxN; i++) apps.push([]);
  Object.keys(byEmp).forEach(function(k) {
    byEmp[k].forEach(function(e, idx) { apps[idx].push(e); });
  });
  return apps;
}

// ----- 백업 (workers + leaves) -----
function backupData() {
  var backup = {
    schema: 'cosmax-vacation-backup-v1',
    backedUpAt: new Date().toISOString(),
    workers: workers,
    leaves: leaves
  };
  var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  var today = dateToStr(new Date());
  var fname = '휴가증_백업_' + today + '.json';
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  showToast('백업 완료 (작업자 ' + workers.length + '명 / 휴가증 ' + leaves.length + '건)', 'success');
}

// ----- 복원 (백업 JSON 업로드) -----
function onRestoreFileSelected(e) {
  var file = e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      var data = JSON.parse(ev.target.result);
      if (data.schema !== 'cosmax-vacation-backup-v1') {
        showToast('백업 파일 형식이 아닙니다.', 'error');
        return;
      }
      var newWorkers = Array.isArray(data.workers) ? data.workers : [];
      var newLeaves = Array.isArray(data.leaves) ? data.leaves : [];
      var msg = '복원하시겠습니까?\n\n'
              + '백업일시: ' + (data.backedUpAt ? new Date(data.backedUpAt).toLocaleString('ko-KR') : '미상') + '\n'
              + '작업자: ' + workers.length + '명 → ' + newWorkers.length + '명\n'
              + '휴가증: ' + leaves.length + '건 → ' + newLeaves.length + '건\n\n'
              + '현재 데이터가 모두 덮어쓰여집니다.';
      if (!confirm(msg)) { e.target.value = ''; return; }
      workers = newWorkers;
      leaves = newLeaves;
      localStorage.setItem('p5_workers', JSON.stringify(workers));
      localStorage.setItem('p5_leaves', JSON.stringify(leaves));
      renderLeaveList();
      showToast('복원 완료 — 페이지를 새로고침합니다.', 'success');
      setTimeout(function() { location.reload(); }, 800);
    } catch (err) {
      console.error(err);
      showToast('백업 파일 처리 오류: ' + (err.message || err), 'error');
    }
  };
  reader.readAsText(file, 'utf-8');
  e.target.value = '';
}

// ----- 파일 내보내기 (작성된 휴가증) — JSON (생휴/비생휴 분류) -----
function exportLeaves() {
  if (leaves.length === 0) {
    showToast('내보낼 휴가증이 없습니다.', 'error');
    return;
  }

  // 작성된 모든 휴가증을 entry 배열로 분해
  var allEntries = [];
  leaves.slice().reverse().forEach(function(l) {
    splitLeaveToEntries(l).forEach(function(e) { allEntries.push(e); });
  });

  // 생휴/비생휴 분류
  var sengyuEntries = allEntries.filter(function(e) { return e.type === '생휴'; });
  var nonSengyuEntries = allEntries.filter(function(e) { return e.type !== '생휴'; });

  // 각 분류 안에서 라운드로빈으로 신청서 분배
  var nonApps = distributeApplications(nonSengyuEntries);
  var sengyuApps = distributeApplications(sengyuEntries);

  function buildApplication(category, entries) {
    var sumDays = entries.reduce(function(s, x) { return s + (x.days || 0); }, 0);
    return {
      category: category,
      totalEntries: entries.length,
      totalDays: sumDays,
      entries: entries.map(function(e, i) {
        return {
          seq: i + 1,
          name: e.name,
          employeeId: e.employeeId,
          workplace: e.workplace,
          type: e.type,
          groupwareType: GROUPWARE_TYPE_MAPPING[e.type] || e.type,
          time: TYPE_TIMES[e.type] || '',
          start: e.start,
          end: e.end,
          days: e.days,
          reason: e.reason,
          phone: e.phone
        };
      })
    };
  }

  var applications = [];
  nonApps.forEach(function(entries) { applications.push(buildApplication('비생휴', entries)); });
  sengyuApps.forEach(function(entries) { applications.push(buildApplication('생휴', entries)); });

  var totalDays = applications.reduce(function(s, a) { return s + a.totalDays; }, 0);

  // 원본 휴가증 (참고/디버깅용)
  var originalLeaves = leaves.slice().reverse().map(function(l, idx) {
    var items = normalizeLeaveItems(l).map(function(it) {
      return { type: it.type, count: it.count || 1 };
    });
    return {
      seq: idx + 1,
      name: l.name,
      employeeId: l.employeeId || '',
      workplace: l.team || '',
      start: l.start,
      end: l.end,
      days: (l.days != null) ? l.days : calcTotalDays(items),
      items: items,
      reason: l.reason,
      phone: l.phone,
      createdAt: l.createdAt
    };
  });

  var payload = {
    schema: 'cosmax-vacation-v3',
    exportedAt: new Date().toISOString(),
    team: '생산3팀 파우더 성형실',
    totalLeaves: leaves.length,
    totalApplications: applications.length,
    totalDays: totalDays,
    applications: applications,
    originalLeaves: originalLeaves
  };

  var today = dateToStr(new Date());

  // 작성된 휴가증의 근무지를 카운트하여 다수 작업장을 파일명에 표기
  var workplaceCount = {};
  leaves.forEach(function(l) {
    var wp = (l.team || '').trim();
    if (wp) workplaceCount[wp] = (workplaceCount[wp] || 0) + 1;
  });
  var dominantWorkplace = '';
  var maxCount = 0;
  Object.keys(workplaceCount).forEach(function(wp) {
    if (workplaceCount[wp] > maxCount) {
      maxCount = workplaceCount[wp];
      dominantWorkplace = wp;
    }
  });
  var workplaceSuffix = dominantWorkplace ? ' (' + dominantWorkplace + ')' : '';

  // ----- JSON 파일 다운로드 -----
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  var jsonName = '휴가증_' + today + workplaceSuffix + '.json';
  var jsonUrl = URL.createObjectURL(blob);
  var a1 = document.createElement('a');
  a1.href = jsonUrl;
  a1.download = jsonName;
  document.body.appendChild(a1);
  a1.click();
  document.body.removeChild(a1);
  setTimeout(function() { URL.revokeObjectURL(jsonUrl); }, 1000);

  // ----- XLSX 파일 다운로드 (서무 담당자 검토용) -----
  exportLeavesAsXlsx(payload, today, workplaceSuffix);

  showToast(leaves.length + '건 → 신청서 ' + applications.length + '건 (JSON + 엑셀 다운로드 완료)', 'success');
}

// ----- XLSX 출력 -----
function exportLeavesAsXlsx(payload, today, workplaceSuffix) {
  workplaceSuffix = workplaceSuffix || '';
  var wb = XLSX.utils.book_new();

  // 시트 1: 신청서별 (그룹웨어 등록 단위) — 서무 담당자가 그룹웨어 검토 시 비교
  var aoa1 = [
    ['신청서 #', '분류', '순번', '이름', '사번', '근무지', '구분', '시작일', '종료일', '일수', '출퇴근 안내', '사유', '연락처']
  ];
  (payload.applications || []).forEach(function(app, appIdx) {
    (app.entries || []).forEach(function(e) {
      aoa1.push([
        appIdx + 1,
        app.category,
        e.seq,
        e.name,
        e.employeeId,
        e.workplace,
        e.type,
        e.start,
        e.end,
        e.days,
        e.time || '',
        e.reason,
        e.phone
      ]);
    });
  });
  var ws1 = XLSX.utils.aoa_to_sheet(aoa1);
  ws1['!cols'] = [
    { wch: 9 }, { wch: 8 }, { wch: 6 }, { wch: 10 }, { wch: 12 },
    { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 7 },
    { wch: 20 }, { wch: 30 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws1, '신청서별');

  // 시트 2: 원본 입력 (사용자 작성 순서)
  var aoa2 = [
    ['순번', '이름', '사번', '근무지', '구분', '개수', '시작일', '종료일', '일수', '사유', '연락처', '작성일시']
  ];
  (payload.originalLeaves || []).forEach(function(l) {
    var items = l.items || [];
    var typeStr = items.map(function(it) { return it.type + (it.count > 1 ? '(' + it.count + ')' : ''); }).join(', ');
    var countSum = items.reduce(function(s, it) { return s + (it.count || 1); }, 0);
    aoa2.push([
      l.seq,
      l.name,
      l.employeeId,
      l.workplace,
      typeStr,
      countSum,
      l.start,
      l.end,
      l.days,
      l.reason,
      l.phone,
      l.createdAt ? new Date(l.createdAt).toLocaleString('ko-KR') : ''
    ]);
  });
  var ws2 = XLSX.utils.aoa_to_sheet(aoa2);
  ws2['!cols'] = [
    { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 16 },
    { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 7 }, { wch: 30 },
    { wch: 14 }, { wch: 22 }
  ];
  XLSX.utils.book_append_sheet(wb, ws2, '원본 입력');

  XLSX.writeFile(wb, '휴가증_' + today + workplaceSuffix + '.xlsx');
}
