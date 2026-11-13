'use strict';
/**
 * Học phí, khoản phải thu, phiếu thu, tiền trả trước.
 *
 * Mô hình tiền:
 *  - invoices: khoản phải thu (amount = số phải thu sau điều chỉnh).
 *  - receipts: mỗi lần nhận tiền một phiếu thu.
 *  - allocations: phân bổ tiền vào khoản phải thu (từ phiếu thu hoặc từ tiền trả trước). Đã đóng = tổng phân bổ.
 *  - credit_entries: sổ tiền trả trước của học sinh (đặt cọc, tiền dư, giá trị chưa dùng khi chuyển lớp/bảo lưu).
 *    reservation_id khác NULL = tiền đang giữ cho một lần bảo lưu, không dùng được cho việc khác.
 *  Còn nợ = phải thu − đã đóng. Một đồng tiền chỉ nằm ở một chỗ: hoặc đã phân bổ vào khoản phải thu, hoặc trong sổ trả trước.
 */
const D = require('../lib/dates');
const { AppError, assert } = require('../lib/errors');
const { roundTo, mustMoney, vnd } = require('../lib/money');
const { nextCode } = require('../db');
const settings = require('./settings');
const audit = require('./audit');
const perms = require('./perms');

const CATEGORIES = { tuition: 'Học phí', book: 'Tiền sách/giáo trình', uniform: 'Đồng phục', other: 'Khoản thu khác' };
const METHODS = { cash: 'Tiền mặt', transfer: 'Chuyển khoản' };
const ATT_FREE = (cls, status) => (status === 'excused' && !cls.excused_absence_charged) || (status === 'unexcused' && !cls.unexcused_absence_charged);

function step(db) { return settings.getInt(db, 'rounding_step') || 1; }
function getEnrollment(db, id) { return db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id); }
function getClassRow(db, id) { return db.prepare('SELECT * FROM classes WHERE id = ?').get(id); }

function periodLabel(cls, key) {
  if (!key) return '';
  if (/^\d{4}-\d{2}$/.test(key)) return `Tháng ${D.displayMonth(key)}`;
  if (key === 'COURSE') return 'Cả khóa';
  const m = key.match(/^PKG-(\d+)$/); if (m) return `Gói ${m[1]}${cls && cls.package_sessions ? ` (${cls.package_sessions} buổi)` : ''}`;
  return key;
}

/** Các buổi hợp lệ (không bị hủy) của lớp trong khoảng ngày */
function validSessions(db, classId, from, to) {
  return db.prepare("SELECT * FROM class_sessions WHERE class_id = ? AND status <> 'cancelled' AND date >= ? AND date <= ? ORDER BY date, start_time")
    .all(classId, from || '0000-00-00', to || '9999-12-31');
}
function attendanceMap(db, enrollmentId) {
  const m = new Map();
  for (const a of db.prepare('SELECT session_id, status FROM attendance WHERE enrollment_id = ?').all(enrollmentId)) m.set(a.session_id, a.status);
  return m;
}

// ------------------------------------------------------------------ Tính học phí theo kỳ

/**
 * Học phí tháng:
 *  - Học đủ tháng: mức phí tháng.
 *  - Nhập học/kết thúc giữa tháng & lớp bật "tính theo tỷ lệ": phí × (số buổi trong thời gian đăng ký / tổng số buổi hợp lệ của tháng).
 *  - Buổi trung tâm hủy không tính (không nằm trong số buổi hợp lệ).
 *  - Nếu lớp cấu hình "vắng ... không tính phí": trừ giá trị các buổi vắng đó của tháng trước vào tháng này.
 */
function calcMonthly(db, enr, cls, ym) {
  const ms = D.monthStart(ym); const me = D.monthEnd(ym);
  const monthSessions = validSessions(db, cls.id, ms, me);
  const total = monthSessions.length;
  if (!total) return { error: `Lớp không có buổi học hợp lệ trong tháng ${D.displayMonth(ym)}` };
  const ws = D.maxDate(enr.start_date, ms); const we = D.minDate(enr.end_date || me, me);
  const inWin = monthSessions.filter((s) => s.date >= ws && s.date <= we);
  const n = inWin.length;
  if (!n) return { error: `Học sinh không có buổi học nào trong tháng ${D.displayMonth(ym)} theo thời gian đăng ký` };
  const fee = cls.fee_amount;
  const lines = [];
  let base;
  if (n === total) { base = fee; lines.push(`Học đủ tháng ${D.displayMonth(ym)}: ${total}/${total} buổi → ${vnd(fee)}`); }
  else if (cls.prorate_first_month) {
    base = roundTo(fee * n / total, step(db));
    lines.push(`Tháng ${D.displayMonth(ym)} có ${total} buổi hợp lệ; học sinh học ${n} buổi (từ ${D.display(inWin[0].date)}).`);
    lines.push(`${vnd(fee)} × ${n}/${total} = ${vnd(base)}${step(db) > 1 ? ` (làm tròn ${vnd(step(db))})` : ''}`);
  } else { base = fee; lines.push(`Học ${n}/${total} buổi; lớp không tính theo tỷ lệ → thu đủ ${vnd(fee)}`); }

  let deduction = 0;
  if (!cls.excused_absence_charged || !cls.unexcused_absence_charged) {
    const prev = D.monthOf(D.addDays(ms, -1));
    const prevInv = db.prepare("SELECT * FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(enr.id, prev);
    if (prevInv && prevInv.sessions_count) {
      const att = attendanceMap(db, enr.id);
      const prevSess = validSessions(db, cls.id, D.monthStart(prev), D.monthEnd(prev)).filter((s) => s.status === 'completed' && ATT_FREE(cls, att.get(s.id)));
      if (prevSess.length) {
        const unit = (prevInv.amount + (JSON.parse(prevInv.calc_detail || '{}').deduction || 0)) / prevInv.sessions_count;
        deduction = Math.min(base, roundTo(unit * prevSess.length, step(db)));
        lines.push(`Trừ ${prevSess.length} buổi vắng không tính phí của tháng ${D.displayMonth(prev)}: −${vnd(deduction)}`);
      }
    }
  }
  const amount = base - deduction;
  return { period_key: ym, period_label: periodLabel(cls, ym), base_amount: amount, sessions_count: n, total_sessions: total, deduction, lines, unit_price: Math.round(fee / total) };
}

/** Học phí khóa: phí cả khóa gắn với tổng số buổi; nhập học muộn tính phí × số buổi còn lại / tổng số buổi */
function calcCourse(db, enr, cls) {
  const all = validSessions(db, cls.id);
  const total = cls.total_sessions;
  const remaining = all.filter((s) => s.date >= enr.start_date && (!enr.end_date || s.date <= enr.end_date)).length;
  const n = Math.min(remaining, total);
  if (!n) return { error: 'Khóa học không còn buổi nào sau ngày nhập học' };
  const fee = cls.fee_amount; const lines = [];
  let base;
  if (n >= total) { base = fee; lines.push(`Học đủ khóa ${total} buổi → ${vnd(fee)}`); }
  else {
    base = roundTo(fee * n / total, step(db));
    lines.push(`Khóa ${total} buổi, nhập học từ ${D.display(enr.start_date)} còn ${n} buổi.`);
    lines.push(`${vnd(fee)} × ${n}/${total} = ${vnd(base)}`);
  }
  return { period_key: 'COURSE', period_label: 'Cả khóa', base_amount: base, sessions_count: n, total_sessions: total, deduction: 0, lines, unit_price: Math.round(fee / total) };
}

/** Gói buổi: số buổi mỗi gói × đơn giá/buổi */
function calcPackage(db, enr, cls) {
  const k = db.prepare("SELECT COUNT(*) n FROM invoices WHERE enrollment_id = ? AND period_key LIKE 'PKG-%'").get(enr.id).n + 1;
  const key = `PKG-${k}`;
  const base = cls.fee_amount * cls.package_sessions;
  return { period_key: key, period_label: periodLabel(cls, key), base_amount: base, sessions_count: cls.package_sessions, deduction: 0,
    lines: [`Gói ${cls.package_sessions} buổi × ${vnd(cls.fee_amount)}/buổi = ${vnd(base)}`], unit_price: cls.fee_amount };
}

function calcPeriod(db, enr, cls, ym = null) {
  if (cls.fee_type === 'monthly') return calcMonthly(db, enr, cls, ym || D.monthOf(D.maxDate(enr.start_date, D.todayVN())));
  if (cls.fee_type === 'course') return calcCourse(db, enr, cls);
  return calcPackage(db, enr, cls);
}
/** Kỳ thu đầu tiên khi xếp lớp */
function calcFirst(db, enr, cls) { return calcPeriod(db, enr, cls, cls.fee_type === 'monthly' ? D.monthOf(enr.start_date) : null); }

function dueDateFor(db, cls, periodKey, issueDate) {
  const base = D.addDays(issueDate, settings.getInt(db, 'due_days'));
  if (cls && cls.fee_type === 'monthly' && /^\d{4}-\d{2}$/.test(periodKey)) {
    const day = String(Math.min(28, Math.max(1, settings.getInt(db, 'monthly_due_day') || 10))).padStart(2, '0');
    return D.maxDate(`${periodKey}-${day}`, base);
  }
  return base;
}

// ------------------------------------------------------------------ Khoản phải thu

function balance(db, invoiceId) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!inv) return null;
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM allocations WHERE invoice_id = ? AND status = 'valid'").get(invoiceId).s;
  return { ...inv, paid, due: inv.status === 'void' ? 0 : inv.amount - paid };
}

const INVOICE_SELECT = `SELECT i.*, s.full_name AS student_name, s.code AS student_code, s.parent_phone, s.parent_name, c.name AS class_name,
    COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status = 'valid'),0) AS paid
  FROM invoices i JOIN students s ON s.id = i.student_id LEFT JOIN classes c ON c.id = i.class_id`;

function listInvoices(db, { studentId = null, status = 'open', classId = null, period = null, q = null, overdueOnly = false } = {}) {
  const where = ["i.status = 'active'"]; const args = [];
  if (studentId) { where.push('i.student_id = ?'); args.push(studentId); }
  if (classId) { where.push('i.class_id = ?'); args.push(classId); }
  if (period) { where.push('i.period_key = ?'); args.push(period); }
  if (q) { where.push('(s.full_name LIKE ? OR s.code LIKE ? OR s.parent_phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  let rows = db.prepare(`${INVOICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.due_date, i.id`).all(...args).map((r) => ({ ...r, due: r.amount - r.paid }));
  if (status === 'open') rows = rows.filter((r) => r.due > 0);
  if (status === 'paid') rows = rows.filter((r) => r.due <= 0);
  if (overdueOnly) { const today = D.todayVN(); rows = rows.filter((r) => r.due > 0 && r.due_date && r.due_date < today); }
  return rows;
}
function studentInvoices(db, studentId) {
  return db.prepare(`${INVOICE_SELECT} WHERE i.student_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(studentId)
    .map((r) => ({ ...r, due: r.status === 'void' ? 0 : r.amount - r.paid }));
}
function getInvoice(db, id) {
  const r = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(id);
  if (!r) return null;
  r.due = r.status === 'void' ? 0 : r.amount - r.paid;
  r.adjustments = db.prepare('SELECT a.*, u.full_name AS user_name FROM invoice_adjustments a LEFT JOIN users u ON u.id = a.user_id WHERE invoice_id = ? ORDER BY a.id').all(id);
  r.allocations = db.prepare(`SELECT a.*, r.code AS receipt_code, r.paid_date, r.method FROM allocations a LEFT JOIN receipts r ON r.id = a.receipt_id
    WHERE a.invoice_id = ? ORDER BY a.id`).all(id);
  r.detail = JSON.parse(r.calc_detail || '{}');
  return r;
}

function insertInvoice(db, user, data) {
  const code = nextCode(db, 'invoice', 'HP', 6);
  try {
    const id = Number(db.prepare(`INSERT INTO invoices(code, student_id, enrollment_id, class_id, category, period_key, period_label, description,
        base_amount, amount, sessions_count, due_date, calc_detail, idempotency_key, created_by)
      VALUES (@code,@student_id,@enrollment_id,@class_id,@category,@period_key,@period_label,@description,@base_amount,@amount,@sessions_count,@due_date,@calc_detail,@idempotency_key,@created_by)`)
      .run({ enrollment_id: null, class_id: null, period_key: null, period_label: null, description: null, sessions_count: null, calc_detail: null, idempotency_key: null, ...data, code, amount: data.base_amount, created_by: user ? user.id : null }).lastInsertRowid);
    audit.log(db, user, 'invoice.create', 'invoice', id, null, { code, amount: data.base_amount, period: data.period_key });
    return id;
  } catch (e) {
    if (/UNIQUE constraint failed: invoices\.enrollment_id/.test(String(e.message))) throw new AppError(`Đã có khoản phải thu ${data.period_label || data.period_key} cho học sinh ở lớp này – không tạo trùng`, 409);
    throw e;
  }
}

/** Tạo khoản học phí cho một đăng ký và kỳ (dùng khi xếp lớp, thu kỳ tiếp, tạo hàng loạt) */
function createTuitionInvoice(db, user, { enrollment_id, ym = null, calc = null, discount = 0, discount_reason = '', issue_date = null, idempotency_key = null }) {
  if (idempotency_key) {
    const ex = db.prepare('SELECT id FROM invoices WHERE idempotency_key = ?').get(idempotency_key);
    if (ex) return ex.id;
  }
  const enr = getEnrollment(db, enrollment_id); assert(enr && enr.class_id, 'Không tìm thấy đăng ký lớp', 404);
  assert(['active'].includes(enr.status), 'Chỉ tạo học phí cho học sinh đang học');
  const cls = getClassRow(db, enr.class_id);
  const c = calc || calcPeriod(db, enr, cls, ym);
  if (c.error) throw new AppError(c.error);
  const issue = issue_date || D.todayVN();
  const id = insertInvoice(db, user, {
    student_id: enr.student_id, enrollment_id: enr.id, class_id: cls.id, category: 'tuition', period_key: c.period_key, period_label: c.period_label,
    description: `Học phí ${cls.name} – ${c.period_label}`, base_amount: c.base_amount, sessions_count: c.sessions_count,
    due_date: dueDateFor(db, cls, c.period_key, issue),
    calc_detail: JSON.stringify({ lines: c.lines, deduction: c.deduction, unit_price: c.unit_price, total_sessions: c.total_sessions }),
    idempotency_key,
  });
  if (discount) adjustInvoice(db, user, { invoice_id: id, delta: -mustMoney(discount, 'Số tiền miễn giảm'), reason: discount_reason, kind: 'discount', skipPerm: true });
  return id;
}

/** Khoản thu khác (sách, đồng phục...) gắn với học sinh */
function createOtherInvoice(db, user, { student_id, category, description, amount, class_id, due_date, idempotency_key }) {
  perms.require(user, 'collectMoney');
  if (idempotency_key) { const ex = db.prepare('SELECT id FROM invoices WHERE idempotency_key = ?').get(idempotency_key); if (ex) return ex.id; }
  assert(CATEGORIES[category] && category !== 'tuition', 'Loại khoản thu không hợp lệ');
  const amt = mustMoney(amount);
  return insertInvoice(db, user, {
    student_id: Number(student_id), class_id: class_id ? Number(class_id) : null, category, description: String(description || CATEGORIES[category]).trim(),
    base_amount: amt, due_date: D.parseInput(due_date) || D.todayVN(), period_label: CATEGORIES[category], idempotency_key: idempotency_key || null,
  });
}

/** Miễn giảm / điều chỉnh: bắt buộc lý do, lưu lịch sử. Nếu số phải thu mới < đã đóng, phần dư chuyển vào tiền trả trước. */
function adjustInvoice(db, user, { invoice_id, delta = null, new_amount = null, reason, kind = null, skipPerm = false, reservationId = null }) {
  if (!skipPerm) perms.require(user, 'adjustMoney', 'Bạn chưa được chủ trung tâm cấp quyền miễn giảm/điều chỉnh học phí');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do miễn giảm / điều chỉnh');
  const b = balance(db, invoice_id); assert(b && b.status === 'active', 'Không tìm thấy khoản phải thu', 404);
  const target = new_amount != null ? mustMoney(new_amount, 'Số phải thu mới', { allowZero: true }) : b.amount + Number(delta);
  assert(Number.isInteger(target) && target >= 0, 'Số phải thu sau điều chỉnh không được âm');
  if (target === b.amount) return { released: 0 };
  return db.transaction(() => {
    db.prepare('UPDATE invoices SET amount = ? WHERE id = ?').run(target, invoice_id);
    db.prepare('INSERT INTO invoice_adjustments(invoice_id, delta, kind, reason, old_amount, new_amount, user_id) VALUES (?,?,?,?,?,?,?)')
      .run(invoice_id, target - b.amount, kind || (target < b.amount ? 'discount' : 'increase'), reason, b.amount, target, user ? user.id : null);
    audit.log(db, user, 'invoice.adjust', 'invoice', invoice_id, reason, { from: b.amount, to: target });
    let released = 0;
    if (b.paid > target) released = releaseToCredit(db, user, b, b.paid - target, reason, reservationId);
    return { released };
  })();
}

/** Rút phần đã đóng vượt nghĩa vụ ra sổ trả trước (phân bổ âm + bút toán trả trước dương) */
function releaseToCredit(db, user, inv, amount, note, reservationId = null) {
  const ce = Number(db.prepare('INSERT INTO credit_entries(student_id, amount, type, reservation_id, invoice_id, note, user_id) VALUES (?,?,?,?,?,?,?)')
    .run(inv.student_id, amount, 'release', reservationId, inv.id, `Chuyển phần đã đóng dư từ ${inv.code}: ${note || ''}`.trim(), user ? user.id : null).lastInsertRowid);
  db.prepare("INSERT INTO allocations(invoice_id, amount, source, credit_entry_id, user_id) VALUES (?,?,'credit',?,?)").run(inv.id, -amount, ce, user ? user.id : null);
  return amount;
}

function voidInvoice(db, user, id, reason) {
  perms.require(user, 'adjustMoney', 'Bạn chưa được cấp quyền hủy khoản phải thu');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do hủy');
  const b = balance(db, id); assert(b && b.status === 'active', 'Không tìm thấy khoản phải thu', 404);
  assert(b.paid === 0, 'Khoản này đã có tiền thanh toán. Hãy hủy phiếu thu hoặc điều chỉnh số phải thu trước.');
  db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, voided_by = ?, voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reason, user.id, id);
  audit.log(db, user, 'invoice.void', 'invoice', id, reason);
}

// ------------------------------------------------------------------ Tiền trả trước

function credit(db, studentId) {
  const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN reservation_id IS NULL THEN amount END),0) AS free,
      COALESCE(SUM(CASE WHEN reservation_id IS NOT NULL THEN amount END),0) AS reserved FROM credit_entries WHERE student_id = ?`).get(studentId);
  return { free: r.free, reserved: r.reserved };
}
function creditHistory(db, studentId) {
  return db.prepare(`SELECT ce.*, u.full_name AS user_name, i.code AS invoice_code, r.code AS receipt_code FROM credit_entries ce
    LEFT JOIN users u ON u.id = ce.user_id LEFT JOIN invoices i ON i.id = ce.invoice_id LEFT JOIN receipts r ON r.id = ce.receipt_id
    WHERE ce.student_id = ? ORDER BY ce.id DESC`).all(studentId);
}

/** Dùng tiền trả trước (không thuộc bảo lưu) để thanh toán khoản phải thu */
function applyCredit(db, user, { invoice_id, amount = null, note = '' }) {
  const b = balance(db, invoice_id); assert(b && b.status === 'active', 'Không tìm thấy khoản phải thu', 404);
  const cr = credit(db, b.student_id).free;
  const amt = amount == null ? Math.min(cr, b.due) : mustMoney(amount);
  if (amt <= 0) return 0;
  assert(amt <= cr, `Tiền trả trước chỉ còn ${vnd(cr)}`);
  assert(amt <= b.due, `Khoản này chỉ còn nợ ${vnd(b.due)}`);
  return db.transaction(() => {
    const ce = Number(db.prepare("INSERT INTO credit_entries(student_id, amount, type, invoice_id, note, user_id) VALUES (?,?,'apply',?,?,?)")
      .run(b.student_id, -amt, invoice_id, note || `Trừ vào ${b.code}`, user ? user.id : null).lastInsertRowid);
    db.prepare("INSERT INTO allocations(invoice_id, amount, source, credit_entry_id, user_id) VALUES (?,?,'credit',?,?)").run(invoice_id, amt, ce, user ? user.id : null);
    audit.log(db, user, 'credit.apply', 'invoice', invoice_id, note || null, { amount: amt });
    return amt;
  })();
}

// ------------------------------------------------------------------ Phiếu thu

/**
 * Ghi nhận một lần nhận tiền → một phiếu thu.
 *  - Có invoice_id: thanh toán vào khoản phải thu có sẵn (thu nợ không tạo thêm học phí).
 *    Thu vượt số còn nợ chỉ được khi chọn "phần dư thành tiền trả trước".
 *  - Không có invoice_id: đặt cọc / trả trước → vào sổ trả trước.
 *  - idempotency_key: bấm xác nhận nhiều lần chỉ tạo một phiếu.
 */
function recordReceipt(db, user, input) {
  perms.require(user, 'collectMoney');
  const key = input.idempotency_key ? String(input.idempotency_key) : null;
  if (key) { const ex = db.prepare('SELECT id FROM receipts WHERE idempotency_key = ?').get(key); if (ex) return { id: ex.id, duplicate: true }; }
  const amount = mustMoney(input.amount);
  const method = input.method === 'transfer' ? 'transfer' : 'cash';
  const paid_date = D.parseInput(input.paid_date) || D.todayVN();
  assert(paid_date <= D.todayVN(), 'Ngày thu không được sau hôm nay');
  let inv = null; let studentId = Number(input.student_id);
  if (input.invoice_id) {
    inv = balance(db, Number(input.invoice_id)); assert(inv && inv.status === 'active', 'Không tìm thấy khoản phải thu', 404);
    studentId = inv.student_id;
    assert(inv.due > 0, 'Khoản này đã thanh toán đủ');
    if (amount > inv.due) assert(input.excess_to_credit, `Số tiền vượt số còn nợ (${vnd(inv.due)}). Chọn "chuyển phần dư thành tiền trả trước" nếu phụ huynh đóng trước.`);
  }
  assert(db.prepare('SELECT 1 FROM students WHERE id = ?').get(studentId), 'Không tìm thấy học sinh', 404);
  try {
    return db.transaction(() => {
      const code = nextCode(db, 'receipt', 'PT', 6);
      const id = Number(db.prepare(`INSERT INTO receipts(code, student_id, invoice_id, class_id, period_label, kind, amount, paid_date, method, payer_name, collector_id, note, idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, studentId, inv ? inv.id : null, inv ? inv.class_id : (input.class_id ? Number(input.class_id) : null),
        inv ? inv.period_label : (input.period_label || 'Đặt cọc / trả trước'), inv ? 'payment' : 'deposit', amount, paid_date, method,
        String(input.payer_name || '').trim(), user.id, String(input.note || '').trim(), key).lastInsertRowid);
      if (inv) {
        const toInv = Math.min(amount, inv.due);
        db.prepare("INSERT INTO allocations(invoice_id, amount, source, receipt_id, user_id) VALUES (?,?,'receipt',?,?)").run(inv.id, toInv, id, user.id);
        if (amount > toInv) db.prepare("INSERT INTO credit_entries(student_id, amount, type, receipt_id, note, user_id) VALUES (?,?,'overpay',?,?,?)").run(studentId, amount - toInv, id, `Phần dư phiếu ${code}`, user.id);
      } else {
        db.prepare("INSERT INTO credit_entries(student_id, amount, type, receipt_id, note, user_id) VALUES (?,?,'deposit',?,?,?)").run(studentId, amount, id, input.note || `Đặt cọc phiếu ${code}`, user.id);
      }
      audit.log(db, user, 'receipt.create', 'receipt', id, null, { code, amount, invoice: inv ? inv.code : null });
      return { id, duplicate: false };
    })();
  } catch (e) {
    if (key && String(e.message).includes('UNIQUE') && String(e.message).includes('idempotency_key')) {
      return { id: db.prepare('SELECT id FROM receipts WHERE idempotency_key = ?').get(key).id, duplicate: true };
    }
    throw e;
  }
}

function getReceipt(db, id) {
  return db.prepare(`SELECT r.*, s.full_name AS student_name, s.code AS student_code, s.parent_name, s.parent_phone, c.name AS class_name,
      u.full_name AS collector_name, vu.full_name AS voided_by_name, i.code AS invoice_code, i.amount AS invoice_amount
    FROM receipts r JOIN students s ON s.id = r.student_id LEFT JOIN classes c ON c.id = r.class_id LEFT JOIN users u ON u.id = r.collector_id
    LEFT JOIN users vu ON vu.id = r.voided_by LEFT JOIN invoices i ON i.id = r.invoice_id WHERE r.id = ?`).get(id);
}
function listReceipts(db, { from, to, studentId = null, method = null, includeVoid = true } = {}) {
  const where = ['r.paid_date >= ?', 'r.paid_date <= ?']; const args = [from || '0000-00-00', to || '9999-12-31'];
  if (studentId) { where.push('r.student_id = ?'); args.push(studentId); }
  if (method) { where.push('r.method = ?'); args.push(method); }
  if (!includeVoid) where.push("r.status = 'valid'");
  return db.prepare(`SELECT r.*, s.full_name AS student_name, s.code AS student_code, c.name AS class_name, u.full_name AS collector_name
    FROM receipts r JOIN students s ON s.id = r.student_id LEFT JOIN classes c ON c.id = r.class_id LEFT JOIN users u ON u.id = r.collector_id
    WHERE ${where.join(' AND ')} ORDER BY r.paid_date DESC, r.id DESC`).all(...args);
}

/** Hủy phiếu thu: không xóa, đánh dấu hủy + lý do, đảo phân bổ */
function voidReceipt(db, user, id, reason) {
  perms.require(user, 'adjustMoney', 'Bạn chưa được chủ trung tâm cấp quyền hủy phiếu thu');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do hủy phiếu');
  const r = getReceipt(db, id); assert(r && r.status === 'valid', 'Phiếu không tồn tại hoặc đã hủy');
  const creditFromReceipt = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_entries WHERE receipt_id = ?').get(id).s;
  if (creditFromReceipt > 0) {
    assert(credit(db, r.student_id).free >= creditFromReceipt, 'Tiền cọc/trả trước của phiếu này đã được dùng để thanh toán. Hãy điều chỉnh khoản phải thu liên quan trước.');
  }
  db.transaction(() => {
    db.prepare("UPDATE allocations SET status = 'void' WHERE receipt_id = ?").run(id);
    if (creditFromReceipt > 0) db.prepare("INSERT INTO credit_entries(student_id, amount, type, receipt_id, note, user_id) VALUES (?,?,'void',?,?,?)").run(r.student_id, -creditFromReceipt, id, `Hủy phiếu ${r.code}: ${reason}`, user.id);
    db.prepare("UPDATE receipts SET status = 'void', void_reason = ?, voided_by = ?, voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reason, user.id, id);
    audit.log(db, user, 'receipt.void', 'receipt', id, reason, { amount: r.amount });
  })();
}

/** Hoàn tiền trả trước cho phụ huynh: tạo đúng một phiếu chi */
function refundCredit(db, user, { student_id, amount, method, reason, idempotency_key }) {
  perms.require(user, 'spendMoney', 'Bạn chưa được cấp quyền chi tiền');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do hoàn tiền');
  if (idempotency_key) { const ex = db.prepare('SELECT id FROM cash_transactions WHERE idempotency_key = ?').get(idempotency_key); if (ex) return ex.id; }
  const amt = mustMoney(amount);
  const cr = credit(db, Number(student_id)).free; assert(amt <= cr, `Tiền trả trước chỉ còn ${vnd(cr)}`);
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(student_id);
  return db.transaction(() => {
    const code = nextCode(db, 'cash_out', 'PC', 6);
    const tid = Number(db.prepare(`INSERT INTO cash_transactions(code, direction, date, amount, category, party, method, note, student_id, idempotency_key, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, 'out', D.todayVN(), amt, 'refund', st.parent_name || st.full_name, method === 'transfer' ? 'transfer' : 'cash', reason, st.id, idempotency_key || null, user.id).lastInsertRowid);
    db.prepare("INSERT INTO credit_entries(student_id, amount, type, note, user_id) VALUES (?,?,'refund',?,?)").run(st.id, -amt, `Hoàn tiền ${code}: ${reason}`, user.id);
    audit.log(db, user, 'credit.refund', 'student', st.id, reason, { amount: amt, code });
    return tid;
  })();
}

module.exports = {
  CATEGORIES, METHODS, ATT_FREE, periodLabel, validSessions, attendanceMap, calcMonthly, calcCourse, calcPackage, calcPeriod, calcFirst, dueDateFor,
  balance, listInvoices, studentInvoices, getInvoice, createTuitionInvoice, createOtherInvoice, adjustInvoice, releaseToCredit, voidInvoice,
  credit, creditHistory, applyCredit, recordReceipt, getReceipt, listReceipts, voidReceipt, refundCredit, getEnrollment, getClassRow,
};
