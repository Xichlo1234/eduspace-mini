'use strict';
const D = require('../lib/dates');
const perms = require('./perms');
const classes = require('./classes');
const A = require('./attendance');
const B = require('./billing');
const E = require('./enrollments');
const reports = require('./reports');
const settings = require('./settings');

function setupChecklist(db) {
  const s = settings.getAll(db);
  const n = (sql) => db.prepare(sql).get().n;
  const steps = [
    { key: 'center', label: 'Nhập tên & thông tin trung tâm', done: s.center_name !== settings.DEFAULTS.center_name, href: '/settings' },
    { key: 'teacher', label: 'Thêm giáo viên (có thể là chính bạn)', done: n('SELECT COUNT(*) n FROM teachers') > 0, href: '/teachers' },
    { key: 'holiday', label: 'Khai báo ngày nghỉ, ngày lễ', done: n('SELECT COUNT(*) n FROM holidays') > 0, href: '/settings/holidays', optional: true },
    { key: 'class', label: 'Tạo lớp đầu tiên', done: n('SELECT COUNT(*) n FROM classes') > 0, href: '/classes/new' },
    { key: 'student', label: 'Thêm học sinh và xếp lớp', done: n("SELECT COUNT(*) n FROM enrollments WHERE status = 'active'") > 0, href: '/students/new' },
  ];
  return { steps, done: steps.filter((x) => !x.optional).every((x) => x.done) };
}

function forUser(db, user) {
  const today = D.todayVN();
  const teacherId = perms.isTeacher(user) ? user.teacher_id : null;
  classes.extendAll(db);
  const todaySessions = classes.listSessions(db, { from: today, to: today, teacherId });
  const upcoming = classes.listSessions(db, { from: D.addDays(today, 1), to: D.addDays(today, 2), teacherId });
  const pending = A.pendingSessions(db, { teacherId, limit: 30 });
  const absences = A.frequentAbsences(db, { teacherId });
  const out = { today, todaySessions, upcoming, pending, absences };
  if (perms.isOperator(user)) {
    const soon = D.addDays(today, 3);
    out.dueInvoices = B.listInvoices(db, { status: 'open' }).filter((i) => i.due_date && i.due_date <= soon);
    out.waiting = E.waitingList(db);
    const low = settings.getInt(db, 'package_low_threshold');
    out.lowPackages = db.prepare(`SELECT e.id, e.student_id, s.full_name, s.code, c.name AS class_name FROM enrollments e JOIN students s ON s.id = e.student_id
      JOIN classes c ON c.id = e.class_id WHERE e.status = 'active' AND c.fee_type = 'package' AND c.billing_timing = 'prepaid'`).all()
      .map((r) => ({ ...r, usage: E.packageUsage(db, r.id) })).filter((r) => r.usage && r.usage.remaining <= low);
    const rd = settings.getInt(db, 'reservation_alert_days');
    out.reservations = E.listReservations(db, { status: 'active' }).filter((r) => r.expected_return_date && r.expected_return_date <= D.addDays(today, rd));
    out.setup = setupChecklist(db);
    // nhắc kỳ thu cuối tháng cho lớp thu cuối kỳ (từ ngày 25 đến ngày 10 tháng sau)
    const day = Number(today.slice(8, 10));
    if ((day >= 25 || day <= 10) && db.prepare("SELECT 1 FROM classes WHERE billing_timing = 'postpaid' AND status <> 'cancelled'").get()) {
      const bulk = require('./bulk');
      const ymPost = bulk.defaultPostMonth(today);
      const p = bulk.preview(db, { ym: D.nextMonth(D.monthOf(today)), ymPost });
      const post = p.items.filter((i) => i.timing === 'postpaid');
      if (post.length) out.postpaidDue = { ymPost, count: post.length, total: post.reduce((a, i) => a + i.amount, 0) };
    }
  }
  if (perms.can.viewReports(user)) {
    const ym = D.monthOf(today);
    out.finance = reports.finance(db, { from: D.monthStart(ym), to: today });
  }
  return out;
}

module.exports = { forUser, setupChecklist };
