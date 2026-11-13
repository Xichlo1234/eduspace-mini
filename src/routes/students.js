'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const students = require('../services/students');
const classes = require('../services/classes');
const catalog = require('../services/catalog');
const E = require('../services/enrollments');
const B = require('../services/billing');
const A = require('../services/attendance');
const perms = require('../services/perms');
const messages = require('../services/messages');
const excel = require('../services/excel');
const audit = require('../services/audit');
const { h, id, operator, tryForm } = require('./_util');

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const csrfMultipart = (req, res, next) => (req.body._csrf === req.user.csrf ? next() : next(new AppError('Phiên làm việc đã hết hạn, vui lòng tải lại trang', 403)));

r.get('/students', operator, h((req, res) => {
  const status = req.query.status || 'active';
  let list = students.search(req.db, { q: req.query.q || '', status: status === 'waiting' || status === 'reserved' ? 'active' : status, classId: req.query.class_id || null });
  if (status === 'waiting') list = list.filter((s) => s.waiting_count > 0);
  if (status === 'reserved') list = list.filter((s) => s.reserved_count > 0);
  res.page('students', { title: 'Học sinh', list, classes: classes.listClasses(req.db), status });
}));

r.get('/students/new', operator, (req, res) => {
  res.page('student_form', { title: 'Thêm học sinh', s: {}, dups: null });
});
r.post('/students', operator, h((req, res) => {
  const data = { title: 'Thêm học sinh', s: req.body, dups: null };
  if (!req.body.confirm_dup) {
    const dups = students.findPossibleDuplicates(req.db, { ...req.body, dob: D.parseInput(req.body.dob) });
    if (dups.length) return res.page('student_form', { ...data, dups });
  }
  const sid = tryForm(res, 'student_form', data, () => students.createStudent(req.db, req.user, req.body));
  if (!sid) return;
  req.flash('success', 'Đã tạo hồ sơ học sinh');
  res.redirect(303, req.body.then === 'enroll' ? `/students/${sid}/enroll` : `/students/${sid}`);
}));

r.get('/students/template.xlsx', operator, h(async (req, res) => {
  const buf = await excel.studentTemplate();
  res.attachment('mau-nhap-hoc-sinh.xlsx').type('xlsx').send(Buffer.from(buf));
}));
r.get('/students/export.xlsx', operator, h(async (req, res) => {
  const list = students.search(req.db, { status: 'all', limit: 100000 });
  const buf = await excel.workbook([{ name: 'Hoc sinh', rows: list, columns: [
    { header: 'Mã HS', key: 'code', width: 10 }, { header: 'Họ tên', key: 'full_name', width: 26 }, { header: 'Ngày sinh', key: 'dob', type: 'date', width: 12 },
    { header: 'Giới tính', key: 'gender', width: 9 }, { header: 'Phụ huynh', key: 'parent_name', width: 22 }, { header: 'SĐT phụ huynh', key: 'parent_phone', width: 14 },
    { header: 'Địa chỉ', key: 'address', width: 26 }, { header: 'Trình độ đầu vào', key: 'entry_level' }, { header: 'Lớp đang học', key: 'active_classes', width: 30 },
    { header: 'Trạng thái', key: 'status', value: (s) => (s.status === 'active' ? 'Đang theo dõi' : 'Ngừng'), width: 12 }, { header: 'Ghi chú', key: 'note', width: 30 }] }]);
  res.attachment(`hoc-sinh-${D.todayVN()}.xlsx`).type('xlsx').send(Buffer.from(buf));
}));

r.get('/students/import', operator, (req, res) => res.page('student_import', { title: 'Nhập học sinh từ Excel', preview: null, batch: null }));
r.post('/students/import', operator, upload.single('file'), csrfMultipart, h(async (req, res) => {
  if (!req.file) throw new AppError('Vui lòng chọn file Excel (.xlsx)');
  let rows;
  try { rows = await excel.parseStudentFile(req.file.buffer); } catch (e) { throw new AppError(e.status ? e.message : 'Không đọc được file. Vui lòng dùng file .xlsx theo mẫu.'); }
  if (!rows.length) throw new AppError('File không có dòng dữ liệu nào');
  if (rows.length > 1000) throw new AppError('Mỗi lần nhập tối đa 1000 dòng');
  const preview = students.validateImportRows(req.db, rows);
  const batch = crypto.randomBytes(12).toString('hex');
  req.db.prepare('INSERT INTO import_batches(id, data, user_id) VALUES (?,?,?)').run(batch, JSON.stringify({ rows }), req.user.id);
  res.page('student_import', { title: 'Xem trước dữ liệu nhập', preview, batch });
}));
r.post('/students/import/:batch/commit', operator, h((req, res) => {
  const out = students.commitImport(req.db, req.user, req.params.batch, { skipWarnings: req.body.skip_warnings === '1' });
  req.flash('success', `Đã tạo ${out.created} hồ sơ học sinh${out.skipped.length ? `; bỏ qua dòng ${out.skipped.join(', ')}` : ''}`);
  res.redirect(303, '/students');
}));

// Hồ sơ học sinh
r.get('/students/:id', h((req, res) => {
  const sid = id(req);
  if (!perms.canAccessStudent(req.db, req.user, sid)) throw new AppError('Bạn không có quyền xem học sinh này', 403);
  const s = students.getStudent(req.db, sid); if (!s) throw new AppError('Không tìm thấy học sinh', 404);
  const isOp = perms.isOperator(req.user);
  let enrollments = E.studentEnrollments(req.db, sid);
  let classIds = null;
  if (!isOp) { classIds = enrollments.filter((e) => perms.teacherCanAccessClass(req.db, req.user, e.class_id)).map((e) => e.class_id); enrollments = enrollments.filter((e) => classIds.includes(e.class_id)); }
  enrollments = enrollments.map((e) => ({ ...e, usage: E.packageUsage(req.db, e.id) }));
  const att = A.studentHistory(req.db, sid, { classIds });
  const data = { title: s.full_name, s, enrollments, att, siblings: students.siblings(req.db, s), STATUS: E.STATUS, ATT: A.STATUS, isOp };
  if (isOp) {
    Object.assign(data, {
      invoices: B.studentInvoices(req.db, sid), receipts: B.listReceipts(req.db, { studentId: sid }), credit: B.credit(req.db, sid), creditHistory: B.creditHistory(req.db, sid),
      reservations: E.listReservations(req.db, { status: null, studentId: sid }), contacts: messages.history(req.db, sid), events: E.events(req.db, sid),
      audit: audit.forEntity(req.db, 'student', sid),
    });
  }
  res.page('student', data);
}));
r.get('/students/:id/edit', operator, h((req, res) => {
  const s = students.getStudent(req.db, id(req)); if (!s) throw new AppError('Không tìm thấy học sinh', 404);
  res.page('student_form', { title: 'Sửa hồ sơ', s: { ...s, dob: D.display(s.dob) }, dups: null, editing: true });
}));
r.post('/students/:id', operator, h((req, res) => {
  const sid = id(req);
  const ok = tryForm(res, 'student_form', { title: 'Sửa hồ sơ', s: { ...req.body, id: sid }, dups: null, editing: true }, () => { students.updateStudent(req.db, req.user, sid, req.body); return true; });
  if (!ok) return;
  req.flash('success', 'Đã lưu hồ sơ');
  res.redirect(303, `/students/${sid}`);
}));

// Xếp lớp / đưa vào danh sách chờ (xem trước → xác nhận)
function enrollForm(req, extra = {}) {
  const sid = Number(req.params.id);
  const s = students.getStudent(req.db, sid); if (!s) throw new AppError('Không tìm thấy học sinh', 404);
  return { title: `Xếp lớp: ${s.full_name}`, s, classes: classes.listClasses(req.db), subjects: catalog.listSubjects(req.db), credit: B.credit(req.db, sid),
    v: { start_date: D.display(D.todayVN()), mode: 'active', ...req.query, ...req.body }, preview: null, FEE_TYPES: classes.FEE_TYPES, ...extra };
}
r.get('/students/:id/enroll', operator, h((req, res) => res.page('enroll', enrollForm(req))));
r.post('/students/:id/enroll', operator, h((req, res) => {
  const data = enrollForm(req);
  const input = { ...req.body, student_id: data.s.id, force: req.body.force === '1', dry: req.body.action !== 'confirm' };
  if (req.body.enrollment_id) input.enrollment_id = Number(req.body.enrollment_id);
  const out = tryForm(res, 'enroll', data, () => (input.enrollment_id && input.mode !== 'waiting' ? E.placeWaiting(req.db, req.user, input) : E.enroll(req.db, req.user, input)));
  if (!out) return;
  if (input.mode === 'waiting') { req.flash('success', 'Đã đưa vào danh sách chờ xếp lớp'); return res.redirect(303, `/students/${data.s.id}`); }
  if (out.dry) return res.page('enroll', { ...data, preview: out, cls: classes.getClass(req.db, Number(req.body.class_id)) });
  req.flash('success', `Đã xếp lớp${out.invoice ? ` – học phí ${out.invoice.period_label}: ${B.balance(req.db, out.invoice.id).due > 0 ? 'còn phải đóng ' + require('../lib/money').vnd(B.balance(req.db, out.invoice.id).due) : 'đã thanh toán đủ'}` : ''}`);
  res.redirect(303, out.invoice && B.balance(req.db, out.invoice.id).due > 0 ? `/payments/new?invoice_id=${out.invoice.id}` : `/students/${data.s.id}`);
}));

// Chuyển lớp
function enrollmentCtx(req) {
  const e = E.getEnrollment(req.db, id(req)); if (!e) throw new AppError('Không tìm thấy đăng ký', 404);
  return e;
}
r.get('/enrollments/:id/transfer', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  res.page('transfer', { title: 'Chuyển lớp', e, classes: classes.listClasses(req.db).filter((c) => c.id !== e.class_id), v: { effective_date: D.display(D.todayVN()) }, preview: null });
}));
r.post('/enrollments/:id/transfer', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  const data = { title: 'Chuyển lớp', e, classes: classes.listClasses(req.db).filter((c) => c.id !== e.class_id), v: req.body, preview: null };
  const out = tryForm(res, 'transfer', data, () => E.transfer(req.db, req.user, { ...req.body, enrollment_id: e.id, force: req.body.force === '1', dry: req.body.action !== 'confirm' }));
  if (!out) return;
  if (out.dry) return res.page('transfer', { ...data, preview: out });
  req.flash('success', `Đã chuyển sang lớp ${out.newClass.name}`);
  res.redirect(303, `/students/${e.student_id}`);
}));

// Bảo lưu
r.get('/enrollments/:id/reserve', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  res.page('reserve', { title: 'Bảo lưu', e, v: { start_date: D.display(D.todayVN()) }, preview: null });
}));
r.post('/enrollments/:id/reserve', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  const data = { title: 'Bảo lưu', e, v: req.body, preview: null };
  const out = tryForm(res, 'reserve', data, () => E.reserve(req.db, req.user, { ...req.body, enrollment_id: e.id, dry: req.body.action !== 'confirm' }));
  if (!out) return;
  if (out.dry) return res.page('reserve', { ...data, preview: out });
  req.flash('success', 'Đã bảo lưu');
  res.redirect(303, `/students/${e.student_id}`);
}));
r.get('/reservations/:id/return', operator, h((req, res) => {
  const rv = E.getReservation(req.db, id(req)); if (!rv) throw new AppError('Không tìm thấy bảo lưu', 404);
  res.page('return', { title: 'Quay lại sau bảo lưu', rv, classes: classes.listClasses(req.db), v: { class_id: rv.class_id, start_date: D.display(D.todayVN()) }, preview: null });
}));
r.post('/reservations/:id/return', operator, h((req, res) => {
  const rv = E.getReservation(req.db, id(req)); if (!rv) throw new AppError('Không tìm thấy bảo lưu', 404);
  const data = { title: 'Quay lại sau bảo lưu', rv, classes: classes.listClasses(req.db), v: req.body, preview: null };
  const out = tryForm(res, 'return', data, () => E.returnFromReservation(req.db, req.user, { ...req.body, reservation_id: rv.id, force: req.body.force === '1', dry: req.body.action !== 'confirm' }));
  if (!out) return;
  if (out.dry) return res.page('return', { ...data, preview: out });
  req.flash('success', 'Đã xếp lớp quay lại sau bảo lưu');
  res.redirect(303, `/students/${rv.student_id}`);
}));

// Nghỉ học / hoàn thành
r.get('/enrollments/:id/drop', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  res.page('drop', { title: 'Nghỉ học', e, v: { date: D.display(D.todayVN()), settle: '1' }, preview: null });
}));
r.post('/enrollments/:id/drop', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  const data = { title: 'Nghỉ học', e, v: req.body, preview: null };
  const out = tryForm(res, 'drop', data, () => E.drop(req.db, req.user, { ...req.body, enrollment_id: e.id, dry: req.body.action !== 'confirm' }));
  if (!out) return;
  if (out.dry) return res.page('drop', { ...data, preview: out });
  req.flash('success', 'Đã ghi nhận nghỉ học. Hồ sơ và lịch sử thu tiền được giữ nguyên.');
  res.redirect(303, `/students/${e.student_id}`);
}));
r.post('/enrollments/:id/complete', operator, h((req, res) => {
  const e = enrollmentCtx(req);
  E.complete(req.db, req.user, { enrollment_id: e.id, date: req.body.date });
  req.flash('success', 'Đã đánh dấu hoàn thành');
  res.redirect(303, `/students/${e.student_id}`);
}));

// Hoàn tiền trả trước
r.post('/students/:id/refund', operator, h((req, res) => {
  const sid = id(req);
  B.refundCredit(req.db, req.user, { student_id: sid, amount: req.body.amount, method: req.body.method, reason: req.body.reason, idempotency_key: req.body.idempotency_key });
  req.flash('success', 'Đã ghi nhận hoàn tiền (một phiếu chi)');
  res.redirect(303, `/students/${sid}`);
}));

module.exports = r;
