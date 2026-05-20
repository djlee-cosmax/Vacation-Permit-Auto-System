// ============ 휴가증 자동 반영 프로그램 ============

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

// 기간이 단일 일자(반차/반반차)인 구분
var SINGLE_DAY_TYPES = ['반차(오전)', '반차(오후)', '반반차(오전)', '반반차(오후)'];

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
  '2026-05-05':1,'2026-05-24':1,'2026-05-25':1,'2026-06-06':1,'2026-08-15':1,'2026-08-17':1,
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
  var today = new Date();
  document.getElementById('todayLabel').textContent =
    today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

  var todayStr = dateToStr(today);
  document.getElementById('leaveStart').value = todayStr;
  document.getElementById('leaveEnd').value = todayStr;

  document.getElementById('leaveStart').addEventListener('change', updatePeriodInfo);
  document.getElementById('leaveEnd').addEventListener('change', updatePeriodInfo);

  renderLeaveList();
  updatePeriodInfo();
})();

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

// ----- 구분 변경 (기간 입력 자동 전환) -----
function onLeaveTypeChange() {
  var type = document.getElementById('leaveType').value;
  var endInput = document.getElementById('leaveEnd');
  var sep = document.getElementById('periodSep');
  if (SINGLE_DAY_TYPES.indexOf(type) !== -1) {
    // 단일 일자 (반차/반반차) — 종료일 숨김 + 시작일=종료일 자동
    endInput.style.display = 'none';
    sep.style.display = 'none';
    endInput.value = document.getElementById('leaveStart').value;
  } else {
    endInput.style.display = '';
    sep.style.display = '';
  }
  updatePeriodInfo();
}

function updatePeriodInfo() {
  var type = document.getElementById('leaveType').value;
  var startStr = document.getElementById('leaveStart').value;
  var endStr = document.getElementById('leaveEnd').value;
  var info = document.getElementById('periodDayInfo');

  // 단일 일자형은 종료일을 시작일과 동기화
  if (SINGLE_DAY_TYPES.indexOf(type) !== -1) {
    document.getElementById('leaveEnd').value = startStr;
    info.textContent = '';
    return;
  }
  if (!startStr || !endStr) { info.textContent = ''; return; }
  var days = countWorkdays(startStr, endStr);
  if (days > 0) info.textContent = '(영업일 ' + days + '일)';
  else info.textContent = '';
}

// ----- 휴가증 추가 -----
function addLeave() {
  var name = document.getElementById('leaveName').value.trim();
  var type = document.getElementById('leaveType').value;
  var start = document.getElementById('leaveStart').value;
  var end = document.getElementById('leaveEnd').value;
  var reason = document.getElementById('leaveReason').value.trim();
  var phone = document.getElementById('leavePhone').value.trim();

  // 검증
  if (!name) { showToast('이름을 입력해 주세요.', 'error'); return; }
  if (!type) { showToast('구분을 선택해 주세요.', 'error'); return; }
  if (!start) { showToast('시작일을 입력해 주세요.', 'error'); return; }
  if (SINGLE_DAY_TYPES.indexOf(type) === -1 && !end) {
    showToast('종료일을 입력해 주세요.', 'error'); return;
  }
  if (SINGLE_DAY_TYPES.indexOf(type) === -1 && end < start) {
    showToast('종료일이 시작일보다 빠릅니다.', 'error'); return;
  }
  if (!reason) { showToast('사유를 입력해 주세요.', 'error'); return; }
  if (!phone) { showToast('연락처를 입력해 주세요.', 'error'); return; }

  // 명단 매칭 (있으면 사번/조 자동 채움)
  var matched = workers.find(function(w) { return w.name === name; });
  var leave = {
    id: uuid(),
    name: name,
    employeeId: matched ? (matched.employeeId || '') : '',
    team: matched ? (matched.team || '') : '',
    type: type,
    start: start,
    end: SINGLE_DAY_TYPES.indexOf(type) !== -1 ? start : end,
    reason: reason,
    phone: phone,
    createdAt: new Date().toISOString()
  };

  leaves.unshift(leave);
  saveLeaves();
  renderLeaveList();
  resetForm();
  showToast(name + ' 휴가증이 추가되었습니다.', 'success');
}

function saveLeaves() {
  localStorage.setItem('p5_leaves', JSON.stringify(leaves));
}

function resetForm() {
  document.getElementById('leaveName').value = '';
  document.getElementById('leaveType').value = '';
  var today = dateToStr(new Date());
  document.getElementById('leaveStart').value = today;
  document.getElementById('leaveEnd').value = today;
  document.getElementById('leaveEnd').style.display = '';
  document.getElementById('periodSep').style.display = '';
  document.getElementById('leaveReason').value = '';
  document.getElementById('leavePhone').value = '';
  updatePeriodInfo();
  document.getElementById('leaveName').focus();
}

function removeLeave(id) {
  if (!confirm('이 휴가증을 삭제하시겠습니까?')) return;
  leaves = leaves.filter(function(l) { return l.id !== id; });
  saveLeaves();
  renderLeaveList();
}

function renderLeaveList() {
  var list = document.getElementById('leaveList');
  document.getElementById('listCount').textContent = leaves.length + '건';

  if (leaves.length === 0) {
    list.innerHTML = '<div class="empty-state">아직 작성된 휴가증이 없습니다.</div>';
    return;
  }

  list.innerHTML = leaves.map(function(l) {
    var typeCls = 'leave-type-' + l.type.replace(/[()·]/g, '-').replace(/--/g, '-');
    var periodText = l.start === l.end ? l.start : (l.start + ' ~ ' + l.end);
    var sub = [l.employeeId, l.team].filter(Boolean).join(' / ');
    return '<div class="leave-item">' +
      '<div class="leave-item-head">' +
        '<div><span class="leave-item-name">' + escapeHtml(l.name) + '</span>' +
          (sub ? '<span class="leave-item-sub">' + escapeHtml(sub) + '</span>' : '') +
        '</div>' +
        '<span class="leave-item-type ' + typeCls + '">' + l.type + '</span>' +
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

function openWorkerModal() {
  workerModalState = workers.map(function(w) { return Object.assign({}, w); });
  renderWorkerTable();
  document.getElementById('workerHint').textContent = '현재 ' + workers.length + '명 등록됨';
  document.getElementById('workerModal').style.display = 'flex';
}
function closeWorkerModal() {
  document.getElementById('workerModal').style.display = 'none';
}

function renderWorkerTable() {
  var tbody = document.getElementById('workerTableBody');
  if (workerModalState.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ccc;padding:24px">명단이 비어있습니다. 파일 업로드 또는 직접 추가로 등록해 주세요.</td></tr>';
    return;
  }
  tbody.innerHTML = workerModalState.map(function(w, i) {
    return '<tr>' +
      '<td><input type="text" value="' + escapeHtml(w.name || '') + '" oninput="updateWorker(' + i + ',\'name\',this.value)"></td>' +
      '<td><input type="text" value="' + escapeHtml(w.employeeId || '') + '" oninput="updateWorker(' + i + ',\'employeeId\',this.value)"></td>' +
      '<td><input type="text" value="' + escapeHtml(w.team || '') + '" oninput="updateWorker(' + i + ',\'team\',this.value)"></td>' +
      '<td><input type="text" value="' + escapeHtml(w.phone || '') + '" oninput="updateWorker(' + i + ',\'phone\',this.value)"></td>' +
      '<td><button class="worker-row-del" onclick="deleteWorkerRow(' + i + ')">×</button></td>' +
    '</tr>';
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
          if (h === '조' || h === '소속' || h === '팀' || h === '설비') teamCol = c;
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

// ----- 파일 내보내기 (작성된 휴가증) -----
function exportLeaves() {
  if (leaves.length === 0) {
    showToast('내보낼 휴가증이 없습니다.', 'error');
    return;
  }
  var aoa = [
    ['번호', '이름', '사번', '조/설비', '구분', '시작일', '종료일', '사유', '연락처', '작성일시']
  ];
  // 작성 순서대로 (오래된 것부터)
  leaves.slice().reverse().forEach(function(l, i) {
    aoa.push([
      i + 1,
      l.name,
      l.employeeId,
      l.team,
      l.type,
      l.start,
      l.end,
      l.reason,
      l.phone,
      new Date(l.createdAt).toLocaleString('ko-KR')
    ]);
  });
  var ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 5 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 20 }
  ];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '휴가증');
  var today = dateToStr(new Date());
  XLSX.writeFile(wb, '휴가증_' + today + '.xlsx');
  showToast(leaves.length + '건 내보내기 완료', 'success');
}
