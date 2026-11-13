'use strict';
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const audit = require('./audit');
const perms = require('./perms');
const classes = require('./classes');
const settings = require('./settings');

const STATUS = { present: 'Có mặt', excused: 'Vắng có phép', unexcused: 'Vắng không phép', unmarked: 'Chưa điểm danh' };

/** Danh sách học sinh của buổi: các đăng ký của lớp còn hiệu lực vào ngày học (kể cả người đã chuyển/nghỉ sau ngày đó) */
function sessionRoster(db, sessionId) {
  const s = classes.getSession(db, sessionId); assert(s, 'Không tìm thấy buổi học', 404);
  const rows = db.prepare(`SELECT e.id AS enrollment_id, e.status AS enrollment_status, st.id AS student_id, st.code, st.full_name, st.parent_phone,
      a.status, a.score, a.comment, a.updated_at
    FROM enrollments e JOIN students st ON st.id = e.student_id
    LEFT JOIN attendance a ON a.session_id = ? AND a.student_id = st.id
    WHERE e.class_id = ? AND e.status <> 'waiting' AND e.start_date <= ? AND (e.end_date IS NULL OR e.end_date >= ?)
    ORDER BY st.full_name`).all(sessionId, s.class_id, s.date, s.date);
  // học sinh đã có điểm danh nhưng không còn trong danh sách (ví dụ đăng ký đổi ngày) vẫn hiển thị để không mất dữ liệu
  const extra = db.prepare(`SELECT a.enrollment_id, e.status AS enrollment_status, st.id AS student_id, st.code, st.full_name, st.parent_phone, a.status, a.score, a.comment, a.updated_at
    FROM attendance a JOIN students st ON st.id = a.student_id JOIN enrollments e ON e.id = a.enrollment_id WHERE a.session_id = ?`).all(sessionId)
    .filter((x) => !rows.some((r) => r.student_id === x.student_id));
  return { session: s, students: rows.concat(extra).map((r) => ({ ...r, status: r.status || 'unmarked' })) };
}

/**
 * Lưu điểm danh (chỉ ghi khi người dùng bấm Lưu). complete=true: xác nhận buổi đã dạy xong, chốt đơn giá tiền dạy.
 * Giáo viên chỉ lưu được buổi thuộc lớp mình phụ trách hoặc mình dạy thay.
 */
function save(db, user, sessionId, { items = [], complete = true }) {
  perms.assertSessionAccess(db, user, sessionId);
  const { session: s, students } = sessionRoster(db, sessionId);
  assert(s.status !== 'cancelled', 'Buổi học đã hủy');
  const today = D.todayVN();
  assert(s.date <= today, 'Chưa đến ngày học, chưa thể điểm danh');
  const byStudent = new Map(students.map((x) => [x.student_id, x]));
  const up = db.prepare(`INSERT INTO attendance(session_id, enrollment_id, student_id, status, score, comment, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(session_id, student_id) DO UPDATE SET status = excluded.status, score = excluded.score, comment = excluded.comment,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  return db.transaction(() => {
    let changed = 0;
    for (const it of items) {
      const st = byStudent.get(Number(it.student_id));
      if (!st) continue; // không cho ghi học sinh ngoài lớp
      const status = STATUS[it.status] ? it.status : 'unmarked';
      let score = it.score === '' || it.score == null ? null : Number(String(it.score).replace(',', '.'));
      assert(score == null || (isFinite(score) && score >= 0 && score <= 100), `Điểm của ${st.full_name} không hợp lệ`);
      const comment = String(it.comment || '').trim().slice(0, 500) || null;
      if (st.status !== status || (st.score ?? null) !== score || (st.comment || null) !== comment) changed++;
      up.run(sessionId, st.enrollment_id, st.student_id, status, score, comment, user.id);
    }
    const unmarked = db.prepare("SELECT COUNT(*) n FROM attendance WHERE session_id = ? AND status = 'unmarked'").get(sessionId).n + Math.max(0, students.length - db.prepare('SELECT COUNT(*) n FROM attendance WHERE session_id = ?').get(sessionId).n);
    db.prepare("UPDATE class_sessions SET attendance_saved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(sessionId);
    if (complete && s.status === 'scheduled') {
      const rate = db.prepare('SELECT COALESCE(c.teacher_rate, t.default_rate, 0) r FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id WHERE s.id = ?').get(sessionId).r;
      db.prepare("UPDATE class_sessions SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), completed_by = ?, teacher_rate = ? WHERE id = ?").run(user.id, rate, sessionId);
      audit.log(db, user, 'session.complete', 'session', sessionId, null, { rate });
    }
    audit.log(db, user, 'attendance.save', 'session', sessionId, null, { changed });
    return { changed, unmarked };
  })();
}

/** Bỏ xác nhận hoàn thành (chủ/nhân viên) khi xác nhận nhầm – chỉ khi chưa chi tiền dạy tháng đó */
function reopen(db, user, sessionId, reason) {
  perms.require(user, 'manageClasses');
  const s = classes.getSession(db, sessionId); assert(s && s.status === 'completed', 'Buổi chưa được xác nhận hoàn thành');
  const paid = db.prepare("SELECT 1 FROM cash_transactions WHERE category = 'teacher_pay' AND status = 'valid' AND teacher_id = ? AND payout_month = ?").get(s.teacher_id, D.monthOf(s.date));
  assert(!paid, 'Đã chi tiền dạy tháng này cho giáo viên. Hãy hủy phiếu chi trước.');
  assert(String(reason || '').trim(), 'Vui lòng nhập lý do');
  db.prepare("UPDATE class_sessions SET status = 'scheduled', completed_at = NULL, completed_by = NULL, teacher_rate = NULL WHERE id = ?").run(sessionId);
  audit.log(db, user, 'session.reopen', 'session', sessionId, reason);
}

/** Buổi đã qua (hoặc đã kết thúc hôm nay) mà chưa hoàn tất điểm danh */
function pendingSessions(db, { teacherId = null, limit = 50 } = {}) {
  const today = D.todayVN(); const now = D.nowTimeVN();
  const args = [today, today, now];
  let extra = '';
  if (teacherId) { extra = 'AND (s.teacher_id = ? OR c.teacher_id = ?)'; args.push(teacherId, teacherId); }
  args.push(limit);
  return db.prepare(`SELECT s.*, c.name AS class_name, t.full_name AS teacher_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = s.class_id AND e.status <> 'waiting' AND e.start_date <= s.date AND (e.end_date IS NULL OR e.end_date >= s.date)) AS roster_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status <> 'unmarked') AS marked_count
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE s.status <> 'cancelled' AND (s.date < ? OR (s.date = ? AND s.end_time <= ?)) ${extra}
      AND (s.status = 'scheduled' OR (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status <> 'unmarked') <
           (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = s.class_id AND e.status <> 'waiting' AND e.start_date <= s.date AND (e.end_date IS NULL OR e.end_date >= s.date)))
    ORDER BY s.date DESC, s.start_time LIMIT ?`).all(...args).filter((s) => s.roster_count > 0 || s.status === 'scheduled');
}

/** Học sinh vắng nhiều trong 30 ngày gần nhất */
function frequentAbsences(db, { teacherId = null } = {}) {
  const n = settings.getInt(db, 'absence_alert_count') || 3;
  const from = D.addDays(D.todayVN(), -30);
  const args = [from]; let extra = '';
  if (teacherId) { extra = 'AND (s.teacher_id = ? OR c.teacher_id = ?)'; args.push(teacherId, teacherId); }
  args.push(n);
  return db.prepare(`SELECT st.id AS student_id, st.code, st.full_name, st.parent_phone, c.id AS class_id, c.name AS class_name,
      SUM(a.status = 'excused') AS excused, SUM(a.status = 'unexcused') AS unexcused, COUNT(*) AS absent, MAX(s.date) AS last_date
    FROM attendance a JOIN class_sessions s ON s.id = a.session_id JOIN classes c ON c.id = s.class_id JOIN students st ON st.id = a.student_id
    JOIN enrollments e ON e.id = a.enrollment_id
    WHERE a.status IN ('excused','unexcused') AND s.date >= ? AND e.status = 'active' ${extra}
    GROUP BY st.id, c.id HAVING COUNT(*) >= ? ORDER BY absent DESC`).all(...args);
}

function studentHistory(db, studentId, { classIds = null } = {}) {
  let rows = db.prepare(`SELECT a.*, s.date, s.start_time, s.class_id, c.name AS class_name FROM attendance a JOIN class_sessions s ON s.id = a.session_id
    JOIN classes c ON c.id = s.class_id WHERE a.student_id = ? ORDER BY s.date DESC, s.start_time DESC`).all(studentId);
  if (classIds) rows = rows.filter((r) => classIds.includes(r.class_id));
  const summary = {};
  for (const r of rows) {
    const k = r.class_name; summary[k] = summary[k] || { present: 0, excused: 0, unexcused: 0, unmarked: 0, scores: [] };
    summary[k][r.status]++;
    if (r.score != null) summary[k].scores.push(r.score);
  }
  return { rows, summary };
}

module.exports = { STATUS, sessionRoster, save, reopen, pendingSessions, frequentAbsences, studentHistory };
