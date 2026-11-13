'use strict';
const express = require('express');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const catalog = require('../services/catalog');
const classes = require('../services/classes');
const TP = require('../services/teacherpay');
const perms = require('../services/perms');
const excel = require('../services/excel');
const { h, id, need, tryForm } = require('./_util');

const r = express.Router();
const manage = need('manageClasses');
const money = need('viewReports');

r.get('/teachers', h((req, res) => {
  if (perms.isTeacher(req.user)) return res.redirect(`/teachers/${req.user.teacher_id}`);
  const list = catalog.listTeachers(req.db, true).map((t) => ({ ...t, classes: classes.listClasses(req.db, { teacherId: t.id }).filter((c) => c.teacher_id === t.id) }));
  res.page('teachers', { title: 'Giáo viên', list });
}));
r.get('/teachers/new', manage, (req, res) => res.page('teacher_form', { title: 'Thêm giáo viên', t: {} }));
r.post('/teachers', manage, h((req, res) => {
  const tid = tryForm(res, 'teacher_form', { title: 'Thêm giáo viên', t: req.body }, () => catalog.saveTeacher(req.db, req.user, req.body));
  if (!tid) return;
  req.flash('success', 'Đã thêm giáo viên');
  res.redirect(303, req.body.back || '/teachers');
}));

// Tiền dạy theo tháng
r.get('/teachers/pay', money, h((req, res) => {
  const ym = D.isValidMonth(req.query.ym) ? req.query.ym : D.monthOf(D.todayVN());
  res.page('teacher_pay', { title: 'Tiền dạy giáo viên', ym, rows: TP.summary(req.db, ym) });
}));
r.get('/teachers/pay.xlsx', money, h(async (req, res) => {
  const ym = D.isValidMonth(req.query.ym) ? req.query.ym : D.monthOf(D.todayVN());
  const rows = []; for (const t of catalog.listTeachers(req.db, true)) for (const s of TP.sessionsOf(req.db, t.id, ym)) rows.push({ ...s, teacher: t.full_name });
  const buf = await excel.workbook([{ name: `Tien day ${ym}`, rows, columns: [
    { header: 'Giáo viên', key: 'teacher', width: 22 }, { header: 'Ngày', key: 'date', type: 'date', width: 12 }, { header: 'Giờ', key: 'start_time', value: (s) => `${s.start_time}-${s.end_time}` },
    { header: 'Lớp', key: 'class_name', width: 24 }, { header: 'Dạy thay', key: 'substitute', value: (s) => (s.substitute ? `Thay ${s.main_teacher_name || ''}` : '') , width: 20 },
    { header: 'Đơn giá', key: 'teacher_rate', type: 'money', width: 14 }] }]);
  res.attachment(`tien-day-${ym}.xlsx`).type('xlsx').send(Buffer.from(buf));
}));
r.post('/teachers/:id/pay', need('payTeachers'), h((req, res) => {
  TP.pay(req.db, req.user, { teacher_id: id(req), ym: req.body.ym, date: req.body.date, method: req.body.method, idempotency_key: req.body.idempotency_key });
  req.flash('success', 'Đã ghi nhận chi tiền dạy (một giao dịch chi)');
  res.redirect(303, `/teachers/pay?ym=${req.body.ym}`);
}));

r.get('/teachers/:id', h((req, res) => {
  const tid = id(req);
  if (perms.isTeacher(req.user) && req.user.teacher_id !== tid) throw new AppError('Bạn chỉ xem được thông tin của mình', 403);
  const t = catalog.getTeacher(req.db, tid); if (!t) throw new AppError('Không tìm thấy giáo viên', 404);
  const ym = D.isValidMonth(req.query.ym) ? req.query.ym : D.monthOf(D.todayVN());
  const showMoney = perms.can.viewReports(req.user) || (perms.isTeacher(req.user) && req.user.teacher_id === tid);
  res.page('teacher', {
    title: t.full_name, t, ym, sessions: TP.sessionsOf(req.db, tid, ym), showMoney, isOp: perms.isOperator(req.user),
    upcoming: classes.listSessions(req.db, { from: D.todayVN(), to: D.addDays(D.todayVN(), 13), teacherId: tid }),
    classList: classes.listClasses(req.db, { teacherId: tid }),
  });
}));
r.get('/teachers/:id/edit', manage, h((req, res) => {
  const t = catalog.getTeacher(req.db, id(req)); if (!t) throw new AppError('Không tìm thấy giáo viên', 404);
  res.page('teacher_form', { title: 'Sửa giáo viên', t });
}));
r.post('/teachers/:id', manage, h((req, res) => {
  const tid = id(req);
  const ok = tryForm(res, 'teacher_form', { title: 'Sửa giáo viên', t: { ...req.body, id: tid } }, () => catalog.saveTeacher(req.db, req.user, { ...req.body, id: tid, active: req.body.active ? '1' : '0' }));
  if (!ok) return;
  req.flash('success', 'Đã lưu. Đơn giá mới áp dụng cho các buổi xác nhận hoàn thành sau thời điểm này.');
  res.redirect(303, `/teachers/${tid}`);
}));

module.exports = r;
