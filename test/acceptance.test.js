'use strict';
// Kiểm thử nghiệm thu theo mục 6 của yêu cầu. Dùng CSDL trong bộ nhớ, ngày cố định trong quá khứ.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, userOf } = require('./helpers');
const classes = require('../src/services/classes');
const students = require('../src/services/students');
const E = require('../src/services/enrollments');
const B = require('../src/services/billing');
const A = require('../src/services/attendance');
const TP = require('../src/services/teacherpay');
const bulk = require('../src/services/bulk');
const users = require('../src/services/users');
const perms = require('../src/services/perms');

function moneyInvariant(db) {
  // Mỗi đồng đã thu nằm đúng một chỗ: đã phân bổ vào khoản phải thu, hoặc trong sổ trả trước (tự do / bảo lưu), hoặc đã hoàn.
  const receipts = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE status='valid'").get().s;
  const alloc = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM allocations WHERE status='valid'").get().s;
  const credit = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_entries').get().s;
  const refunds = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE status='valid' AND category='refund'").get().s;
  assert.equal(receipts, alloc + credit + refunds, 'Bất biến tiền: thu = phân bổ + trả trước + hoàn');
}

function monthlyClass(ctx, extra = {}) {
  // Thứ 3 & Thứ 5, 800.000đ/tháng. Tháng 9/2026: nghỉ 01/09 → còn 8 buổi: 3,8,10,15,17,22,24,29
  return classes.createClass(ctx.db, ctx.owner, {
    name: 'Anh văn A1', subject_id: ctx.subj, teacher_id: ctx.t1, room_id: ctx.room, max_students: 15,
    start_date: '01/09/2026', end_date: '31/12/2026', fee_type: 'monthly', fee_amount: '800.000', prorate_first_month: '1',
    slots: [{ weekday: 2, start_time: '18:00', end_time: '19:30' }, { weekday: 4, start_time: '18:00', end_time: '19:30' }], ...extra,
  });
}

test('Ngày lễ không tạo buổi học; lớp theo khóa vẫn đủ số buổi', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '02/09/2026', name: 'Quốc khánh' });
  const id = classes.createClass(db, owner, {
    name: 'IELTS khóa 10 buổi', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '31/08/2026', fee_type: 'course', fee_amount: '3000000', total_sessions: 10,
    slots: [{ weekday: 1, start_time: '08:00', end_time: '10:00' }, { weekday: 3, start_time: '08:00', end_time: '10:00' }],
  });
  const sess = db.prepare("SELECT date FROM class_sessions WHERE class_id = ? AND status <> 'cancelled' ORDER BY date").all(id).map((r) => r.date);
  assert.equal(sess.length, 10);
  assert.ok(!sess.includes('2026-09-02'), 'Không có buổi vào ngày lễ');
  assert.equal(sess[sess.length - 1], '2026-10-05');
  // thêm ngày nghỉ sau khi đã sinh lịch: buổi bị hủy và được bù cuối khóa
  const r = classes.addHoliday(db, owner, { date: '07/09/2026', name: 'Nghỉ đột xuất' });
  assert.equal(r.cancelled, 1); assert.equal(r.makeup, 1);
  const after = db.prepare("SELECT date FROM class_sessions WHERE class_id = ? AND status <> 'cancelled' ORDER BY date").all(id).map((r) => r.date);
  assert.equal(after.length, 10);
  assert.equal(after[after.length - 1], '2026-10-07');
  // hủy một buổi: vẫn đủ 10 buổi
  const one = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date = '2026-09-09'").get(id).id;
  classes.cancelSession(db, owner, one, { reason: 'Giáo viên ốm' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status <> 'cancelled'").get(id).n, 10);
});

test('Học phí tháng tính theo tỷ lệ: 800.000đ × 4/8 = 400.000đ; đóng 300.000đ còn nợ 100.000đ; thu nợ về 0 với 2 phiếu thu', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ bù lễ' });
  const cid = monthlyClass(ctx);
  assert.equal(B.validSessions(db, cid, '2026-09-01', '2026-09-30').length, 8);
  const sid = students.createStudent(db, owner, { full_name: 'Nguyễn Văn Nam', parent_phone: '0901234567' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '17/09/2026' });
  assert.equal(r.invoice.amount, 400000);
  assert.equal(r.invoice.sessions_count, 4);
  const p1 = B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '300.000', method: 'cash', paid_date: '17/09/2026', idempotency_key: 'k1' });
  assert.equal(B.balance(db, r.invoice.id).due, 100000);
  // thu nợ: thanh toán vào khoản có sẵn, không tạo thêm học phí
  const invCount = db.prepare('SELECT COUNT(*) n FROM invoices').get().n;
  const p2 = B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '100000', method: 'transfer', paid_date: '20/09/2026', idempotency_key: 'k2' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, invCount);
  assert.equal(B.balance(db, r.invoice.id).due, 0);
  assert.notEqual(p1.id, p2.id);
  const rcs = db.prepare("SELECT code, amount FROM receipts WHERE invoice_id = ? AND status = 'valid' ORDER BY id").all(r.invoice.id);
  assert.deepEqual(rcs.map((x) => x.amount), [300000, 100000]);
  assert.notEqual(rcs[0].code, rcs[1].code);
  // thu thêm khi đã đủ bị chặn
  assert.throws(() => B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '1000', method: 'cash', idempotency_key: 'k3' }), /đã thanh toán đủ/);
  moneyInvariant(db);
});

test('Bấm xác nhận thu tiền hai lần không sinh hai giao dịch; không tạo trùng khoản phải thu cùng kỳ', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'Trần Thị Mai' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  const a = B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '200000', method: 'cash', idempotency_key: 'same-key' });
  const b = B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '200000', method: 'cash', idempotency_key: 'same-key' });
  assert.equal(a.id, b.id); assert.equal(b.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM receipts').get().n, 1);
  assert.equal(B.balance(db, r.invoice.id).paid, 200000);
  assert.throws(() => B.createTuitionInvoice(db, owner, { enrollment_id: r.enrollment_id, ym: '2026-09' }), /không tạo trùng/);
  // tạo hàng loạt tháng 10 hai lần: lần 2 không tạo thêm
  const p = bulk.preview(db, { ym: '2026-10' });
  assert.equal(p.items.length, 1);
  const c1 = bulk.commit(db, owner, { ym: '2026-10', keys: p.items.map((i) => i.key) });
  const c2 = bulk.commit(db, owner, { ym: '2026-10', keys: p.items.map((i) => i.key) });
  assert.equal(c1.created, 1); assert.equal(c2.created, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM invoices WHERE period_key = '2026-10'").get().n, 1);
  assert.ok(bulk.preview(db, { ym: '2026-10' }).exceptions.some((x) => /Đã có khoản/.test(x.reason)));
});

test('Một học sinh học hai lớp không trùng hồ sơ; hai anh chị em chung SĐT phụ huynh có hai hồ sơ', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const c1 = monthlyClass(ctx);
  const c2 = classes.createClass(db, owner, { name: 'Tiếng Anh Movers', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '600000',
    slots: [{ weekday: 6, start_time: '08:00', end_time: '09:30' }] });
  const sid = students.createStudent(db, owner, { full_name: 'Lê Minh Khoa', parent_phone: '0912 345 678' });
  E.enroll(db, owner, { student_id: sid, class_id: c1, start_date: '01/09/2026' });
  E.enroll(db, owner, { student_id: sid, class_id: c2, start_date: '01/09/2026' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM students').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments WHERE student_id = ?').get(sid).n, 2);
  assert.throws(() => E.enroll(db, owner, { student_id: sid, class_id: c1, start_date: '01/10/2026' }), /đang học lớp này/);
  const sib = students.createStudent(db, owner, { full_name: 'Lê Minh Anh', parent_phone: '+84912345678' });
  const a = students.getStudent(db, sid); const b = students.getStudent(db, sib);
  assert.equal(a.parent_phone, b.parent_phone);
  assert.notEqual(a.code, b.code);
  assert.deepEqual(students.siblings(db, a).map((s) => s.id), [sib]);
  // nhập Excel: cảnh báo anh chị em nhưng vẫn cho tạo hồ sơ riêng
  const v = students.validateImportRows(db, [{ full_name: 'Lê Minh Châu', parent_phone: '0912345678' }, { full_name: '' }]);
  assert.equal(v[0].errors.length, 0); assert.ok(v[0].warnings.some((w) => /anh chị em/.test(w)));
  assert.ok(v[1].errors.length > 0);
});

test('Tiền đặt cọc chỉ được dùng một lần khi xếp lớp', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const c1 = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'Phạm Gia Huy' });
  E.enroll(db, owner, { student_id: sid, mode: 'waiting', subject_id: ctx.subj, note: 'Chờ lớp tối' });
  B.recordReceipt(db, owner, { student_id: sid, amount: '500000', method: 'cash', idempotency_key: 'dep' });
  assert.equal(B.credit(db, sid).free, 500000);
  const w = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status = 'waiting'").get(sid).id;
  // xem trước không ghi gì
  const pv = E.placeWaiting(db, owner, { enrollment_id: w, class_id: c1, start_date: '17/09/2026', dry: true });
  assert.equal(pv.dry, true); assert.equal(pv.applied, 400000);
  assert.equal(B.credit(db, sid).free, 500000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
  const r = E.placeWaiting(db, owner, { enrollment_id: w, class_id: c1, start_date: '17/09/2026' });
  assert.equal(r.invoice.amount, 400000); assert.equal(r.applied, 400000); assert.equal(r.invoice.paid, 400000);
  assert.equal(B.credit(db, sid).free, 100000, 'còn dư 100.000đ');
  // lớp thứ hai chỉ dùng được phần còn dư
  const c2 = classes.createClass(db, owner, { name: 'Vẽ', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '300000',
    slots: [{ weekday: 7, start_time: '09:00', end_time: '10:30' }] });
  const r2 = E.enroll(db, owner, { student_id: sid, class_id: c2, start_date: '01/09/2026' });
  assert.equal(r2.applied, 100000); assert.equal(r2.invoice.due, 200000);
  assert.equal(B.credit(db, sid).free, 0);
  moneyInvariant(db);
});

test('Chuyển lớp: giữ lịch sử, chỉ chuyển phần đã đóng chưa sử dụng, không tính trùng tiền', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const a = monthlyClass(ctx);
  const b = classes.createClass(db, owner, { name: 'Anh văn A2', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '1000000',
    slots: [{ weekday: 2, start_time: '18:00', end_time: '19:30' }, { weekday: 4, start_time: '18:00', end_time: '19:30' }] });
  const sid = students.createStudent(db, owner, { full_name: 'Đỗ Hà Linh' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: a, start_date: '01/09/2026' });
  assert.equal(r.invoice.amount, 800000);
  B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '800000', method: 'cash', paid_date: '01/09/2026', idempotency_key: 'p' });
  // điểm danh 3/9 để có lịch sử
  const s1 = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date = '2026-09-03'").get(a).id;
  A.save(db, owner, s1, { items: [{ student_id: sid, status: 'present', score: '8', comment: 'Tốt' }] });

  const pv = E.transfer(db, owner, { enrollment_id: r.enrollment_id, new_class_id: b, effective_date: '17/09/2026', reason: 'Lên trình độ', dry: true });
  assert.equal(pv.dry, true);
  assert.equal(pv.old.stmt.incurred, 400000, 'lớp cũ đã học 4/8 buổi');
  assert.equal(pv.old.released, 400000, 'phần đã đóng chưa dùng');
  assert.equal(pv.neu.invoice.amount, 500000, 'lớp mới 1.000.000 × 4/8');
  assert.equal(pv.neu.applied, 400000);
  assert.equal(pv.neu.invoice.due, 100000);
  assert.equal(B.balance(db, r.invoice.id).amount, 800000, 'xem trước không thay đổi dữ liệu');

  const res = E.transfer(db, owner, { enrollment_id: r.enrollment_id, new_class_id: b, effective_date: '17/09/2026', reason: 'Lên trình độ' });
  assert.equal(res.neu.invoice.due, 100000);
  const old = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(r.enrollment_id);
  assert.equal(old.status, 'transferred'); assert.equal(old.end_date, '2026-09-16');
  // lịch sử còn nguyên
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance WHERE enrollment_id = ?').get(r.enrollment_id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM receipts WHERE status = 'valid'").get().n, 1);
  const oldInv = B.getInvoice(db, r.invoice.id);
  assert.equal(oldInv.amount, 400000); assert.equal(oldInv.paid, 400000);
  assert.equal(oldInv.adjustments.length, 1); assert.match(oldInv.adjustments[0].reason, /Chuyển sang/);
  assert.equal(B.credit(db, sid).free, 0, 'tiền không vừa nằm trong số dư vừa trả lớp mới');
  // buổi lớp cũ sau ngày chuyển không còn học sinh
  const late = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date = '2026-09-17'").get(a).id;
  assert.equal(A.sessionRoster(db, late).students.length, 0);
  moneyInvariant(db);
});

test('Bảo lưu và quay lại: lưu số buổi/giá trị còn lại, dừng phát sinh phí, không tính trùng tiền', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const p = classes.createClass(db, owner, { name: 'Kèm 1-1 gói 8 buổi', teacher_id: ctx.t1, room_id: ctx.room, start_date: '01/09/2026', fee_type: 'package', fee_amount: '100000', package_sessions: 8,
    excused_absence_charged: '0', unexcused_absence_charged: '1', slots: [{ weekday: 3, start_time: '17:00', end_time: '18:00' }, { weekday: 5, start_time: '17:00', end_time: '18:00' }] });
  const sid = students.createStudent(db, owner, { full_name: 'Vũ Bảo Ngọc' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: p, start_date: '01/09/2026' });
  assert.equal(r.invoice.amount, 800000); assert.equal(r.invoice.sessions_count, 8);
  B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '800000', method: 'cash', idempotency_key: 'x' });
  const sess = db.prepare("SELECT id, date FROM class_sessions WHERE class_id = ? ORDER BY date LIMIT 4").all(p);
  A.save(db, owner, sess[0].id, { items: [{ student_id: sid, status: 'present' }] });
  A.save(db, owner, sess[1].id, { items: [{ student_id: sid, status: 'excused' }] });   // vắng có phép: không trừ buổi
  A.save(db, owner, sess[2].id, { items: [{ student_id: sid, status: 'unexcused' }] }); // vắng không phép: trừ buổi
  A.save(db, owner, sess[3].id, { items: [{ student_id: sid, status: 'present' }] });
  const u = E.packageUsage(db, r.enrollment_id);
  assert.deepEqual([u.purchased, u.used, u.remaining], [8, 3, 5]);

  const res = E.reserve(db, owner, { enrollment_id: r.enrollment_id, start_date: '14/09/2026', expected_return_date: '01/10/2026', reason: 'Đi du lịch' });
  assert.equal(res.credit_amount, 500000); assert.equal(res.credit_sessions, 5);
  assert.equal(B.credit(db, sid).reserved, 500000);
  assert.equal(B.credit(db, sid).free, 0, 'tiền bảo lưu không dùng được cho việc khác');
  assert.equal(db.prepare('SELECT status FROM enrollments WHERE id = ?').get(r.enrollment_id).status, 'reserved');
  // không phát sinh học phí khi bảo lưu
  assert.equal(bulk.preview(db, { ym: '2026-10' }).items.filter((i) => i.student_id === sid).length, 0);

  const back = E.returnFromReservation(db, owner, { reservation_id: res.reservation_id, class_id: p, start_date: '05/10/2026' });
  assert.equal(back.neu.invoice.amount, 800000);
  assert.equal(back.neu.applied, 500000);
  assert.equal(back.neu.invoice.due, 300000);
  assert.deepEqual(B.credit(db, sid), { free: 0, reserved: 0 });
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(res.reservation_id).status, 'returned');
  // lịch sử lần đăng ký cũ giữ nguyên
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attendance WHERE enrollment_id = ?').get(r.enrollment_id).n, 4);
  moneyInvariant(db);
});

test('Giáo viên dạy thay được tính đúng số buổi thực tế; buổi chỉ lên lịch không được tính', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'HS A' });
  E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  const sess = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date LIKE '2026-09-%' ORDER BY date").all(cid);
  assert.equal(sess.length, 9);
  classes.updateSession(db, owner, sess[1].id, { teacher_id: ctx.t2, reason: 'GV An ốm' });
  for (const s of sess.slice(0, 4)) A.save(db, owner, s.id, { items: [{ student_id: sid, status: 'present' }] });
  const sum = TP.summary(db, '2026-09');
  const an = sum.find((x) => x.teacher.id === ctx.t1); const binh = sum.find((x) => x.teacher.id === ctx.t2);
  assert.equal(an.sessions, 3); assert.equal(an.amount, 600000);
  assert.equal(binh.sessions, 1); assert.equal(binh.substitute, 1); assert.equal(binh.amount, 250000);
  assert.equal(an.scheduledNotDone, 5, '5 buổi còn lại chỉ là lịch, chưa tính tiền');
  const id1 = TP.pay(db, owner, { teacher_id: ctx.t1, ym: '2026-09', idempotency_key: 'pay1' });
  const id2 = TP.pay(db, owner, { teacher_id: ctx.t1, ym: '2026-09', idempotency_key: 'pay1' });
  assert.equal(id1, id2);
  assert.throws(() => TP.pay(db, owner, { teacher_id: ctx.t1, ym: '2026-09', idempotency_key: 'pay2' }), /Đã chi/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cash_transactions WHERE category = 'teacher_pay'").get().n, 1);
});

test('Phân quyền: giáo viên không xem báo cáo, chỉ điểm danh lớp được phân công; nhân viên cần quyền để chi/hủy', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const c1 = monthlyClass(ctx);
  const c2 = classes.createClass(db, owner, { name: 'Tiếng Anh Flyers', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '500000',
    slots: [{ weekday: 6, start_time: '08:00', end_time: '09:00' }] });
  const tu = userOf(db, users.createUser(db, owner, { username: 'gvan', full_name: 'GV An', password: 'GiaoVien1', role: 'teacher', teacher_id: ctx.t1 }));
  const st = userOf(db, users.createUser(db, owner, { username: 'nhanvien', full_name: 'NV', password: 'NhanVien1', role: 'staff' }));
  assert.equal(perms.can.viewReports(tu), false);
  assert.equal(perms.can.viewReports(st), false);
  assert.equal(perms.can.viewReports(owner), true);
  const mine = db.prepare('SELECT id FROM class_sessions WHERE class_id = ? ORDER BY date LIMIT 1').get(c1).id;
  const other = db.prepare('SELECT id FROM class_sessions WHERE class_id = ? ORDER BY date LIMIT 1').get(c2).id;
  assert.doesNotThrow(() => A.save(db, tu, mine, { items: [] }));
  assert.throws(() => A.save(db, tu, other, { items: [] }), (e) => e.status === 403);
  assert.throws(() => B.recordReceipt(db, tu, { student_id: 1, amount: 1000, method: 'cash' }), (e) => e.status === 403);
  const cash = require('../src/services/cashbook');
  assert.throws(() => cash.create(db, st, { direction: 'out', category: 'rent', amount: '1000000' }), (e) => e.status === 403);
  db.prepare('UPDATE users SET perm_expense = 1 WHERE id = ?').run(st.id);
  assert.doesNotThrow(() => cash.create(db, userOf(db, st.id), { direction: 'out', category: 'rent', amount: '1000000' }));
});

test('Đổi lịch lặp: không sửa buổi đã hoàn thành; phát hiện trùng giờ giáo viên và phòng', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'HS B' });
  E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  const first = db.prepare('SELECT * FROM class_sessions WHERE class_id = ? ORDER BY date LIMIT 2').all(cid);
  A.save(db, owner, first[0].id, { items: [{ student_id: sid, status: 'present' }] });
  classes.changeSchedule(db, owner, cid, { effective_from: '01/09/2026', reason: 'Đổi sang T4/T6', slots: [{ weekday: 3, start_time: '18:00', end_time: '19:30' }, { weekday: 5, start_time: '18:00', end_time: '19:30' }] });
  const kept = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(first[0].id);
  assert.equal(kept.status, 'completed'); assert.equal(kept.date, '2026-09-01');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM class_sessions WHERE id = ?').get(first[1].id).n, 0, 'buổi chưa học theo lịch cũ được thay');
  const wd = db.prepare("SELECT DISTINCT strftime('%w', date) w FROM class_sessions WHERE class_id = ? AND date > '2026-09-01'").all(cid).map((r) => r.w).sort();
  assert.deepEqual(wd, ['3', '5']);
  // trùng giáo viên
  assert.throws(() => classes.createClass(db, owner, { name: 'Lớp trùng', teacher_id: ctx.t1, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '1',
    slots: [{ weekday: 3, start_time: '19:00', end_time: '20:00' }] }), (e) => e.status === 409 && e.conflicts.length > 0);
  // trùng phòng
  assert.throws(() => classes.createClass(db, owner, { name: 'Lớp trùng phòng', teacher_id: ctx.t2, room_id: ctx.room, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '1',
    slots: [{ weekday: 5, start_time: '17:00', end_time: '18:30' }] }), (e) => e.status === 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM classes WHERE name LIKE 'Lớp trùng%'").get().n, 0, 'không lưu khi trùng');
});

test('Miễn giảm có lý do và lịch sử; hủy phiếu thu không xóa dấu vết', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'HS C' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  assert.throws(() => B.adjustInvoice(db, owner, { invoice_id: r.invoice.id, delta: -100000, reason: '' }), /lý do/);
  B.adjustInvoice(db, owner, { invoice_id: r.invoice.id, delta: -100000, reason: 'Anh chị em giảm 100k' });
  const rc = B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '300000', method: 'cash', idempotency_key: 'v' });
  B.voidReceipt(db, owner, rc.id, 'Ghi nhầm số tiền');
  const inv = B.getInvoice(db, r.invoice.id);
  assert.equal(inv.paid, 0);
  assert.equal(inv.adjustments.length, 1);
  const rr = B.getReceipt(db, rc.id);
  assert.equal(rr.status, 'void'); assert.equal(rr.void_reason, 'Ghi nhầm số tiền');
  moneyInvariant(db);
});

test('Chính sách vắng theo cấu hình: lớp tháng "vắng có phép không tính phí" trừ vào tháng sau đúng một lần', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const cid = monthlyClass(ctx, { excused_absence_charged: '0' });
  const sid = students.createStudent(db, owner, { full_name: 'HS vắng' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  assert.equal(r.invoice.amount, 800000);
  const s = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date = '2026-09-03'").get(cid).id;
  A.save(db, owner, s, { items: [{ student_id: sid, status: 'excused' }] });
  const s2 = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date = '2026-09-08'").get(cid).id;
  A.save(db, owner, s2, { items: [{ student_id: sid, status: 'unexcused' }] }); // không phép: vẫn tính
  const oct = B.calcMonthly(db, B.getEnrollment(db, r.enrollment_id), B.getClassRow(db, cid), '2026-10');
  assert.equal(oct.deduction, 100000, '1 buổi có phép × 800.000/8');
  assert.equal(oct.base_amount, 700000);
  B.createTuitionInvoice(db, owner, { enrollment_id: r.enrollment_id, ym: '2026-10' });
  const nov = B.calcMonthly(db, B.getEnrollment(db, r.enrollment_id), B.getClassRow(db, cid), '2026-11');
  assert.equal(nov.deduction, 0, 'không trừ lặp lại');
});

test('Sao lưu JSON và khôi phục giữ nguyên dữ liệu (dùng trên Cloudflare)', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const backup = require('../src/services/backup');
  const cid = monthlyClass(ctx);
  const sid = students.createStudent(db, owner, { full_name: 'HS sao lưu' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  B.recordReceipt(db, owner, { invoice_id: r.invoice.id, amount: '300000', method: 'cash', idempotency_key: 'bk' });
  const data = JSON.parse(JSON.stringify(backup.exportData(db)));
  const db2 = setup().db;
  backup.importData(db2, data);
  for (const t of backup.TABLES) assert.equal(db2.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, t);
  assert.equal(B.balance(db2, r.invoice.id).due, 500000);
  assert.throws(() => backup.importData(db2, { app: 'khac' }), /không phải bản sao lưu/);
});
