// 작업자 명단 엑셀 → workers.json 변환
// 사용법: node convert_workers.js <xlsx_경로>
// 예:     node convert_workers.js "/mnt/c/Users/djlee/OneDrive - COSMAX/바탕 화면/작업자명단.xlsx"
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const xlsxPath = process.argv[2];
if (!xlsxPath || !fs.existsSync(xlsxPath)) {
  console.error('사용법: node convert_workers.js <xlsx_경로>');
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
const sheetName = wb.SheetNames[0];
const ws = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// 헤더 행 자동 감지
let headerRow = -1, nameCol = -1, idCol = -1, teamCol = -1, phoneCol = -1;
for (let i = 0; i < Math.min(rows.length, 5); i++) {
  for (let c = 0; c < rows[i].length; c++) {
    const h = String(rows[i][c] || '').trim();
    if (h === '이름' || h === '성명') { nameCol = c; headerRow = i; }
    if (h === '사번' || h === '사원번호' || h.indexOf('사번') !== -1) idCol = c;
    if (h === '근무지' || h === '조' || h === '소속' || h === '팀' || h === '설비') teamCol = c;
    if (h === '연락처' || h === '전화' || h.indexOf('연락') !== -1 || h.indexOf('휴대') !== -1) phoneCol = c;
  }
  if (headerRow !== -1) break;
}
if (headerRow === -1 || nameCol === -1) {
  console.error('이름 컬럼을 찾을 수 없습니다. 헤더에 "이름"이 있어야 합니다.');
  process.exit(1);
}

const data = [];
for (let r = headerRow + 1; r < rows.length; r++) {
  const row = rows[r];
  const n = String(row[nameCol] || '').trim();
  if (!n) continue;
  data.push({
    name: n,
    employeeId: idCol !== -1 ? String(row[idCol] || '').trim() : '',
    team: teamCol !== -1 ? String(row[teamCol] || '').trim() : '',
    phone: phoneCol !== -1 ? String(row[phoneCol] || '').trim() : ''
  });
}

const outPath = path.join(path.dirname(require.main.filename), 'workers.json');
fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

console.log('시트:', sheetName);
console.log('헤더 행:', headerRow + 1);
console.log('매핑: name=' + nameCol + ' employeeId=' + idCol + ' team=' + teamCol + ' phone=' + phoneCol);
console.log('변환 완료:', data.length, '명');
console.log('출력:', outPath);
