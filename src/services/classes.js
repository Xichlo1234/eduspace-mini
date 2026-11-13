'use strict';
const D = require('../lib/dates');
const { AppError, assert } = require('../lib/errors');
const { mustMoney } = require('../lib/money');
const audit = require('./audit');

const HORIZON_DAYS = 120; // lớp không giới hạn số buổi: sinh sẵn lịch ~4 tháng tới, tự gia hạn
const FEE_TYPES = { monthly: 'Theo tháng', course: 'Theo khóa', package: 'Theo buổi / gói buổi' };
const BILLING_TIMING = { prepaid: 'Thu đầu kỳ (trả trước)', postpaid: 'Thu cuối kỳ (trả sau)' };
const SESSION_STATUS = { scheduled: 'Đã lên lịch', completed: 'Đã dạy xong', cancelled: 'Đã hủy' };

class ConflictError extends AppError {
  constructor(conflicts) {
    super(`Phát hiện ${conflicts.length} buổi trùng giờ giáo viên hoặc phòng học`, 409);
    this.conflicts = conflicts;
  }
}

function getClass(db, id) {
  return db.prepare(`SELECT c.*, s.name AS subject_name, t.full_name AS teacher_name, r.name AS room_name
    FROM classes c LEFT JOIN subjects s ON s.id = c.subject_id LEFT JOIN teachers t ON t.id = c.teacher_id
    LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id = ?`).get(id);
}

function listClasses(db, { status = 'active', teacherId = null } = {}) {
  const where = []; const args = [];
  if (status && status !== 'all') { where.push('c.status = ?'); args.push(status); }
  if (teacherId) { where.push('(c.teacher_id = ? OR EXISTS (SELECT 1 FROM class_sessions x WHERE x.class_id = c.id AND x.teacher_id = ?))'); args.push(teacherId, teacherId); }
  return db.prepare(`SELECT c.*, s.name AS subject_name, t.full_name AS teacher_name, r.name AS room_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') AS active_count,
      (SELECT COUNT(*) FROM class_sessions x WHERE x.class_id = c.id AND x.status <> 'cancelled') AS session_count,
      (SELECT COUNT(*) FROM class_sessions x WHERE x.class_id = c.id AND x.status = 'completed') AS done_count
    FROM classes c LEFT JOIN subjects s ON s.id = c.subject_id LEFT JOIN teachers t ON t.id = c.teacher_id
    LEFT JOIN rooms r ON r.id = c.room_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.name`).all(...args);
}

function currentSlots(db, classId, onDate = null) {
  const d = onDate || D.todayVN();
  return db.prepare(`SELECT * FROM class_schedules WHERE class_id = ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from, weekday, start_time`).all(classId, d);
}
function allSlots(db, classId) {
  return db.prepare('SELECT * FROM class_schedules WHERE class_id = ? ORDER BY effective_from, weekday, start_time').all(classId);
}
function scheduleText(slots) {
  return slots.map((s) => `${D.WEEKDAY_SHORT[s.weekday]} ${s.start_time}–${s.end_time}`).join(', ');
}

function normalizeSlots(slots) {
  assert(Array.isArray(slots) && slots.length > 0, 'Vui lòng chọn ít nhất một buổi học trong tuần');
  const out = [];
  for (const s of slots) {
    const weekday = parseInt(s.weekday, 10);
    assert(weekday >= 1 && weekday <= 7, 'Thứ trong tuần không hợp lệ');
    assert(D.isValidTime(s.start_time) && D.isValidTime(s.end_time), 'Giờ học không hợp lệ (định dạng HH:MM)');
    assert(D.timeToMin(s.end_time) > D.timeToMin(s.start_time), 'Giờ kết thúc phải sau giờ bắt đầu');
    out.push({ weekday, start_time: s.start_time, end_time: s.end_time });
  }
  return out;
}

function holidaySet(db) { return new Set(db.prepare('SELECT date FROM holidays').all().map((r) => r.date)); }

/**
 * Sinh buổi học từ lịch lặp.
 * - Bỏ qua ngày nghỉ.
 * - Không sinh lại khung lịch đã có (kể cả buổi đã hủy hoặc đã dời) nhờ cột origin.
 * - Lớp theo khóa (total_sessions): sinh tới khi đủ số buổi không bị hủy.
 * - Lớp mở: sinh tới end_date hoặc tới mốc horizon.
 */
function generateSessions(db, classId, { from = null, until = null } = {}) {
  const c = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!c || c.status !== 'active') return 0;
  const slots = allSlots(db, classId);
  if (!slots.length) return 0;
  const hol = holidaySet(db);
  const existing = new Set(db.prepare('SELECT origin FROM class_sessions WHERE class_id = ? AND origin IS NOT NULL').all(classId).map((r) => r.origin));
  const ins = db.prepare(`INSERT INTO class_sessions(class_id, date, start_time, end_time, teacher_id, room_id, origin, is_makeup)
    VALUES (?,?,?,?,?,?,?,?)`);
  const slotsOn = (d) => {
    const wd = D.weekday(d);
    return slots.filter((s) => s.weekday === wd && s.effective_from <= d && (!s.effective_to || s.effective_to >= d))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  };
  let made = 0;
  if (c.total_sessions) {
    let count = db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status <> 'cancelled'").get(classId).n;
    const hadCancelled = db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status = 'cancelled'").get(classId).n > 0;
    let d = D.maxDate(c.start_date, from);
    for (let guard = 0; count < c.total_sessions && guard < 3 * 366; guard++, d = D.addDays(d, 1)) {
      if (hol.has(d)) continue;
      for (const s of slotsOn(d)) {
        if (count >= c.total_sessions) break;
        const origin = `${d}|${s.start_time}`;
        if (existing.has(origin)) continue;
        ins.run(classId, d, s.start_time, s.end_time, c.teacher_id, c.room_id, origin, hadCancelled ? 1 : 0);
        existing.add(origin); count++; made++;
      }
    }
    if (count < c.total_sessions) throw new AppError('Không sinh đủ số buổi trong 3 năm – kiểm tra lại lịch học');
    return made;
  }
  const horizon = until || D.addDays(D.todayVN(), HORIZON_DAYS);
  const end = c.end_date ? D.minDate(c.end_date, horizon) : horizon;
  let d = D.maxDate(c.start_date, from || (c.generated_until ? D.addDays(c.generated_until, 1) : c.start_date));
  for (; d <= end; d = D.addDays(d, 1)) {
    if (hol.has(d)) continue;
    for (const s of slotsOn(d)) {
      const origin = `${d}|${s.start_time}`;
      if (existing.has(origin)) continue;
      ins.run(classId, d, s.start_time, s.end_time, c.teacher_id, c.room_id, origin, 0);
      existing.add(origin); made++;
    }
  }
  if (!c.generated_until || end > c.generated_until) db.prepare('UPDATE classes SET generated_until = ? WHERE id = ?').run(end, classId);
  return made;
}

/** Gia hạn lịch cho mọi lớp mở (gọi khi khởi động, mỗi ngày và trước khi tính học phí tháng tương lai) */
function extendAll(db, until = null) {
  const ids = db.prepare("SELECT id FROM classes WHERE status = 'active' AND total_sessions IS NULL").all();
  let n = 0;
  db.transaction(() => { for (const r of ids) n += generateSessions(db, r.id, { until }); })();
  return n;
}

/** Trùng giờ: cùng ngày, khoảng giờ giao nhau, cùng giáo viên hoặc cùng phòng */
function findConflicts(db, { date, start_time, end_time, teacher_id, room_id, excludeSessionId = null, excludeClassId = null }) {
  if (!teacher_id && !room_id) return [];
  return db.prepare(`SELECT s.*, c.name AS class_name, t.full_name AS teacher_name, r.name AS room_name
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.date = ? AND s.status <> 'cancelled' AND s.start_time < ? AND ? < s.end_time
      AND ((? IS NOT NULL AND s.teacher_id = ?) OR (? IS NOT NULL AND s.room_id = ?))
      AND s.id IS NOT ? AND s.class_id IS NOT ?`)
    .all(date, end_time, start_time, teacher_id || null, teacher_id || null, room_id || null, room_id || null, excludeSessionId, excludeClassId)
    .map((o) => ({ date, start_time, end_time, other: o, by: o.teacher_id && o.teacher_id === teacher_id ? 'Giáo viên' : 'Phòng học' }));
}
function classConflicts(db, classId, fromDate = null) {
  return db.prepare(`SELECT a.date, a.start_time, a.end_time, b.id AS other_id, oc.name AS other_class, b.start_time AS other_start, b.end_time AS other_end,
      CASE WHEN a.teacher_id IS NOT NULL AND a.teacher_id = b.teacher_id THEN 'Giáo viên' ELSE 'Phòng học' END AS by
    FROM class_sessions a JOIN class_sessions b ON b.date = a.date AND b.class_id <> a.class_id AND b.status <> 'cancelled'
      AND a.start_time < b.end_time AND b.start_time < a.end_time
      AND ((a.teacher_id IS NOT NULL AND a.teacher_id = b.teacher_id) OR (a.room_id IS NOT NULL AND a.room_id = b.room_id))
    JOIN classes oc ON oc.id = b.class_id
    WHERE a.class_id = ? AND a.status = 'scheduled' AND a.date >= ? ORDER BY a.date LIMIT 50`).all(classId, fromDate || '0000-00-00');
}

function readClassInput(db, input, existing = null) {
  const name = String(input.name || '').trim();
  assert(name, 'Vui lòng nhập tên lớp');
  const fee_type = input.fee_type || (existing && existing.fee_type);
  assert(FEE_TYPES[fee_type], 'Vui lòng chọn hình thức học phí');
  const start_date = D.parseInput(input.start_date) || (existing && existing.start_date);
  assert(start_date, 'Ngày bắt đầu không hợp lệ');
  const end_date = D.parseInput(input.end_date) || null;
  if (end_date) assert(end_date >= start_date, 'Ngày kết thúc phải sau ngày bắt đầu');
  const total_sessions = fee_type === 'course' ? parseInt(input.total_sessions, 10) : (input.total_sessions ? parseInt(input.total_sessions, 10) : null);
  if (fee_type === 'course') assert(total_sessions > 0, 'Lớp theo khóa cần nhập tổng số buổi của khóa');
  if (total_sessions != null) assert(Number.isInteger(total_sessions) && total_sessions > 0 && total_sessions <= 500, 'Tổng số buổi không hợp lệ');
  const fee_amount = mustMoney(input.fee_amount, fee_type === 'package' ? 'Đơn giá mỗi buổi' : 'Mức học phí', { allowZero: true });
  const billing_timing = input.billing_timing === 'postpaid' || input.billing_timing === 'prepaid' ? input.billing_timing
    : (existing ? existing.billing_timing : (require('./settings').get(db, 'default_billing_timing') === 'prepaid' ? 'prepaid' : 'postpaid'));
  const package_sessions = fee_type === 'package' && input.package_sessions ? parseInt(input.package_sessions, 10) || null : null;
  if (fee_type === 'package' && billing_timing === 'prepaid') assert(package_sessions > 0, 'Lớp gói thu đầu kỳ cần nhập số buổi mỗi gói');
  const bool = (v, dflt) => (v === undefined ? dflt : v === true || v === '1' || v === 'on' || v === 1 ? 1 : 0);
  const max_students = input.max_students ? parseInt(input.max_students, 10) || null : null;
  const teacher_rate = input.teacher_rate === '' || input.teacher_rate == null ? null : mustMoney(input.teacher_rate, 'Đơn giá tiền dạy', { allowZero: true });
  return {
    name, fee_type, start_date, end_date, total_sessions, fee_amount, package_sessions, max_students, teacher_rate,
    subject_id: require('./catalog').defaultSubjectId(db), // trung tâm chỉ dạy tiếng Anh
    teacher_id: input.teacher_id ? Number(input.teacher_id) : null,
    room_id: input.room_id ? Number(input.room_id) : null,
    billing_timing,
    prorate_first_month: bool(input.prorate_first_month, 1),
    excused_absence_charged: bool(input.excused_absence_charged, fee_type === 'package' ? 0 : 1),
    unexcused_absence_charged: bool(input.unexcused_absence_charged, 1),
    note: String(input.note || '').trim(),
  };
}

function createClass(db, user, input) {
  const v = readClassInput(db, input);
  const slots = normalizeSlots(input.slots);
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO classes(name, subject_id, teacher_id, room_id, max_students, start_date, end_date, total_sessions,
        fee_type, fee_amount, package_sessions, billing_timing, prorate_first_month, excused_absence_charged, unexcused_absence_charged, teacher_rate, note)
      VALUES (@name,@subject_id,@teacher_id,@room_id,@max_students,@start_date,@end_date,@total_sessions,@fee_type,@fee_amount,@package_sessions,@billing_timing,
        @prorate_first_month,@excused_absence_charged,@unexcused_absence_charged,@teacher_rate,@note)`).run(v).lastInsertRowid);
    const ins = db.prepare('INSERT INTO class_schedules(class_id, weekday, start_time, end_time, effective_from) VALUES (?,?,?,?,?)');
    for (const s of slots) ins.run(id, s.weekday, s.start_time, s.end_time, v.start_date);
    generateSessions(db, id);
    const conflicts = classConflicts(db, id);
    if (conflicts.length && !input.force) throw new ConflictError(conflicts);
    audit.log(db, user, 'class.create', 'class', id, null, { ...v, slots });
    return id;
  })();
}

function updateClass(db, user, id, input) {
  const old = getClass(db, id); assert(old, 'Không tìm thấy lớp', 404);
  const v = readClassInput(db, { ...old, ...input, start_date: input.start_date || old.start_date }, old);
  const invoiceCount = db.prepare("SELECT COUNT(*) n FROM invoices WHERE class_id = ? AND status = 'active'").get(id).n;
  if (v.billing_timing !== old.billing_timing) assert(invoiceCount === 0, 'Lớp đã phát sinh học phí nên không đổi được thời điểm thu (đầu kỳ/cuối kỳ), tránh tính trùng hoặc bỏ sót. Hãy tạo lớp mới hoặc chuyển lớp cho học sinh.');
  if (v.fee_type !== old.fee_type) assert(invoiceCount === 0, 'Lớp đã phát sinh học phí nên không đổi được hình thức học phí. Hãy tạo lớp mới hoặc chuyển lớp cho học sinh.');
  if (v.start_date !== old.start_date) assert(!db.prepare("SELECT 1 FROM class_sessions WHERE class_id = ? AND status = 'completed'").get(id), 'Lớp đã có buổi hoàn thành nên không đổi ngày bắt đầu');
  const applyFrom = D.parseInput(input.apply_from) || D.todayVN();
  return db.transaction(() => {
    if (old.total_sessions && v.total_sessions !== old.total_sessions) {
      const nonCancelled = db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status <> 'cancelled'").get(id).n;
      assert(v.total_sessions >= db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status = 'completed'").get(id).n, 'Tổng số buổi không được nhỏ hơn số buổi đã dạy');
      if (v.total_sessions < nonCancelled) {
        // bỏ các buổi cuối chưa diễn ra
        const extra = db.prepare(`SELECT id FROM class_sessions WHERE class_id = ? AND status = 'scheduled' AND attendance_saved_at IS NULL
          ORDER BY date DESC, start_time DESC LIMIT ?`).all(id, nonCancelled - v.total_sessions);
        for (const e of extra) db.prepare('DELETE FROM class_sessions WHERE id = ?').run(e.id);
      }
    }
    db.prepare(`UPDATE classes SET name=@name, subject_id=@subject_id, teacher_id=@teacher_id, room_id=@room_id, max_students=@max_students,
      start_date=@start_date, end_date=@end_date, total_sessions=@total_sessions, fee_type=@fee_type, fee_amount=@fee_amount,
      package_sessions=@package_sessions, billing_timing=@billing_timing, prorate_first_month=@prorate_first_month, excused_absence_charged=@excused_absence_charged,
      unexcused_absence_charged=@unexcused_absence_charged, teacher_rate=@teacher_rate, note=@note WHERE id=@id`).run({ ...v, id });
    if (v.teacher_id !== old.teacher_id) {
      db.prepare(`UPDATE class_sessions SET teacher_id = ? WHERE class_id = ? AND status = 'scheduled' AND date >= ? AND (teacher_id IS ? )`)
        .run(v.teacher_id, id, applyFrom, old.teacher_id);
    }
    if (v.room_id !== old.room_id) {
      db.prepare(`UPDATE class_sessions SET room_id = ? WHERE class_id = ? AND status = 'scheduled' AND date >= ? AND (room_id IS ?)`)
        .run(v.room_id, id, applyFrom, old.room_id);
    }
    if (v.end_date !== old.end_date && v.end_date) {
      db.prepare("DELETE FROM class_sessions WHERE class_id = ? AND status = 'scheduled' AND attendance_saved_at IS NULL AND date > ?").run(id, v.end_date);
    }
    generateSessions(db, id);
    const conflicts = classConflicts(db, id, applyFrom);
    if (conflicts.length && !input.force) throw new ConflictError(conflicts);
    const changes = {};
    for (const k of Object.keys(v)) if (String(v[k] ?? '') !== String(old[k] ?? '')) changes[k] = { from: old[k], to: v[k] };
    audit.log(db, user, 'class.update', 'class', id, input.reason || null, changes);
  })();
}

/** Đổi lịch lặp từ một ngày áp dụng. Không động vào buổi đã hoàn thành / đã điểm danh. */
function changeSchedule(db, user, classId, { slots, effective_from, reason, force }) {
  const c = getClass(db, classId); assert(c, 'Không tìm thấy lớp', 404);
  const from = D.parseInput(effective_from); assert(from, 'Ngày áp dụng không hợp lệ');
  slots = normalizeSlots(slots);
  return db.transaction(() => {
    db.prepare('DELETE FROM class_schedules WHERE class_id = ? AND effective_from >= ?').run(classId, from);
    db.prepare('UPDATE class_schedules SET effective_to = ? WHERE class_id = ? AND (effective_to IS NULL OR effective_to >= ?)').run(D.addDays(from, -1), classId, from);
    const ins = db.prepare('INSERT INTO class_schedules(class_id, weekday, start_time, end_time, effective_from) VALUES (?,?,?,?,?)');
    for (const s of slots) ins.run(classId, s.weekday, s.start_time, s.end_time, D.maxDate(from, c.start_date));
    const removed = db.prepare(`DELETE FROM class_sessions WHERE class_id = ? AND date >= ? AND status = 'scheduled' AND attendance_saved_at IS NULL`).run(classId, from).changes;
    const made = generateSessions(db, classId, { from });
    const conflicts = classConflicts(db, classId, from);
    if (conflicts.length && !force) throw new ConflictError(conflicts);
    audit.log(db, user, 'class.schedule', 'class', classId, reason, { from, slots, removed, made });
    return { removed, made };
  })();
}

function getSession(db, id) {
  return db.prepare(`SELECT s.*, c.name AS class_name, c.teacher_id AS main_teacher_id, c.fee_type, c.total_sessions,
      t.full_name AS teacher_name, mt.full_name AS main_teacher_name, r.name AS room_name
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id
    LEFT JOIN teachers mt ON mt.id = c.teacher_id LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = ?`).get(id);
}

function listSessions(db, { from, to, classId = null, teacherId = null, status = null } = {}) {
  const where = ['s.date >= ?', 's.date <= ?']; const args = [from, to];
  if (classId) { where.push('s.class_id = ?'); args.push(classId); }
  if (teacherId) { where.push('(s.teacher_id = ? OR (c.teacher_id = ? AND s.teacher_id IS NULL))'); args.push(teacherId, teacherId); }
  if (status) { where.push('s.status = ?'); args.push(status); }
  return db.prepare(`SELECT s.*, c.name AS class_name, c.teacher_id AS main_teacher_id, t.full_name AS teacher_name, r.name AS room_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = s.class_id AND e.status NOT IN ('waiting')
        AND e.start_date <= s.date AND (e.end_date IS NULL OR e.end_date >= s.date)) AS roster_count,
      (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'present') AS present_count
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teachers t ON t.id = s.teacher_id LEFT JOIN rooms r ON r.id = s.room_id
    WHERE ${where.join(' AND ')} ORDER BY s.date, s.start_time`).all(...args);
}

/** Đổi lịch / đổi giáo viên / đổi phòng cho một buổi */
function updateSession(db, user, id, input) {
  const s = getSession(db, id); assert(s, 'Không tìm thấy buổi học', 404);
  assert(s.status === 'scheduled', 'Chỉ sửa được buổi chưa hoàn thành và chưa hủy');
  const date = D.parseInput(input.date) || s.date;
  const start_time = input.start_time || s.start_time; const end_time = input.end_time || s.end_time;
  assert(D.isValidTime(start_time) && D.isValidTime(end_time) && end_time > start_time, 'Giờ học không hợp lệ');
  const teacher_id = input.teacher_id === undefined ? s.teacher_id : (input.teacher_id ? Number(input.teacher_id) : null);
  const room_id = input.room_id === undefined ? s.room_id : (input.room_id ? Number(input.room_id) : null);
  const conflicts = findConflicts(db, { date, start_time, end_time, teacher_id, room_id, excludeSessionId: id });
  if (conflicts.length && !input.force) throw new ConflictError(conflicts);
  db.transaction(() => {
    db.prepare('UPDATE class_sessions SET date=?, start_time=?, end_time=?, teacher_id=?, room_id=?, note=? WHERE id=?')
      .run(date, start_time, end_time, teacher_id, room_id, input.note != null ? String(input.note) : s.note, id);
    audit.log(db, user, 'session.update', 'session', id, input.reason || null,
      { from: { date: s.date, start_time: s.start_time, end_time: s.end_time, teacher_id: s.teacher_id, room_id: s.room_id }, to: { date, start_time, end_time, teacher_id, room_id } });
  })();
}

/** Hủy buổi. Lớp theo khóa tự thêm buổi bù cuối khóa để giữ đủ số buổi. */
function cancelSession(db, user, id, { reason }) {
  const s = getSession(db, id); assert(s, 'Không tìm thấy buổi học', 404);
  assert(s.status === 'scheduled', 'Buổi này đã hoàn thành hoặc đã hủy');
  assert(!s.attendance_saved_at, 'Buổi đã có điểm danh, không thể hủy');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do hủy buổi');
  return db.transaction(() => {
    db.prepare("UPDATE class_sessions SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(reason, id);
    const made = s.total_sessions ? generateSessions(db, s.class_id) : 0;
    audit.log(db, user, 'session.cancel', 'session', id, reason, { makeup: made });
    return { makeup: made };
  })();
}

/** Khôi phục buổi đã hủy (chỉ lớp không giới hạn số buổi, để tránh vượt tổng số buổi khóa) */
function restoreSession(db, user, id) {
  const s = getSession(db, id); assert(s && s.status === 'cancelled', 'Buổi này chưa bị hủy');
  assert(!s.total_sessions, 'Lớp theo khóa đã được thêm buổi bù, không khôi phục buổi đã hủy');
  db.prepare("UPDATE class_sessions SET status = 'scheduled', cancel_reason = NULL WHERE id = ?").run(id);
  audit.log(db, user, 'session.restore', 'session', id);
}

/** Thêm buổi học bổ sung (ngoài lịch lặp) */
function addSession(db, user, classId, input) {
  const c = getClass(db, classId); assert(c, 'Không tìm thấy lớp', 404);
  if (c.total_sessions) {
    const n = db.prepare("SELECT COUNT(*) n FROM class_sessions WHERE class_id = ? AND status <> 'cancelled'").get(classId).n;
    assert(n < c.total_sessions, 'Lớp đã đủ số buổi của khóa. Hãy tăng tổng số buổi nếu muốn thêm.');
  }
  const date = D.parseInput(input.date); assert(date, 'Ngày không hợp lệ');
  const { start_time, end_time } = input;
  assert(D.isValidTime(start_time) && D.isValidTime(end_time) && end_time > start_time, 'Giờ học không hợp lệ');
  const teacher_id = input.teacher_id ? Number(input.teacher_id) : c.teacher_id;
  const room_id = input.room_id ? Number(input.room_id) : c.room_id;
  const conflicts = findConflicts(db, { date, start_time, end_time, teacher_id, room_id });
  if (conflicts.length && !input.force) throw new ConflictError(conflicts);
  const id = db.prepare('INSERT INTO class_sessions(class_id, date, start_time, end_time, teacher_id, room_id, is_makeup, note) VALUES (?,?,?,?,?,?,1,?)')
    .run(classId, date, start_time, end_time, teacher_id, room_id, input.note || 'Buổi bổ sung').lastInsertRowid;
  audit.log(db, user, 'session.add', 'session', Number(id), input.reason || null);
  return Number(id);
}

// ---- Ngày nghỉ
function listHolidays(db) { return db.prepare('SELECT * FROM holidays ORDER BY date DESC').all(); }
/** Thêm ngày nghỉ: hủy buổi đã lên lịch (chưa điểm danh) trong ngày, lớp theo khóa được bù buổi */
function addHoliday(db, user, { date, name }) {
  date = D.parseInput(date); assert(date, 'Ngày nghỉ không hợp lệ');
  name = String(name || '').trim() || 'Ngày nghỉ';
  return db.transaction(() => {
    db.prepare('INSERT INTO holidays(date, name) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET name = excluded.name').run(date, name);
    const affected = db.prepare("SELECT s.id, s.class_id, c.total_sessions FROM class_sessions s JOIN classes c ON c.id = s.class_id WHERE s.date = ? AND s.status = 'scheduled' AND s.attendance_saved_at IS NULL").all(date);
    for (const a of affected) db.prepare("UPDATE class_sessions SET status = 'cancelled', cancel_reason = ? WHERE id = ?").run(`Nghỉ: ${name}`, a.id);
    let makeup = 0;
    for (const cid of new Set(affected.filter((a) => a.total_sessions).map((a) => a.class_id))) makeup += generateSessions(db, cid);
    audit.log(db, user, 'holiday.add', 'holiday', null, name, { date, cancelled: affected.length, makeup });
    return { cancelled: affected.length, makeup };
  })();
}
function removeHoliday(db, user, id) {
  const h = db.prepare('SELECT * FROM holidays WHERE id = ?').get(id);
  if (!h) return;
  db.prepare('DELETE FROM holidays WHERE id = ?').run(id);
  audit.log(db, user, 'holiday.remove', 'holiday', id, null, h);
}

module.exports = {
  FEE_TYPES, BILLING_TIMING, SESSION_STATUS, ConflictError, getClass, listClasses, currentSlots, allSlots, scheduleText, generateSessions, extendAll,
  findConflicts, classConflicts, createClass, updateClass, changeSchedule, getSession, listSessions, updateSession, cancelSession,
  restoreSession, addSession, listHolidays, addHoliday, removeHoliday,
};
