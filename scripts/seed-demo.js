#!/usr/bin/env node
'use strict';
/**
 * Tạo CSDL DỮ LIỆU MẪU riêng (mặc định data/demo.db). Không bao giờ ghi vào CSDL thật.
 *   node scripts/seed-demo.js            -> tạo lại data/demo.db
 *   DEMO_FILE=data/demo2.db node scripts/seed-demo.js
 */
const fs = require('fs');
const path = require('path');
const { openDb } = require('../src/db');
const D = require('../src/lib/dates');
const users = require('../src/services/users');
const settings = require('../src/services/settings');
const catalog = require('../src/services/catalog');
const classes = require('../src/services/classes');
const students = require('../src/services/students');
const E = require('../src/services/enrollments');
const B = require('../src/services/billing');
const A = require('../src/services/attendance');
const cash = require('../src/services/cashbook');
const TP = require('../src/services/teacherpay');

const file = path.resolve(process.env.DEMO_FILE || path.join(__dirname, '..', 'data', 'demo.db'));
if (!/demo/i.test(path.basename(file))) { console.error('Tên file dữ liệu mẫu phải chứa "demo" để tránh ghi đè dữ liệu thật.'); process.exit(1); }
for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.unlinkSync(file + ext);
const db = openDb(file);

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const today = D.todayVN();
const PW = 'Demo2026';

const ownerId = users.createOwner(db, { username: 'chu.demo', full_name: 'Nguyễn Thu Hà (chủ)', password: PW });
const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId);
for (const [k, v] of Object.entries({ center_name: 'Trung tâm Ánh Dương (DEMO)', center_address: '12 Lê Lợi, P. Bến Thành, Q.1, TP.HCM', center_phone: '0909 123 456',
  bank_info: 'Vietcombank 0123456789 – NGUYEN THU HA' })) settings.set(db, k, v);

const sEn = catalog.defaultSubjectId(db); // trung tâm chỉ dạy tiếng Anh
const r1 = catalog.saveRoom(db, owner, { name: 'P.101', capacity: 15 });
const r2 = catalog.saveRoom(db, owner, { name: 'P.102', capacity: 12 });
const r3 = catalog.saveRoom(db, owner, { name: 'Phòng 1-1', capacity: 4 });
const tLan = catalog.saveTeacher(db, owner, { full_name: 'Trần Thị Lan', phone: '0912000111', default_rate: '250000' });
const tMinh = catalog.saveTeacher(db, owner, { full_name: 'Lê Văn Minh', phone: '0912000222', default_rate: '300000' });
const tHa = catalog.saveTeacher(db, owner, { full_name: 'Nguyễn Thu Hà', phone: '0909123456', default_rate: '0', note: 'Chủ trung tâm tự đứng lớp' });
const tBao = catalog.saveTeacher(db, owner, { full_name: 'Phạm Quốc Bảo', phone: '0912000333', default_rate: '150000' });
users.createUser(db, owner, { username: 'nhanvien.demo', full_name: 'Võ Mỹ Linh (nhân viên)', password: PW, role: 'staff', perm_reports: '0' });
users.createUser(db, owner, { username: 'gv.lan', full_name: 'Trần Thị Lan', password: PW, role: 'teacher', teacher_id: tLan });
db.prepare('UPDATE users SET must_change_password = 0').run(); // tài khoản demo không bắt đổi mật khẩu

// Ngày nghỉ: một ngày đã qua và một ngày sắp tới
const start = D.addDays(today, -1 - 7 * 7 - D.weekday(today) + 1); // thứ 2 cách đây ~7 tuần
classes.addHoliday(db, owner, { date: D.addDays(start, 16), name: 'Nghỉ lễ (demo)' });
classes.addHoliday(db, owner, { date: D.addDays(today, 10), name: 'Nghỉ bảo trì (demo)' });

const cA = classes.createClass(db, owner, { name: 'Tiếng Anh Starters – tối 2-4', billing_timing: 'prepaid', subject_id: sEn, teacher_id: tLan, room_id: r1, max_students: 12, start_date: start,
  fee_type: 'monthly', fee_amount: '800000', slots: [{ weekday: 1, start_time: '18:00', end_time: '19:30' }, { weekday: 3, start_time: '18:00', end_time: '19:30' }] });
const cB = classes.createClass(db, owner, { name: 'Tiếng Anh Movers – tối 3-5', billing_timing: 'prepaid', subject_id: sEn, teacher_id: tLan, room_id: r1, max_students: 12, start_date: start,
  fee_type: 'monthly', fee_amount: '900000', slots: [{ weekday: 2, start_time: '18:00', end_time: '19:30' }, { weekday: 4, start_time: '18:00', end_time: '19:30' }] });
const cC = classes.createClass(db, owner, { name: 'IELTS 5.5 – 24 buổi', billing_timing: 'prepaid', subject_id: sEn, teacher_id: tMinh, room_id: r2, max_students: 10, start_date: D.addDays(start, 7),
  fee_type: 'course', fee_amount: '7200000', total_sessions: 24, slots: [{ weekday: 2, start_time: '19:45', end_time: '21:15' }, { weekday: 6, start_time: '19:45', end_time: '21:15' }] });
const cD = classes.createClass(db, owner, { name: 'Tiếng Anh giao tiếp – sáng CN (thu cuối tháng)', billing_timing: 'postpaid', subject_id: sEn, teacher_id: tHa, room_id: r2, max_students: 15, start_date: start,
  fee_type: 'monthly', fee_amount: '600000', excused_absence_charged: '0', slots: [{ weekday: 7, start_time: '08:00', end_time: '10:00' }] });
const cE = classes.createClass(db, owner, { name: 'Kèm 1-1 tiếng Anh – gói 8 buổi', billing_timing: 'prepaid', subject_id: sEn, teacher_id: tBao, room_id: r3, max_students: 4, start_date: start,
  fee_type: 'package', fee_amount: '200000', package_sessions: 8, excused_absence_charged: '0', slots: [{ weekday: 6, start_time: '17:00', end_time: '18:00' }, { weekday: 7, start_time: '15:00', end_time: '16:00' }] });

const ho = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Huỳnh'];
const dem = ['Minh', 'Gia', 'Bảo', 'Ngọc', 'Thảo', 'Anh', 'Khánh', 'Phương', 'Hải', 'Tuấn'];
const ten = ['An', 'Khoa', 'Linh', 'Vy', 'Nam', 'Huy', 'Châu', 'Trâm', 'Phúc', 'Long', 'My', 'Đức', 'Hân', 'Quân', 'Nhi', 'Tú'];
const kids = [];
for (let i = 0; i < 28; i++) {
  const family = i % 9 === 3 ? kids[kids.length - 1] : null; // vài cặp anh chị em chung SĐT
  const h = family ? family.ho : ho[Math.floor(rnd() * ho.length)];
  const phone = family ? family.phone : '09' + String(Math.floor(10000000 + rnd() * 89999999));
  const parent = family ? family.parent : `${h} ${dem[Math.floor(rnd() * dem.length)]} ${['Hùng', 'Lan', 'Dũng', 'Mai', 'Tâm', 'Hương'][i % 6]}`;
  const name = `${h} ${dem[Math.floor(rnd() * dem.length)]} ${ten[i % ten.length]}`;
  const year = 2012 + Math.floor(rnd() * 8);
  const id = students.createStudent(db, owner, { full_name: name, dob: `${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}/${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}/${year}`,
    parent_name: parent, parent_phone: phone, entry_level: ['A1', 'A2', 'Mất gốc', 'Khá', ''][i % 5] });
  kids.push({ id, ho: h, phone, parent });
}

const enr = (k, cls, sd, opts = {}) => E.enroll(db, owner, { student_id: kids[k].id, class_id: cls, start_date: sd, ...opts });
const pay = (inv, amt, d, method = 'cash') => B.recordReceipt(db, owner, { invoice_id: inv.id, amount: amt, method, paid_date: d, idempotency_key: `seed-${inv.id}-${amt}-${d}` });
const all = [];
for (let k = 0; k < 8; k++) all.push(enr(k, cA, start));
for (let k = 8; k < 14; k++) all.push(enr(k, cB, start));
for (let k = 14; k < 20; k++) all.push(enr(k, cC, D.addDays(start, 7)));
for (let k = 20; k < 25; k++) all.push(enr(k, cD, start));
all.push(enr(2, cD, start)); // một học sinh học hai lớp
for (let k = 25; k < 28; k++) all.push(enr(k, cE, start));
// nhập học muộn giữa tháng (tính theo tỷ lệ)
const late = enr(0, cB, D.addDays(today, -9));
all.push(late);

// thu tiền: phần lớn đóng đủ, vài em còn nợ
all.forEach((r, i) => {
  if (!r.invoice) return;
  const b = B.balance(db, r.invoice.id);
  if (b.due <= 0) return;
  const e0 = db.prepare('SELECT start_date FROM enrollments WHERE id = ?').get(b.enrollment_id);
  const paidDate = D.minDate(today, D.addDays(e0.start_date, i % 4));
  if (i % 7 === 3) pay(b, Math.round(b.due / 2 / 1000) * 1000, paidDate, 'transfer');
  else if (i % 11 !== 5) pay(b, b.due, paidDate, i % 2 ? 'transfer' : 'cash');
});

// học phí tháng tiếp theo cho lớp tháng (đã sang tháng mới)
const bulk = require('../src/services/bulk');
for (let m = D.nextMonth(D.monthOf(start)); m <= D.monthOf(today); m = D.nextMonth(m)) {
  const p = bulk.preview(db, { ym: m });
  bulk.commit(db, owner, { ym: m, keys: p.items.filter((x) => /^\d{4}-\d{2}$/.test(x.period_key)).map((x) => x.key) });
  for (const inv of db.prepare("SELECT * FROM invoices WHERE period_key = ? AND status = 'active'").all(m)) {
    if (inv.id % 4 !== 0 && B.balance(db, inv.id).due > 0) pay(B.balance(db, inv.id), B.balance(db, inv.id).due, D.minDate(`${m}-0${1 + (inv.id % 8)}`, today), inv.id % 2 ? 'cash' : 'transfer');
  }
}

// điểm danh các buổi đã qua (để lại 2 buổi gần nhất chưa điểm danh để thấy nhắc việc)
const past = db.prepare("SELECT * FROM class_sessions WHERE status = 'scheduled' AND date < ? ORDER BY date").all(today);
past.forEach((s, idx) => {
  if (idx >= past.length - 2) return;
  const roster = A.sessionRoster(db, s.id).students;
  const items = roster.map((st, j) => {
    const x = rnd();
    const status = x < 0.85 ? 'present' : x < 0.93 ? 'excused' : 'unexcused';
    return { student_id: st.student_id, status, score: idx % 6 === 0 && status === 'present' ? (6 + Math.floor(rnd() * 5)) : '', comment: idx % 9 === 0 && j === 0 ? 'Tiến bộ tốt, cần luyện phát âm' : '' };
  });
  if (s.class_id === cB && idx % 5 === 2) {
    // GV Minh dạy thay một buổi lớp Movers
    try { classes.updateSession(db, owner, s.id, { teacher_id: tMinh, reason: 'Cô Lan nghỉ ốm', force: true }); } catch (e) { /* bỏ qua */ }
  }
  A.save(db, owner, s.id, { items, complete: true });
});
// gia hạn gói buổi đến hiện tại (mỗi lần còn ít buổi thì mua gói mới, như vận hành thật)
for (const e of db.prepare("SELECT e.id FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.fee_type = 'package' AND e.status = 'active'").all()) {
  for (let g = 0; g < 5 && E.packageUsage(db, e.id).remaining <= 2; g++) {
    const inv = B.createTuitionInvoice(db, owner, { enrollment_id: e.id });
    if (g < 4) pay(B.balance(db, inv), B.balance(db, inv).due, D.addDays(today, -3), 'cash');
  }
}
// vắng nhiều
const heavy = db.prepare(`SELECT s.id FROM class_sessions s WHERE s.class_id = ? AND s.status = 'completed' ORDER BY s.date DESC LIMIT 3`).all(cA);
for (const s of heavy) A.save(db, owner, s.id, { items: [{ student_id: kids[5].id, status: 'unexcused' }], complete: false });

// chuyển lớp: học sinh lớp Starters lên Movers từ tuần này
const tr = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'").get(kids[7].id, cA);
const effective = D.addDays(today, 1 - D.weekday(today));
try { E.transfer(db, owner, { enrollment_id: tr.id, new_class_id: cB, effective_date: effective, reason: 'Lên trình độ (demo)' }); } catch (e) { console.warn('Bỏ qua chuyển lớp demo:', e.message); }
// bảo lưu: một học sinh piano
const pe = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'").get(kids[27].id, cE);
try { E.reserve(db, owner, { enrollment_id: pe.id, start_date: D.addDays(today, -6), expected_return_date: D.addDays(today, 5), reason: 'Đi du lịch cùng gia đình (demo)' }); } catch (e) { console.warn('Bỏ qua bảo lưu demo:', e.message); }

// học sinh mới chờ lớp, có đặt cọc
const w = students.createStudent(db, owner, { full_name: 'Đinh Hoàng Yến', parent_name: 'Đinh Văn Toàn', parent_phone: '0938111222', entry_level: 'Mới bắt đầu' });
E.enroll(db, owner, { student_id: w, mode: 'waiting', subject_id: sEn, note: 'Muốn học tối 3-5' });
B.recordReceipt(db, owner, { student_id: w, amount: '1000000', method: 'transfer', paid_date: today, note: 'Đặt cọc giữ chỗ khóa IELTS', idempotency_key: 'seed-deposit' });
const w2 = students.createStudent(db, owner, { full_name: 'Mai Anh Thư', parent_name: 'Mai Văn Lộc', parent_phone: '0938333444' });
E.enroll(db, owner, { student_id: w2, mode: 'waiting', subject_id: sEn, note: 'Chờ lớp Starters sáng thứ 7' });

// thu chi
const months = []; for (let m = D.monthOf(start); m <= D.monthOf(today); m = D.nextMonth(m)) months.push(m);
for (const m of months) {
  const d = D.minDate(`${m}-05`, today);
  cash.create(db, owner, { direction: 'out', category: 'rent', amount: '8000000', date: d, party: 'Chủ nhà', note: `Thuê mặt bằng ${D.displayMonth(m)}`, idempotency_key: `rent-${m}` });
  cash.create(db, owner, { direction: 'out', category: 'utilities', amount: String(900000 + Math.floor(rnd() * 400) * 1000), date: D.minDate(`${m}-08`, today), party: 'EVN / Cấp nước', idempotency_key: `ut-${m}` });
}
cash.create(db, owner, { direction: 'out', category: 'materials', amount: '1250000', date: D.addDays(today, -20), party: 'Nhà sách Fahasa', note: 'Giáo trình Starters', idempotency_key: 'mat-1' });
cash.create(db, owner, { direction: 'in', category: 'book_sale', amount: '360000', date: D.addDays(today, -15), party: 'Phụ huynh', note: 'Bán 3 sách bài tập', idempotency_key: 'book-1' });
const book = B.createOtherInvoice(db, owner, { student_id: kids[1].id, category: 'book', description: 'Sách Movers Student Book', amount: '180000', idempotency_key: 'inv-book-1' });
void book;
// chi tiền dạy tháng trước
const prev = D.monthOf(D.addDays(D.monthStart(D.monthOf(today)), -1));
for (const t of [tLan, tMinh, tBao]) { try { TP.pay(db, owner, { teacher_id: t, ym: prev, date: D.minDate(`${D.monthOf(today)}-03`, today), method: 'transfer', idempotency_key: `tp-${t}-${prev}` }); } catch (e) { /* tháng không có buổi */ } }

db.close();
console.log(`Đã tạo dữ liệu mẫu: ${file}`);
console.log(`Đăng nhập: chu.demo / ${PW} (chủ) · nhanvien.demo / ${PW} · gv.lan / ${PW} (giáo viên)`);
