// birthSkip() 시험 —  node scripts/birthskip.test.js
//
// 생휴는 매달 1일 리셋된다. 지난달에 쓴 생휴를 이번 달에 빼면 리셋으로 들어온
// 이번 달 1개를 잡아먹는다. 잔여에 바로 닿는 판단이라 시험을 붙여 둔다.
//
// auth-admin.js 는 불러오면 바로 Firebase 에 붙으므로 require 하지 않고
// 함수 글자만 떼어 돌린다.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'auth-admin.js'), 'utf8');
const m = src.match(/function birthSkip\([\s\S]*?\n\}/);
if (!m) {
  console.error('birthSkip 을 못 찾았다 — 함수 이름이 바뀌었는지 보라');
  process.exit(1);
}
const birthSkip = new Function('return ' + m[0])();

const kst = (s) => new Date(s + '+09:00');   // KST 글자를 시각으로

const cases = [
  // [설명, 마지막 리셋, 처리 시각, 휴가 쓴 날, 건너뛰어야 하는가]
  ['리셋이 없는 사람',                null,                    kst('2026-09-28T20:00'), '2026-09-22', false],
  ['리셋보다 먼저 처리됨',            kst('2026-09-01T09:00'), kst('2026-08-30T20:00'), '2026-08-25', true],
  ['같은 달에 쓰고 같은 달에 처리',   kst('2026-09-01T09:00'), kst('2026-09-28T20:00'), '2026-09-22', false],
  ['★ 지난달에 쓰고 이번 달에 처리',  kst('2026-10-01T09:00'), kst('2026-10-02T20:00'), '2026-09-22', true],
  ['리셋 당일에 쓴 것',               kst('2026-10-01T09:00'), kst('2026-10-02T20:00'), '2026-10-01', false],
  ['해를 넘긴 것',                    kst('2027-01-01T09:00'), kst('2027-01-03T20:00'), '2026-12-28', true],
  ['두 달 전 것',                     kst('2026-10-01T09:00'), kst('2026-10-02T20:00'), '2026-08-10', true],
  ['휴가 쓴 날이 없는 휴가증',        kst('2026-10-01T09:00'), kst('2026-10-02T20:00'), null,         false],
];

let ok = 0;
const bad = [];
for (const [name, reset, proc, start, want] of cases) {
  const got = !!birthSkip(reset, proc, start);
  if (got === want) { ok++; } else { bad.push(`${name} — ${got ? '건너뜀' : '차감'} (기대 ${want ? '건너뜀' : '차감'})`); }
  console.log(`  ${got === want ? '○' : '✗'} ${name}  → ${got ? '건너뜀' : '차감'}`);
}

console.log(`\n맞음 ${ok} · 틀림 ${bad.length}`);
bad.forEach((b) => console.log(`  ✗ ${b}`));
process.exit(bad.length ? 1 : 0);
