'use strict';
const express = require('express');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const dashboard = require('../services/dashboard');
const classes = require('../services/classes');
const catalog = require('../services/catalog');
const A = require('../services/attendance');
const perms = require('../services/perms');
const messages = require('../services/messages');
const { h, id, operator } = require('./_util');

const r = express.Router();

r.get('/', h((req, res) => {
  res.page('dashboard', { title: 'Tổng quan', d: dashboard.forUser(req.db, req.user) });
}));

// Lịch học theo tuần
r.get('/schedule', h((req, res) => {
  const base = D.parseInput(req.query.week) || D.todayVN();
  const monday = D.addDays(base, 1 - D.weekday(base));
  const days = Array.from({ length: 7 }, (_, i) => D.addDays(monday, i));
  const teacherId = perms.isTeacher(req.user) ? req.user.teacher_id : (req.query.teacher_id ? Number(req.query.teacher_id) : null);
  classes.extendAll(req.db, D.addDays(monday, 6));
  const sessions = classes.listSessions(req.db, { from: monday, to: days[6], teacherId, classId: req.query.class_id ? Number(req.query.class_id) : null });
  res.page('schedule', {
    title: 'Lịch học', days, monday, sessions, teachers: catalog.listTeachers(req.db), teacherId,
    prev: D.addDays(monday, -7), next: D.addDays(monday, 7),
  });
}));

// Buổi học: điểm danh + nhập điểm/nhận xét
r.get('/sessions/:id', h((req, res) => {
  const sid = id(req);
  perms.assertSessionAccess(req.db, req.user, sid);
  const { session, students } = A.sessionRoster(req.db, sid);
  res.page('session', {
    title: `Điểm danh ${session.class_name} ${D.display(session.date)}`, s: session, students, STATUS: A.STATUS,
    teachers: catalog.listTeachers(req.db), rooms: catalog.listRooms(req.db), canEdit: perms.can.manageClasses(req.user),
    canMark: session.date <= D.todayVN() && session.status !== 'cancelled',
  });
}));
r.post('/sessions/:id/attendance', h((req, res) => {
  const sid = id(req);
  const raw = req.body.items ? (Array.isArray(req.body.items) ? req.body.items : Object.values(req.body.items)) : [];
  const out = A.save(req.db, req.user, sid, { items: raw, complete: req.body.complete === '1' });
  req.flash('success', `Đã lưu điểm danh${req.body.complete === '1' ? ' và xác nhận buổi đã dạy' : ''}${out.unmarked ? ` – còn ${out.unmarked} học sinh chưa điểm danh` : ''}`);
  res.redirect(303, `/sessions/${sid}`);
}));
r.post('/sessions/:id/update', operator, h((req, res) => {
  const sid = id(req);
  try {
    classes.updateSession(req.db, req.user, sid, { ...req.body, force: req.body.force === '1' });
  } catch (e) {
    if (e.conflicts) { req.flash('error', `${e.message}: ${e.conflicts.map((c) => `${c.other.class_name} ${c.other.start_time}–${c.other.end_time} (${c.by})`).join('; ')}. Tick "Vẫn lưu" nếu chấp nhận.`); return res.redirect(303, `/sessions/${sid}`); }
    throw e;
  }
  req.flash('success', 'Đã cập nhật buổi học');
  res.redirect(303, `/sessions/${sid}`);
}));
r.post('/sessions/:id/cancel', operator, h((req, res) => {
  const sid = id(req);
  const out = classes.cancelSession(req.db, req.user, sid, { reason: req.body.reason });
  req.flash('success', `Đã hủy buổi học${out.makeup ? ' – đã thêm 1 buổi bù cuối khóa' : ''}`);
  res.redirect(303, `/sessions/${sid}`);
}));
r.post('/sessions/:id/restore', operator, h((req, res) => {
  classes.restoreSession(req.db, req.user, id(req));
  req.flash('success', 'Đã khôi phục buổi học');
  res.redirect(303, `/sessions/${id(req)}`);
}));
r.post('/sessions/:id/reopen', operator, h((req, res) => {
  A.reopen(req.db, req.user, id(req), req.body.reason);
  req.flash('success', 'Đã bỏ xác nhận hoàn thành buổi học');
  res.redirect(303, `/sessions/${id(req)}`);
}));

// Liên lạc phụ huynh
r.get('/messages/compose', h((req, res) => {
  const studentId = Number(req.query.student_id);
  if (!perms.canAccessStudent(req.db, req.user, studentId)) throw new AppError('Bạn không có quyền với học sinh này', 403);
  const type = req.query.type || 'fee';
  if (type === 'fee' && !perms.isOperator(req.user)) throw new AppError('Giáo viên không gửi nhắc học phí', 403);
  const msg = messages.build(req.db, { type, student_id: studentId, invoice_id: req.query.invoice_id ? Number(req.query.invoice_id) : null,
    session_id: req.query.session_id ? Number(req.query.session_id) : null, class_id: req.query.class_id ? Number(req.query.class_id) : null, change_text: req.query.change_text });
  res.page('message', { title: 'Soạn tin cho phụ huynh', msg, TEMPLATES: messages.TEMPLATES, zalo: messages.zaloLink(msg.student.parent_phone), q: req.query });
}));
r.post('/messages/log', h((req, res) => {
  const studentId = Number(req.body.student_id);
  if (!perms.canAccessStudent(req.db, req.user, studentId)) throw new AppError('Bạn không có quyền với học sinh này', 403);
  messages.markContacted(req.db, req.user, { student_id: studentId, template: req.body.template, content: req.body.content, channel: req.body.channel, note: req.body.note });
  req.flash('success', 'Đã ghi nhận: đã liên hệ phụ huynh');
  res.redirect(303, perms.isOperator(req.user) ? `/students/${studentId}#lien-lac` : '/');
}));

module.exports = r;
