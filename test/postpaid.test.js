'use strict';
// Học phí THU CUỐI KỲ (trả sau): lập khoản phải thu sau khi học, không tính trùng khi chuyển lớp/bảo lưu/nghỉ.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const classes = require('../src/services/classes');
const students = require('../src/services/students');
const E = require('../src/services/enrollments');
const B = require('../src/services/billing');
const A = require('../src/services/attendance');
const bulk = require('../src/services/bulk');

function invariant(db) {
  const receipts = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE status='valid'").get().s;
  const alloc = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM allocations WHERE status='valid'").get().s;
  const credit = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_entries').get().s;
  assert.equal(receipts, alloc + credit);
}
// Thứ 3 & 5; tháng 9/2026 nghỉ 01/09 → 8 buổi: 3,8,10,15,17,22,24,29
function monthly(ctx, name, fee, extra = {}) {
  return classes.createClass(ctx.db, ctx.owner, { name, teacher_id: ctx.t1, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: fee, billing_timing: 'postpaid',
    slots: [{ weekday: 2, start_time: '18:00', end_time: '19:30' }, { weekday: 4, start_time: '18:00', end_time: '19:30' }], force: true, ...extra });
}

test('Lớp tháng thu cuối kỳ: xếp lớp chưa lập học phí; cuối tháng lập 400.000đ (4/8 buổi), trừ đặt cọc, hạn ngày 5 tháng sau', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const cid = monthly(ctx, 'Anh văn trả sau', '800000');
  const sid = students.createStudent(db, owner, { full_name: 'HS trả sau' });
  B.recordReceipt(db, owner, { student_id: sid, amount: '500000', method: 'cash', paid_date: '15/09/2026', idempotency_key: 'dep' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '17/09/2026' });
  assert.equal(r.invoice, null); assert.equal(r.postpaid, true);
  assert.equal(r.estimate.base_amount, 400000, 'chỉ hiển thị dự tính');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
  assert.equal(B.credit(db, sid).free, 500000, 'tiền cọc chưa bị trừ khi chưa lập học phí');

  const p = bulk.preview(db, { ym: '2026-10', ymPost: '2026-09' });
  const mine = p.items.filter((i) => i.student_id === sid);
  assert.equal(mine.length, 1); assert.equal(mine[0].timing, 'postpaid'); assert.equal(mine[0].amount, 400000); assert.equal(mine[0].period_key, '2026-09');
  const c1 = bulk.commit(db, owner, { ym: '2026-10', ymPost: '2026-09', keys: mine.map((i) => i.key) });
  const c2 = bulk.commit(db, owner, { ym: '2026-10', ymPost: '2026-09', keys: mine.map((i) => i.key) });
  assert.equal(c1.created, 1); assert.equal(c2.created, 0);
  const inv = db.prepare("SELECT * FROM invoices WHERE period_key = '2026-09'").get();
  assert.equal(inv.amount, 400000);
  const D = require('../src/lib/dates');
  assert.equal(inv.due_date, D.maxDate('2026-10-05', D.todayVN()), 'ngày 5 tháng sau (không sớm hơn ngày lập)');
  assert.equal(B.balance(db, inv.id).due, 0, 'trừ 400.000đ tiền cọc');
  assert.equal(B.credit(db, sid).free, 100000);
  // lớp trả sau không bị lập học phí tháng 10 khi chạy "thu đầu kỳ" cho tháng 10
  assert.equal(bulk.preview(db, { ym: '2026-10', ymPost: '2026-08' }).items.filter((i) => i.student_id === sid).length, 0);
  invariant(db);
});

test('Lớp theo buổi thu cuối kỳ: tính theo số buổi thực học, vắng theo cấu hình', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = classes.createClass(db, owner, { name: 'Piano trả sau', teacher_id: ctx.t2, start_date: '01/09/2026', fee_type: 'package', fee_amount: '100000', billing_timing: 'postpaid',
    excused_absence_charged: '0', unexcused_absence_charged: '1', slots: [{ weekday: 3, start_time: '17:00', end_time: '18:00' }, { weekday: 5, start_time: '17:00', end_time: '18:00' }] });
  const sid = students.createStudent(db, owner, { full_name: 'HS piano' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '01/09/2026' });
  assert.equal(r.invoice, null);
  const sess = db.prepare("SELECT id FROM class_sessions WHERE class_id = ? AND date LIKE '2026-09-%' ORDER BY date").all(cid);
  const marks = ['present', 'present', 'present', 'excused', 'unexcused'];
  marks.forEach((m, i) => A.save(db, owner, sess[i].id, { items: [{ student_id: sid, status: m }] }));
  const c = B.calcPackageUsage(db, B.getEnrollment(db, r.enrollment_id), B.getClassRow(db, cid), '2026-09');
  assert.equal(c.sessions_count, 4, '3 có mặt + 1 vắng không phép; vắng có phép không tính');
  assert.equal(c.base_amount, 400000);
  const u = E.packageUsage(db, r.enrollment_id);
  assert.equal(u.postpaid, true); assert.equal(u.used, 4); assert.equal(u.unbilled, 4);
  const p = bulk.preview(db, { ym: '2026-10', ymPost: '2026-09' });
  bulk.commit(db, owner, { ym: '2026-10', ymPost: '2026-09', keys: p.items.map((i) => i.key) });
  assert.equal(E.packageUsage(db, r.enrollment_id).unbilled, 0);
});

test('Chuyển lớp khi thu cuối kỳ: lập học phí phần đã học ở lớp cũ, lớp mới tính từ ngày chuyển, không tính trùng', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const a = monthly(ctx, 'Lớp A', '800000');
  const b = classes.createClass(db, owner, { name: 'Lớp B', teacher_id: ctx.t2, room_id: ctx.room2, start_date: '01/09/2026', fee_type: 'monthly', fee_amount: '1000000', billing_timing: 'postpaid',
    slots: [{ weekday: 2, start_time: '18:00', end_time: '19:30' }, { weekday: 4, start_time: '18:00', end_time: '19:30' }] });
  const sid = students.createStudent(db, owner, { full_name: 'HS chuyển' });
  const r = E.enroll(db, owner, { student_id: sid, class_id: a, start_date: '01/09/2026' });
  const pv = E.transfer(db, owner, { enrollment_id: r.enrollment_id, new_class_id: b, effective_date: '17/09/2026', dry: true });
  assert.equal(pv.old.stmt.incurred, 400000); assert.equal(pv.neu.invoice, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'xem trước không ghi');
  E.transfer(db, owner, { enrollment_id: r.enrollment_id, new_class_id: b, effective_date: '17/09/2026' });
  const oldInv = db.prepare('SELECT * FROM invoices WHERE enrollment_id = ?').all(r.enrollment_id);
  assert.equal(oldInv.length, 1); assert.equal(oldInv[0].amount, 400000);
  const p = bulk.preview(db, { ym: '2026-10', ymPost: '2026-09' });
  const items = p.items.filter((i) => i.student_id === sid);
  assert.equal(items.length, 1, 'chỉ lớp mới, lớp cũ đã lập khi chuyển');
  assert.equal(items[0].class_name, 'Lớp B'); assert.equal(items[0].amount, 500000);
  bulk.commit(db, owner, { ym: '2026-10', ymPost: '2026-09', keys: items.map((i) => i.key) });
  assert.equal(db.prepare("SELECT SUM(amount) s FROM invoices WHERE student_id = ? AND status = 'active'").get(sid).s, 900000);
  invariant(db);
});

test('Bảo lưu / nghỉ học khi thu cuối kỳ: lập học phí phần đã học; không có giá trị trả trước để giữ', () => {
  const ctx = setup(); const { db, owner } = ctx;
  classes.addHoliday(db, owner, { date: '01/09/2026', name: 'Nghỉ' });
  const a = monthly(ctx, 'Lớp C', '800000');
  const s1 = students.createStudent(db, owner, { full_name: 'HS bảo lưu' });
  const s2 = students.createStudent(db, owner, { full_name: 'HS nghỉ' });
  const r1 = E.enroll(db, owner, { student_id: s1, class_id: a, start_date: '01/09/2026' });
  const r2 = E.enroll(db, owner, { student_id: s2, class_id: a, start_date: '01/09/2026' });
  const res = E.reserve(db, owner, { enrollment_id: r1.enrollment_id, start_date: '22/09/2026', reason: 'Ốm' });
  assert.equal(res.credit_amount, 0);
  assert.equal(db.prepare('SELECT amount FROM invoices WHERE enrollment_id = ?').get(r1.enrollment_id).amount, 500000, '5/8 buổi');
  E.drop(db, owner, { enrollment_id: r2.enrollment_id, date: '10/09/2026', reason: 'Chuyển nhà', settle: '0' });
  assert.equal(db.prepare('SELECT amount FROM invoices WHERE enrollment_id = ?').get(r2.enrollment_id).amount, 200000, '2/8 buổi đã học vẫn phải thu');
  const p = bulk.preview(db, { ym: '2026-10', ymPost: '2026-09' });
  assert.equal(p.items.filter((i) => [s1, s2].includes(i.student_id)).length, 0, 'không lập lại');
});

test('Lớp khóa thu cuối kỳ: chỉ đề xuất học phí khi khóa đã kết thúc', () => {
  const ctx = setup(); const { db, owner } = ctx;
  const cid = classes.createClass(db, owner, { name: 'Khóa 8 buổi', teacher_id: ctx.t2, start_date: '07/09/2026', fee_type: 'course', fee_amount: '2400000', total_sessions: 8, billing_timing: 'postpaid',
    slots: [{ weekday: 1, start_time: '08:00', end_time: '09:00' }, { weekday: 3, start_time: '08:00', end_time: '09:00' }] });
  const sid = students.createStudent(db, owner, { full_name: 'HS khóa' });
  E.enroll(db, owner, { student_id: sid, class_id: cid, start_date: '07/09/2026' });
  // khóa kết thúc 30/09
  assert.equal(bulk.preview(db, { ym: '2026-10', ymPost: '2026-08' }).items.length, 0);
  const p = bulk.preview(db, { ym: '2026-10', ymPost: '2026-09' });
  assert.equal(p.items.length, 1); assert.equal(p.items[0].amount, 2400000);
  bulk.commit(db, owner, { ym: '2026-10', ymPost: '2026-09', keys: p.items.map((i) => i.key) });
  const inv = db.prepare("SELECT * FROM invoices WHERE period_key = 'COURSE'").get();
  assert.ok(inv.due_date >= '2026-09-30');
});
