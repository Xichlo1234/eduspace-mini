'use strict';
const express = require('express');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const classes = require('../services/classes');
const catalog = require('../services/catalog');
const E = require('../services/enrollments');
const perms = require('../services/perms');
const audit = require('../services/audit');
const { h, id, need, tryForm, slotsFrom } = require('./_util');

const r = express.Router();
const manage = need('manageClasses');

function formData(req, extra = {}) {
  return { subjects: catalog.listSubjects(req.db), teachers: catalog.listTeachers(req.db), rooms: catalog.listRooms(req.db), FEE_TYPES: classes.FEE_TYPES, BILLING_TIMING: classes.BILLING_TIMING, ...extra };
}

r.get('/classes', h((req, res) => {
  const teacherId = perms.isTeacher(req.user) ? req.user.teacher_id : null;
  const status = req.query.status || 'active';
  const list = classes.listClasses(req.db, { status, teacherId }).map((c) => ({ ...c, schedule: classes.scheduleText(classes.currentSlots(req.db, c.id)) }));
  res.page('classes', { title: 'Lớp học', list, status, FEE_TYPES: classes.FEE_TYPES, BILLING_TIMING: classes.BILLING_TIMING });
}));

r.get('/classes/new', manage, (req, res) => {
  res.page('class_form', formData(req, { title: 'Tạo lớp mới', c: { start_date: D.display(D.todayVN()), fee_type: 'monthly', billing_timing: require('../services/settings').get(req.db, 'default_billing_timing'), prorate_first_month: 1, excused_absence_charged: 1, unexcused_absence_charged: 1 },
    slots: [{ weekday: '', start_time: '18:00', end_time: '19:30' }] }));
});
r.post('/classes', manage, h((req, res) => {
  const slots = slotsFrom(req.body);
  const data = formData(req, { title: 'Tạo lớp mới', c: req.body, slots: slots.length ? slots : [{}] });
  const cid = tryForm(res, 'class_form', data, () => classes.createClass(req.db, req.user, { ...req.body, slots, force: req.body.force === '1',
    prorate_first_month: req.body.prorate_first_month ? '1' : '0', excused_absence_charged: req.body.excused_absence_charged ? '1' : '0', unexcused_absence_charged: req.body.unexcused_absence_charged ? '1' : '0' }));
  if (!cid) return;
  const n = req.db.prepare('SELECT COUNT(*) n FROM class_sessions WHERE class_id = ?').get(cid).n;
  req.flash('success', `Đã tạo lớp và ${n} buổi học theo lịch. Tiếp theo: thêm học sinh vào lớp.`);
  res.redirect(303, `/classes/${cid}`);
}));

r.get('/classes/:id', h((req, res) => {
  const cid = id(req);
  perms.assertClassAccess(req.db, req.user, cid);
  const c = classes.getClass(req.db, cid); if (!c) throw new AppError('Không tìm thấy lớp', 404);
  const isOp = perms.isOperator(req.user);
  const roster = E.classRoster(req.db, cid).map((e) => ({ ...e, usage: E.packageUsage(req.db, e.id), due: isOp ? req.db.prepare(`SELECT COALESCE(SUM(i.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status='valid'),0)),0) s FROM invoices i WHERE i.enrollment_id = ? AND i.status='active'`).get(e.id).s : null }));
  const from = req.query.all ? '0000-00-00' : D.addDays(D.todayVN(), -30);
  const sessions = classes.listSessions(req.db, { from, to: '9999-12-31', classId: cid });
  res.page('class', {
    title: c.name, c, roster, sessions, BILLING_TIMING: classes.BILLING_TIMING, slots: classes.allSlots(req.db, cid), current: classes.currentSlots(req.db, cid), STATUS: E.STATUS, SSTATUS: classes.SESSION_STATUS,
    FEE_TYPES: classes.FEE_TYPES, isOp, waiting: isOp ? E.waitingList(req.db).filter((w) => !w.class_id || w.class_id === cid) : [],
    conflicts: isOp ? classes.classConflicts(req.db, cid, D.todayVN()) : [], stats: req.db.prepare(`SELECT COUNT(*) total, SUM(status='completed') done, SUM(status='cancelled') cancelled FROM class_sessions WHERE class_id = ?`).get(cid),
    history: isOp ? audit.forEntity(req.db, 'class', cid) : [],
  });
}));

r.get('/classes/:id/edit', manage, h((req, res) => {
  const c = classes.getClass(req.db, id(req)); if (!c) throw new AppError('Không tìm thấy lớp', 404);
  res.page('class_form', formData(req, { title: `Sửa lớp ${c.name}`, c: { ...c, start_date: D.display(c.start_date), end_date: D.display(c.end_date) }, editing: true,
    hasInvoices: !!req.db.prepare("SELECT 1 FROM invoices WHERE class_id = ? AND status = 'active'").get(c.id) }));
}));
r.post('/classes/:id', manage, h((req, res) => {
  const cid = id(req);
  const old = classes.getClass(req.db, cid);
  const data = formData(req, { title: `Sửa lớp ${old.name}`, c: { ...req.body, id: cid }, editing: true, hasInvoices: !!req.db.prepare("SELECT 1 FROM invoices WHERE class_id = ? AND status = 'active'").get(cid) });
  const ok = tryForm(res, 'class_form', data, () => { classes.updateClass(req.db, req.user, cid, { ...req.body, force: req.body.force === '1',
    prorate_first_month: req.body.prorate_first_month ? '1' : '0', excused_absence_charged: req.body.excused_absence_charged ? '1' : '0', unexcused_absence_charged: req.body.unexcused_absence_charged ? '1' : '0' }); return true; });
  if (!ok) return;
  req.flash('success', 'Đã lưu thông tin lớp. Mức phí mới áp dụng cho các khoản phải thu tạo sau thời điểm này.');
  res.redirect(303, `/classes/${cid}`);
}));
r.post('/classes/:id/status', manage, h((req, res) => {
  const cid = id(req); const st = req.body.status;
  if (!['active', 'finished', 'cancelled'].includes(st)) throw new AppError('Trạng thái không hợp lệ');
  if (st !== 'active' && req.db.prepare("SELECT 1 FROM enrollments WHERE class_id = ? AND status = 'active'").get(cid)) throw new AppError('Lớp còn học sinh đang học. Hãy chuyển hoặc đánh dấu hoàn thành cho học sinh trước.');
  req.db.prepare('UPDATE classes SET status = ? WHERE id = ?').run(st, cid);
  if (st !== 'active') req.db.prepare("DELETE FROM class_sessions WHERE class_id = ? AND status = 'scheduled' AND attendance_saved_at IS NULL AND date > ?").run(cid, D.todayVN());
  audit.log(req.db, req.user, 'class.status', 'class', cid, req.body.reason || null, { status: st });
  req.flash('success', 'Đã cập nhật trạng thái lớp');
  res.redirect(303, `/classes/${cid}`);
}));

r.get('/classes/:id/schedule', manage, h((req, res) => {
  const c = classes.getClass(req.db, id(req)); if (!c) throw new AppError('Không tìm thấy lớp', 404);
  res.page('class_schedule', { title: `Đổi lịch lớp ${c.name}`, c, slots: classes.currentSlots(req.db, c.id), v: { effective_from: D.display(D.todayVN()) } });
}));
r.post('/classes/:id/schedule', manage, h((req, res) => {
  const cid = id(req); const c = classes.getClass(req.db, cid);
  const slots = slotsFrom(req.body);
  const out = tryForm(res, 'class_schedule', { title: `Đổi lịch lớp ${c.name}`, c, slots, v: req.body }, () => classes.changeSchedule(req.db, req.user, cid, { slots, effective_from: req.body.effective_from, reason: req.body.reason, force: req.body.force === '1' }));
  if (!out) return;
  req.flash('success', `Đã đổi lịch: bỏ ${out.removed} buổi chưa học theo lịch cũ, tạo ${out.made} buổi theo lịch mới. Buổi đã hoàn thành giữ nguyên.`);
  res.redirect(303, `/classes/${cid}`);
}));
r.post('/classes/:id/sessions', manage, h((req, res) => {
  const cid = id(req);
  try { classes.addSession(req.db, req.user, cid, { ...req.body, force: req.body.force === '1' }); } catch (e) {
    if (e.conflicts) { req.flash('error', `${e.message}. Tick "Vẫn lưu" nếu chấp nhận.`); return res.redirect(303, `/classes/${cid}`); }
    throw e;
  }
  req.flash('success', 'Đã thêm buổi học');
  res.redirect(303, `/classes/${cid}`);
}));

// Danh sách chờ chung
r.get('/waiting', need('manageStudents'), h((req, res) => {
  res.page('waiting', { title: 'Danh sách chờ xếp lớp', list: E.waitingList(req.db), reservations: E.listReservations(req.db, { status: 'active' }) });
}));
r.post('/enrollments/:id/cancel-waiting', need('manageStudents'), h((req, res) => {
  const e = E.getEnrollment(req.db, id(req));
  if (!e || e.status !== 'waiting') throw new AppError('Đăng ký không ở trạng thái chờ');
  E.drop(req.db, req.user, { enrollment_id: e.id, reason: req.body.reason || 'Không còn nhu cầu', settle: '0' });
  req.flash('success', 'Đã xóa khỏi danh sách chờ (tiền cọc vẫn nằm trong tiền trả trước của học sinh)');
  res.redirect(303, '/waiting');
}));

module.exports = r;
