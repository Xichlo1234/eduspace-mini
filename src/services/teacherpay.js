'use strict';
/**
 * Tiền dạy giáo viên: chỉ tính buổi đã được xác nhận hoàn thành, theo giáo viên thực tế đứng lớp (kể cả dạy thay).
 * Buổi mới lên lịch không bao giờ được tính là đã dạy.
 */
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const { vnd } = require('../lib/money');
const { nextCode } = require('../db');
const audit = require('./audit');
const perms = require('./perms');

function sessionsOf(db, teacherId, ym) {
  return db.prepare(`SELECT s.*, c.name AS class_name, c.teacher_id AS main_teacher_id, mt.full_name AS main_teacher_name
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers mt ON mt.id = c.teacher_id
    WHERE s.teacher_id = ? AND s.status = 'completed' AND s.date >= ? AND s.date <= ? ORDER BY s.date, s.start_time`)
    .all(teacherId, D.monthStart(ym), D.monthEnd(ym))
    .map((s) => ({ ...s, substitute: s.main_teacher_id !== s.teacher_id }));
}

function summary(db, ym) {
  const teachers = db.prepare('SELECT * FROM teachers ORDER BY full_name').all();
  return teachers.map((t) => {
    const sess = sessionsOf(db, t.id, ym);
    const scheduled = db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE teacher_id = ? AND status = 'scheduled' AND date >= ? AND date <= ?").get(t.id, D.monthStart(ym), D.monthEnd(ym)).n;
    const payout = db.prepare("SELECT * FROM cash_transactions WHERE category = 'teacher_pay' AND teacher_id = ? AND payout_month = ? AND status = 'valid'").get(t.id, ym);
    const amount = sess.reduce((a, s) => a + (s.teacher_rate || 0), 0);
    return { teacher: t, sessions: sess.length, substitute: sess.filter((s) => s.substitute).length, amount, scheduledNotDone: scheduled, payout, mismatch: payout ? payout.amount - amount : 0 };
  }).filter((r) => r.sessions || r.payout || r.scheduledNotDone || r.teacher.active);
}

/** Chủ trung tâm xác nhận chi tiền dạy tháng: mỗi giáo viên mỗi tháng đúng một giao dịch chi */
function pay(db, user, { teacher_id, ym, date, method, note, idempotency_key }) {
  perms.require(user, 'payTeachers', 'Chỉ chủ trung tâm xác nhận chi tiền dạy');
  assert(D.isValidMonth(ym), 'Tháng không hợp lệ');
  if (idempotency_key) { const ex = db.prepare('SELECT id FROM cash_transactions WHERE idempotency_key = ?').get(idempotency_key); if (ex) return ex.id; }
  const t = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacher_id); assert(t, 'Không tìm thấy giáo viên', 404);
  const sess = sessionsOf(db, t.id, ym);
  const amount = sess.reduce((a, s) => a + (s.teacher_rate || 0), 0);
  assert(sess.length > 0 && amount > 0, 'Không có buổi dạy đã xác nhận hoàn thành (hoặc đơn giá bằng 0) trong tháng này');
  const existing = db.prepare("SELECT id FROM cash_transactions WHERE category = 'teacher_pay' AND teacher_id = ? AND payout_month = ? AND status = 'valid'").get(t.id, ym);
  assert(!existing, `Đã chi tiền dạy tháng ${D.displayMonth(ym)} cho ${t.full_name}`);
  return db.transaction(() => {
    const code = nextCode(db, 'cash_out', 'PC', 6);
    const id = Number(db.prepare(`INSERT INTO cash_transactions(code, direction, date, amount, category, party, method, note, teacher_id, payout_month, idempotency_key, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, 'out', D.parseInput(date) || D.todayVN(), amount, 'teacher_pay', t.full_name, method === 'transfer' ? 'transfer' : 'cash',
      note || `Tiền dạy tháng ${D.displayMonth(ym)}: ${sess.length} buổi = ${vnd(amount)}`, t.id, ym, idempotency_key || null, user.id).lastInsertRowid);
    audit.log(db, user, 'teacher.pay', 'teacher', t.id, null, { ym, sessions: sess.length, amount, code });
    return id;
  })();
}

module.exports = { sessionsOf, summary, pay };
