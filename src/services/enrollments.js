'use strict';
/**
 * Đăng ký lớp: xếp lớp, danh sách chờ, chuyển lớp, bảo lưu, quay lại, nghỉ học, hoàn thành.
 * Các thao tác có tiền đều có chế độ xem trước (dry run) chạy đúng logic thật rồi hoàn tác,
 * nên bảng tính người dùng xác nhận trùng khớp với kết quả ghi sổ.
 */
const D = require('../lib/dates');
const { AppError, assert } = require('../lib/errors');
const { vnd } = require('../lib/money');
const audit = require('./audit');
const perms = require('./perms');
const B = require('./billing');
const settings = require('./settings');

const STATUS = { waiting: 'Chờ xếp lớp', active: 'Đang học', reserved: 'Bảo lưu', completed: 'Hoàn thành', dropped: 'Nghỉ học', transferred: 'Đã chuyển' };

class DryRun extends Error { constructor(result) { super('dry-run'); this.result = result; } }
function runMaybeDry(db, dry, fn) {
  try {
    return db.transaction(() => { const r = fn(); if (dry) throw new DryRun(r); return r; })();
  } catch (e) { if (e instanceof DryRun) return { ...e.result, dry: true }; throw e; }
}

function event(db, user, enrollmentId, type, from, to, date, reason, data) {
  db.prepare('INSERT INTO enrollment_events(enrollment_id, type, from_status, to_status, date, reason, data, user_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(enrollmentId, type, from || null, to || null, date || null, reason || null, data ? JSON.stringify(data) : null, user ? user.id : null);
}

function getEnrollment(db, id) {
  return db.prepare(`SELECT e.*, s.full_name AS student_name, s.code AS student_code, c.name AS class_name, c.fee_type, c.fee_amount, c.package_sessions,
      sub.name AS subject_name FROM enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = e.class_id
      LEFT JOIN subjects sub ON sub.id = COALESCE(c.subject_id, e.subject_id) WHERE e.id = ?`).get(id);
}
function studentEnrollments(db, studentId) {
  return db.prepare(`SELECT e.*, c.name AS class_name, c.fee_type, c.billing_timing, sub.name AS subject_name, t.full_name AS teacher_name
    FROM enrollments e LEFT JOIN classes c ON c.id = e.class_id LEFT JOIN subjects sub ON sub.id = COALESCE(c.subject_id, e.subject_id)
    LEFT JOIN teachers t ON t.id = c.teacher_id WHERE e.student_id = ? ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'waiting' THEN 1 WHEN 'reserved' THEN 2 ELSE 3 END, e.id DESC`).all(studentId);
}
function classRoster(db, classId, { date = null, statuses = null } = {}) {
  const args = [classId]; let where = "e.class_id = ? AND e.status <> 'waiting'";
  if (date) { where += ' AND e.start_date <= ? AND (e.end_date IS NULL OR e.end_date >= ?)'; args.push(date, date); }
  if (statuses) { where += ` AND e.status IN (${statuses.map(() => '?').join(',')})`; args.push(...statuses); }
  return db.prepare(`SELECT e.*, s.full_name, s.code, s.parent_phone, s.parent_name, s.dob FROM enrollments e JOIN students s ON s.id = e.student_id
    WHERE ${where} ORDER BY s.full_name`).all(...args);
}
function waitingList(db) {
  return db.prepare(`SELECT e.*, s.full_name, s.code, s.parent_phone, c.name AS class_name, sub.name AS subject_name,
      (SELECT COALESCE(SUM(amount),0) FROM credit_entries ce WHERE ce.student_id = s.id AND ce.reservation_id IS NULL) AS credit
    FROM enrollments e JOIN students s ON s.id = e.student_id LEFT JOIN classes c ON c.id = e.class_id LEFT JOIN subjects sub ON sub.id = COALESCE(c.subject_id, e.subject_id)
    WHERE e.status = 'waiting' ORDER BY e.created_at`).all();
}

/** Lớp gói buổi: số buổi đã mua / đã dùng / còn lại */
function packageUsage(db, enrollmentId) {
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(enrollmentId);
  const cls = e && e.class_id ? B.getClassRow(db, e.class_id) : null;
  if (!cls || cls.fee_type !== 'package') return null;
  if (B.isPostpaid(cls)) {
    // thu cuối kỳ: không mua trước, tính theo buổi đã học
    const c = consumption(db, e, cls, null);
    const used = c.filter((x) => x.charged).length;
    const billed = db.prepare("SELECT COALESCE(SUM(sessions_count),0) n FROM invoices WHERE enrollment_id = ? AND status = 'active' AND category = 'tuition'").get(enrollmentId).n;
    return { postpaid: true, used, billed, unbilled: Math.max(0, used - billed), unmarked: c.filter((x) => x.unmarked).length };
  }
  const purchased = db.prepare("SELECT COALESCE(SUM(sessions_count),0) n FROM invoices WHERE enrollment_id = ? AND status = 'active' AND period_key LIKE 'PKG-%'").get(enrollmentId).n;
  const c = consumption(db, e, cls, null);
  const used = c.filter((x) => x.charged).length;
  const unmarked = c.filter((x) => x.unmarked).length;
  return { purchased, used, remaining: purchased - used, unmarked };
}

/**
 * Các buổi học sinh đã "sử dụng" trước ngày cutoff (không gồm cutoff).
 *  - Buổi hủy không tính.
 *  - Lớp gói: chỉ buổi đã dạy xong; có mặt luôn trừ buổi; vắng trừ buổi hay không theo cấu hình lớp; chưa điểm danh thì chưa trừ.
 *  - Lớp tháng/khóa: mọi buổi hợp lệ trong thời gian đăng ký; vắng thuộc diện "không tính phí" không tính.
 */
function consumption(db, enr, cls, cutoff) {
  const to = cutoff ? D.addDays(cutoff, -1) : (enr.end_date || D.todayVN());
  const sess = B.validSessions(db, cls.id, enr.start_date, D.minDate(enr.end_date, to));
  const att = B.attendanceMap(db, enr.id);
  return sess.map((s) => {
    const st = att.get(s.id) || 'unmarked';
    if (cls.fee_type === 'package') {
      if (s.status !== 'completed') return { s, charged: false };
      if (st === 'unmarked') return { s, charged: false, unmarked: true };
      return { s, charged: st === 'present' || !B.ATT_FREE(cls, st), status: st };
    }
    return { s, charged: !B.ATT_FREE(cls, st), status: st };
  });
}

/**
 * Bảng tính nghĩa vụ đã phát sinh đến trước ngày cutoff cho từng khoản học phí của đăng ký.
 * Trả về từng khoản: phải thu hiện tại, đã phát sinh, đã đóng, phần chưa sử dụng, buổi chưa dùng.
 */
function obligationStatement(db, enr, cls, cutoff) {
  const invs = db.prepare("SELECT * FROM invoices WHERE enrollment_id = ? AND status = 'active' AND category = 'tuition' ORDER BY id").all(enr.id).map((i) => B.balance(db, i.id));
  const cons = consumption(db, enr, cls, cutoff);
  const st = settings.getInt(db, 'rounding_step') || 1;
  const round = (n) => Math.round(n / st) * st;
  const lines = [];
  if (cls.fee_type === 'monthly') {
    for (const inv of invs) {
      const detail = JSON.parse(inv.calc_detail || '{}');
      const ded = detail.deduction || 0;
      const used = cons.filter((c) => D.monthOf(c.s.date) === inv.period_key);
      const units = inv.sessions_count || 1;
      // trong tháng, buổi vắng "không tính phí" chỉ được trừ nếu chưa có kỳ sau để trừ
      const nextInv = invs.find((x) => x.period_key === D.nextMonth(inv.period_key));
      const usedN = nextInv ? used.length : used.filter((c) => c.charged).length;
      const unit = (inv.amount + ded) / units;
      let incurred = usedN >= units ? inv.amount : round(unit * usedN) - ded;
      incurred = Math.max(0, Math.min(inv.amount, incurred));
      lines.push({ inv, units, used: usedN, incurred, unusedSessions: Math.max(0, units - usedN),
        explain: `${inv.period_label}: dùng ${usedN}/${units} buổi × ${vnd(Math.round(unit))}${ded ? ` − ${vnd(ded)} đã trừ` : ''}` });
    }
  } else {
    // khóa / gói: buổi đã dùng phân bổ lần lượt vào từng khoản (FIFO)
    let pool = cons.filter((c) => c.charged).length;
    for (const inv of invs) {
      const units = inv.sessions_count || 1;
      const usedN = Math.min(units, pool); pool -= usedN;
      const unit = inv.amount / units;
      const incurred = usedN >= units ? inv.amount : Math.min(inv.amount, round(unit * usedN));
      lines.push({ inv, units, used: usedN, incurred, unusedSessions: units - usedN,
        explain: `${inv.period_label}: dùng ${usedN}/${units} buổi × ${vnd(Math.round(unit))}` });
    }
    if (pool > 0) lines.overused = pool;
  }
  const sum = (f) => lines.reduce((a, l) => a + f(l), 0);
  return {
    lines,
    billed: sum((l) => l.inv.amount),
    incurred: sum((l) => l.incurred),
    paid: sum((l) => l.inv.paid),
    unusedValue: sum((l) => l.inv.amount - l.incurred),
    unusedSessions: sum((l) => l.unusedSessions),
    overused: lines.overused || 0,
  };
}

/**
 * Chốt đăng ký tại ngày cutoff: giảm khoản phải thu về đúng nghĩa vụ đã phát sinh,
 * rút phần đã đóng vượt nghĩa vụ ra sổ trả trước, ưu tiên bù vào nợ cũ của chính đăng ký.
 * Không coi toàn bộ tiền đã đóng là tiền được chuyển: chỉ phần đã đóng vượt nghĩa vụ mới được chuyển.
 */
/**
 * Lớp THU CUỐI KỲ: lập khoản phải thu cho các kỳ đã học nhưng chưa lập (đến hết ngày lastDay),
 * rồi trừ tiền trả trước nếu có. Dùng khi chuyển lớp, bảo lưu, nghỉ học, hoàn thành.
 */
function billUnbilled(db, user, enr, cls, lastDay) {
  if (!B.isPostpaid(cls) || !enr.start_date || lastDay < enr.start_date) return [];
  const e = { ...enr, end_date: lastDay };
  const has = (key) => db.prepare("SELECT 1 FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(enr.id, key);
  const made = [];
  const create = (c) => {
    if (c.error || !c.base_amount) return;
    const id = B.createTuitionInvoice(db, user, { enrollment_id: enr.id, calc: c });
    B.applyCredit(db, user, { invoice_id: id, note: 'Trừ tiền trả trước vào học phí thu cuối kỳ' });
    made.push(id);
  };
  if (cls.fee_type === 'course') { if (!has('COURSE')) create(B.calcCourse(db, e, cls)); return made; }
  for (let m = D.monthOf(enr.start_date); m <= D.monthOf(lastDay); m = D.nextMonth(m)) {
    if (has(m)) continue;
    create(cls.fee_type === 'monthly' ? B.calcMonthly(db, e, cls, m) : B.calcPackageUsage(db, e, cls, m));
  }
  return made;
}

function settle(db, user, enr, cls, cutoff, reason, kind) {
  const billed = billUnbilled(db, user, enr, cls, D.addDays(cutoff, -1));
  const stmt = obligationStatement(db, enr, cls, cutoff);
  stmt.postpaidBilled = billed.length;
  let released = 0;
  for (const l of stmt.lines) {
    if (l.incurred < l.inv.amount) {
      const r = B.adjustInvoice(db, user, { invoice_id: l.inv.id, new_amount: l.incurred, reason: `${reason} – chỉ tính phần đã học (${l.explain})`, kind, skipPerm: true });
      released += r.released;
    }
  }
  // bù nợ cũ của đăng ký này bằng phần vừa rút ra
  let nettedDebt = 0;
  for (const l of stmt.lines) {
    if (released - nettedDebt <= 0) break;
    const b = B.balance(db, l.inv.id);
    if (b.due > 0) nettedDebt += B.applyCredit(db, user, { invoice_id: b.id, amount: Math.min(b.due, released - nettedDebt), note: `${reason}: bù nợ ${b.code} bằng phần học phí chưa dùng` });
  }
  const debt = stmt.lines.reduce((a, l) => a + Math.max(0, B.balance(db, l.inv.id).due), 0);
  return { stmt, released, nettedDebt, transferable: released - nettedDebt, debtRemaining: debt };
}

function capacityCheck(db, cls, force) {
  if (!cls.max_students) return;
  const n = db.prepare("SELECT COUNT(*) n FROM enrollments WHERE class_id = ? AND status = 'active'").get(cls.id).n;
  if (n >= cls.max_students && !force) throw new AppError(`Lớp ${cls.name} đã đủ sĩ số tối đa (${cls.max_students}). Chọn "Vẫn xếp" nếu muốn vượt sĩ số.`, 409);
}

/** Tạo đăng ký đang học + khoản học phí kỳ đầu + trừ tiền trả trước */
function openEnrollment(db, user, { student_id, cls, start_date, from_enrollment_id = null, discount = 0, discount_reason = '', create_invoice = true, apply_credit = true, note = '', force = false, enrollment_id = null }) {
  assert(cls && cls.status === 'active', 'Lớp không còn hoạt động');
  const dup = db.prepare("SELECT 1 FROM enrollments WHERE student_id = ? AND class_id = ? AND status IN ('active') AND id IS NOT ?").get(student_id, cls.id, enrollment_id);
  assert(!dup, 'Học sinh đang học lớp này rồi');
  capacityCheck(db, cls, force);
  const sd = D.parseInput(start_date) || D.todayVN();
  let id = enrollment_id;
  if (id) {
    db.prepare("UPDATE enrollments SET class_id = ?, status = 'active', start_date = ?, note = COALESCE(NULLIF(?, ''), note) WHERE id = ?").run(cls.id, D.maxDate(sd, cls.start_date), note, id);
    event(db, user, id, 'place', 'waiting', 'active', sd, null, { class_id: cls.id });
  } else {
    id = Number(db.prepare("INSERT INTO enrollments(student_id, class_id, status, start_date, from_enrollment_id, note, created_by) VALUES (?,?,'active',?,?,?,?)")
      .run(student_id, cls.id, D.maxDate(sd, cls.start_date), from_enrollment_id, note, user ? user.id : null).lastInsertRowid);
    event(db, user, id, 'enroll', null, 'active', sd, null, { class_id: cls.id });
  }
  let invoice = null; let applied = 0; let calc = null; let estimate = null;
  if (B.isPostpaid(cls)) {
    // thu cuối kỳ: chưa lập khoản phải thu khi xếp lớp; chỉ hiển thị dự tính
    const enr = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
    if (cls.fee_type === 'monthly') estimate = B.calcMonthly(db, enr, cls, D.monthOf(enr.start_date));
    else if (cls.fee_type === 'course') estimate = B.calcCourse(db, enr, cls);
    else estimate = { lines: [`Tính theo số buổi thực học × ${require('../lib/money').vnd(cls.fee_amount)}/buổi, lập khoản vào cuối mỗi tháng`] };
    if (estimate.error) estimate = { lines: [estimate.error] };
    return { enrollment_id: id, invoice: null, applied: 0, calc: null, estimate, postpaid: true, credit: B.credit(db, student_id) };
  }
  if (create_invoice) {
    const enr = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id);
    calc = B.calcFirst(db, enr, cls);
    if (calc.error) throw new AppError(calc.error);
    if (discount) assert(perms.can.adjustMoney(user), 'Bạn chưa được cấp quyền miễn giảm học phí');
    const invId = B.createTuitionInvoice(db, user, { enrollment_id: id, calc, discount, discount_reason });
    if (apply_credit) applied = B.applyCredit(db, user, { invoice_id: invId, note: 'Trừ tiền trả trước/đặt cọc khi xếp lớp' });
    invoice = B.balance(db, invId);
  }
  return { enrollment_id: id, invoice, applied, calc, credit: B.credit(db, student_id) };
}

/** Xếp lớp ngay (status active) hoặc đưa vào danh sách chờ */
function enroll(db, user, input) {
  perms.require(user, 'manageStudents');
  const student_id = Number(input.student_id);
  assert(db.prepare('SELECT 1 FROM students WHERE id = ?').get(student_id), 'Không tìm thấy học sinh', 404);
  if (input.mode === 'waiting') {
    const cls = input.class_id ? B.getClassRow(db, Number(input.class_id)) : null;
    const id = Number(db.prepare("INSERT INTO enrollments(student_id, class_id, subject_id, status, note, created_by) VALUES (?,?,?,'waiting',?,?)")
      .run(student_id, cls ? cls.id : null, input.subject_id ? Number(input.subject_id) : (cls ? cls.subject_id : null), String(input.note || ''), user.id).lastInsertRowid);
    event(db, user, id, 'waitlist', null, 'waiting', D.todayVN(), input.note);
    return { enrollment_id: id, waiting: true };
  }
  const cls = B.getClassRow(db, Number(input.class_id)); assert(cls, 'Vui lòng chọn lớp');
  return runMaybeDry(db, !!input.dry, () => {
    const r = openEnrollment(db, user, { student_id, cls, start_date: input.start_date, discount: input.discount || 0, discount_reason: input.discount_reason,
      create_invoice: input.create_invoice !== false && input.create_invoice !== '0', apply_credit: input.apply_credit !== false && input.apply_credit !== '0', note: input.note, force: !!input.force,
      enrollment_id: input.enrollment_id ? Number(input.enrollment_id) : null });
    audit.log(db, user, 'enrollment.create', 'enrollment', r.enrollment_id, null, { class_id: cls.id, invoice: r.invoice && r.invoice.code, applied: r.applied });
    return r;
  });
}

/** Xếp lớp cho học sinh trong danh sách chờ (dùng tiền cọc nếu có) */
function placeWaiting(db, user, input) {
  perms.require(user, 'manageStudents');
  const e = getEnrollment(db, Number(input.enrollment_id)); assert(e && e.status === 'waiting', 'Đăng ký không ở trạng thái chờ');
  return enroll(db, user, { ...input, student_id: e.student_id, enrollment_id: e.id, mode: 'active' });
}

/**
 * Chuyển lớp từ ngày hiệu lực:
 *  1. Lớp cũ chỉ tính nghĩa vụ đến trước ngày hiệu lực; phần đã đóng vượt nghĩa vụ ra tiền trả trước (bù nợ cũ trước).
 *  2. Lớp mới: tạo đăng ký mới, khoản học phí kỳ đầu, trừ tiền trả trước.
 *  Lịch sử lớp cũ (điểm danh, phiếu thu, khoản phải thu) giữ nguyên.
 */
function transfer(db, user, input) {
  perms.require(user, 'manageStudents');
  const old = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(input.enrollment_id));
  assert(old && old.status === 'active', 'Chỉ chuyển lớp cho đăng ký đang học');
  const oldCls = B.getClassRow(db, old.class_id);
  const newCls = B.getClassRow(db, Number(input.new_class_id)); assert(newCls, 'Vui lòng chọn lớp mới');
  assert(newCls.id !== oldCls.id, 'Lớp mới phải khác lớp hiện tại');
  const eff = D.parseInput(input.effective_date); assert(eff, 'Ngày hiệu lực không hợp lệ');
  assert(eff > old.start_date, 'Ngày hiệu lực phải sau ngày bắt đầu học lớp cũ');
  const reason = String(input.reason || '').trim() || 'Chuyển lớp';
  return runMaybeDry(db, !!input.dry, () => {
    const creditBefore = B.credit(db, old.student_id);
    const st = settle(db, user, old, oldCls, eff, `Chuyển sang ${newCls.name}`, 'transfer');
    db.prepare("UPDATE enrollments SET status = 'transferred', end_date = ? WHERE id = ?").run(D.addDays(eff, -1), old.id);
    const creditMid = B.credit(db, old.student_id);
    const neu = openEnrollment(db, user, { student_id: old.student_id, cls: newCls, start_date: eff, from_enrollment_id: old.id, force: !!input.force, note: `Chuyển từ ${oldCls.name}` });
    event(db, user, old.id, 'transfer', 'active', 'transferred', eff, reason, { to_enrollment: neu.enrollment_id, released: st.released });
    audit.log(db, user, 'enrollment.transfer', 'enrollment', old.id, reason, { to: neu.enrollment_id, eff, released: st.released, debt: st.debtRemaining });
    return { old: { class: oldCls, ...st }, creditBefore, creditMid, neu, newClass: newCls, effective_date: eff };
  });
}

/**
 * Bảo lưu từ ngày bắt đầu: chốt nghĩa vụ đến trước ngày bảo lưu, giá trị chưa dùng (đã đóng) được giữ riêng cho lần bảo lưu,
 * không dùng được cho việc khác cho đến khi quay lại. Không phát sinh học phí mới khi đang bảo lưu.
 */
function reserve(db, user, input) {
  perms.require(user, 'manageStudents');
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(input.enrollment_id));
  assert(e && e.status === 'active', 'Chỉ bảo lưu đăng ký đang học');
  const cls = B.getClassRow(db, e.class_id);
  const start = D.parseInput(input.start_date); assert(start, 'Ngày bắt đầu bảo lưu không hợp lệ');
  assert(start > e.start_date, 'Ngày bảo lưu phải sau ngày bắt đầu học');
  const ret = D.parseInput(input.expected_return_date) || null;
  if (ret) assert(ret > start, 'Ngày dự kiến quay lại phải sau ngày bảo lưu');
  const reason = String(input.reason || '').trim(); assert(reason, 'Vui lòng nhập lý do bảo lưu');
  return runMaybeDry(db, !!input.dry, () => {
    const rid = Number(db.prepare('INSERT INTO reservations(enrollment_id, student_id, start_date, expected_return_date, reason, created_by) VALUES (?,?,?,?,?,?)')
      .run(e.id, e.student_id, start, ret, reason, user.id).lastInsertRowid);
    const st = settle(db, user, e, cls, start, `Bảo lưu từ ${D.display(start)}`, 'reservation');
    // phần chuyển được đưa vào "ngăn" bảo lưu
    if (st.transferable > 0) {
      db.prepare("INSERT INTO credit_entries(student_id, amount, type, note, user_id) VALUES (?,?,'reserve_out',?,?)").run(e.student_id, -st.transferable, `Giữ cho bảo lưu #${rid}`, user.id);
      db.prepare("INSERT INTO credit_entries(student_id, amount, type, reservation_id, note, user_id) VALUES (?,?,'reserve_in',?,?,?)").run(e.student_id, st.transferable, rid, `Giá trị bảo lưu lớp ${cls.name}`, user.id);
    }
    const sessionsLeft = cls.fee_type === 'monthly' ? 0 : st.stmt.unusedSessions;
    const unitHint = st.stmt.lines.length ? Math.round(st.stmt.lines[st.stmt.lines.length - 1].inv.amount / (st.stmt.lines[st.stmt.lines.length - 1].units || 1)) : 0;
    db.prepare('UPDATE reservations SET credit_amount = ?, credit_sessions = ?, calc_detail = ? WHERE id = ?')
      .run(st.transferable, sessionsLeft, JSON.stringify({ lines: st.stmt.lines.map((l) => l.explain), released: st.released, netted: st.nettedDebt, debt: st.debtRemaining, unitHint }), rid);
    db.prepare("UPDATE enrollments SET status = 'reserved', end_date = ? WHERE id = ?").run(D.addDays(start, -1), e.id);
    event(db, user, e.id, 'reserve', 'active', 'reserved', start, reason, { reservation_id: rid, credit: st.transferable, sessions: sessionsLeft });
    audit.log(db, user, 'enrollment.reserve', 'enrollment', e.id, reason, { reservation_id: rid, credit: st.transferable });
    return { reservation_id: rid, class: cls, ...st, credit_amount: st.transferable, credit_sessions: sessionsLeft, start, ret };
  });
}

function getReservation(db, id) {
  return db.prepare(`SELECT r.*, s.full_name AS student_name, s.code AS student_code, c.name AS class_name, c.id AS class_id,
      COALESCE((SELECT SUM(amount) FROM credit_entries ce WHERE ce.reservation_id = r.id),0) AS held
    FROM reservations r JOIN students s ON s.id = r.student_id JOIN enrollments e ON e.id = r.enrollment_id JOIN classes c ON c.id = e.class_id WHERE r.id = ?`).get(id);
}
function listReservations(db, { status = 'active', studentId = null } = {}) {
  const where = []; const args = [];
  if (status) { where.push('r.status = ?'); args.push(status); }
  if (studentId) { where.push('r.student_id = ?'); args.push(studentId); }
  return db.prepare(`SELECT r.*, s.full_name AS student_name, s.code AS student_code, s.parent_phone, c.name AS class_name,
      COALESCE((SELECT SUM(amount) FROM credit_entries ce WHERE ce.reservation_id = r.id),0) AS held
    FROM reservations r JOIN students s ON s.id = r.student_id JOIN enrollments e ON e.id = r.enrollment_id JOIN classes c ON c.id = e.class_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.expected_return_date IS NULL, r.expected_return_date`).all(...args);
}

/** Quay lại sau bảo lưu: chọn lớp, giá trị bảo lưu chuyển ra tiền trả trước rồi trừ vào học phí lớp mới */
function returnFromReservation(db, user, input) {
  perms.require(user, 'manageStudents');
  const r = getReservation(db, Number(input.reservation_id)); assert(r && r.status === 'active', 'Bảo lưu không còn hiệu lực');
  const cls = B.getClassRow(db, Number(input.class_id || r.class_id)); assert(cls, 'Vui lòng chọn lớp');
  const start = D.parseInput(input.start_date) || D.todayVN();
  assert(start >= r.start_date, 'Ngày quay lại phải sau ngày bắt đầu bảo lưu');
  return runMaybeDry(db, !!input.dry, () => {
    if (r.held > 0) {
      db.prepare("INSERT INTO credit_entries(student_id, amount, type, reservation_id, note, user_id) VALUES (?,?,'reserve_out',?,?,?)").run(r.student_id, -r.held, r.id, `Kết thúc bảo lưu #${r.id}`, user.id);
      db.prepare("INSERT INTO credit_entries(student_id, amount, type, note, user_id) VALUES (?,?,'reserve_in',?,?)").run(r.student_id, r.held, `Giá trị bảo lưu #${r.id} dùng khi quay lại`, user.id);
    }
    const neu = openEnrollment(db, user, { student_id: r.student_id, cls, start_date: start, from_enrollment_id: r.enrollment_id, force: !!input.force, note: `Quay lại sau bảo lưu #${r.id}` });
    db.prepare("UPDATE reservations SET status = 'returned', returned_enrollment_id = ?, returned_at = ? WHERE id = ?").run(neu.enrollment_id, start, r.id);
    db.prepare("UPDATE enrollments SET status = 'transferred' WHERE id = ?").run(r.enrollment_id);
    event(db, user, r.enrollment_id, 'return', 'reserved', 'transferred', start, input.reason || null, { reservation_id: r.id, to_enrollment: neu.enrollment_id });
    audit.log(db, user, 'reservation.return', 'reservation', r.id, input.reason || null, { to: neu.enrollment_id, held: r.held });
    return { reservation: r, neu, cls, start };
  });
}

/**
 * Nghỉ học. Mặc định chốt nghĩa vụ đến trước ngày nghỉ (phần đã đóng dư vào tiền trả trước, có thể hoàn sau),
 * hoặc giữ nguyên toàn bộ học phí nếu chọn "không tính lại". Không xóa dữ liệu thu tiền.
 */
function drop(db, user, input) {
  perms.require(user, 'manageStudents');
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(input.enrollment_id));
  assert(e && ['active', 'waiting', 'reserved'].includes(e.status), 'Đăng ký không ở trạng thái có thể cho nghỉ');
  const reason = String(input.reason || '').trim(); assert(reason, 'Vui lòng nhập lý do nghỉ học');
  const date = D.parseInput(input.date) || D.todayVN();
  return runMaybeDry(db, !!input.dry, () => {
    let st = null;
    if (e.status === 'active' && (input.settle === '0' || input.settle === false)) {
      billUnbilled(db, user, e, B.getClassRow(db, e.class_id), D.addDays(date, -1));
    }
    if (e.status === 'active' && input.settle !== '0' && input.settle !== false) {
      assert(date > e.start_date, 'Ngày nghỉ phải sau ngày bắt đầu học (hoặc chọn không tính lại)');
      st = settle(db, user, e, B.getClassRow(db, e.class_id), date, `Nghỉ học từ ${D.display(date)}`, 'drop');
    }
    if (e.status === 'reserved') {
      const r = db.prepare("SELECT * FROM reservations WHERE enrollment_id = ? AND status = 'active'").get(e.id);
      if (r) {
        const held = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_entries WHERE reservation_id = ?').get(r.id).s;
        if (held > 0) {
          db.prepare("INSERT INTO credit_entries(student_id, amount, type, reservation_id, note, user_id) VALUES (?,?,'reserve_out',?,?,?)").run(e.student_id, -held, r.id, 'Nghỉ học khi đang bảo lưu', user.id);
          db.prepare("INSERT INTO credit_entries(student_id, amount, type, note, user_id) VALUES (?,?,'reserve_in',?,?)").run(e.student_id, held, `Giá trị bảo lưu #${r.id} trả về tiền trả trước`, user.id);
        }
        db.prepare("UPDATE reservations SET status = 'closed' WHERE id = ?").run(r.id);
      }
    }
    const endDate = e.status === 'active' ? D.addDays(date, -1) : e.end_date;
    db.prepare("UPDATE enrollments SET status = 'dropped', end_date = ? WHERE id = ?").run(endDate, e.id);
    event(db, user, e.id, 'drop', e.status, 'dropped', date, reason, st ? { released: st.released, debt: st.debtRemaining } : null);
    audit.log(db, user, 'enrollment.drop', 'enrollment', e.id, reason, st ? { released: st.released } : null);
    return { settle: st, date, credit: B.credit(db, e.student_id) };
  });
}

function complete(db, user, { enrollment_id, date }) {
  perms.require(user, 'manageStudents');
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(Number(enrollment_id));
  assert(e && e.status === 'active', 'Chỉ hoàn thành đăng ký đang học');
  const d = D.parseInput(date) || D.todayVN();
  db.transaction(() => {
    billUnbilled(db, user, e, B.getClassRow(db, e.class_id), d);
    db.prepare("UPDATE enrollments SET status = 'completed', end_date = ? WHERE id = ?").run(d, e.id);
  })();
  event(db, user, e.id, 'complete', 'active', 'completed', d);
  audit.log(db, user, 'enrollment.complete', 'enrollment', e.id);
}

function events(db, studentId) {
  return db.prepare(`SELECT ev.*, c.name AS class_name, u.full_name AS user_name FROM enrollment_events ev JOIN enrollments e ON e.id = ev.enrollment_id
    LEFT JOIN classes c ON c.id = e.class_id LEFT JOIN users u ON u.id = ev.user_id WHERE e.student_id = ? ORDER BY ev.id DESC`).all(studentId);
}

module.exports = {
  STATUS, getEnrollment, studentEnrollments, classRoster, waitingList, packageUsage, consumption, obligationStatement, settle, billUnbilled,
  enroll, placeWaiting, transfer, reserve, getReservation, listReservations, returnFromReservation, drop, complete, events,
};
