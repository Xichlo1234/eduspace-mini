'use strict';
/**
 * Tạo học phí hàng loạt: xem trước + danh sách ngoại lệ, chỉ ghi khi xác nhận.
 *  - Lớp THU ĐẦU KỲ: lập học phí cho tháng `ym` (thường là tháng sau); gói buổi: đề xuất gói mới khi sắp hết; khóa: khi chưa có học phí khóa.
 *  - Lớp THU CUỐI KỲ: lập học phí cho tháng `ymPost` đã học (thường là tháng vừa qua / tháng hiện tại lúc cuối tháng);
 *    lớp theo buổi tính theo số buổi thực học; lớp khóa lập khi khóa kết thúc.
 */
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const perms = require('./perms');
const B = require('./billing');
const E = require('./enrollments');
const classes = require('./classes');
const settings = require('./settings');
const audit = require('./audit');

/** Tháng thu cuối kỳ gợi ý: từ ngày 25 trở đi là tháng hiện tại, trước đó là tháng trước */
function defaultPostMonth(today = D.todayVN()) {
  return Number(today.slice(8, 10)) >= 25 ? D.monthOf(today) : D.monthOf(D.addDays(D.monthStart(D.monthOf(today)), -1));
}

function preview(db, { ym, ymPost = null }) {
  assert(D.isValidMonth(ym), 'Tháng không hợp lệ');
  ymPost = D.isValidMonth(ymPost) ? ymPost : defaultPostMonth();
  classes.extendAll(db, D.monthEnd(ym > ymPost ? ym : ymPost));
  const items = []; const exceptions = [];
  const low = settings.getInt(db, 'package_low_threshold');
  const today = D.todayVN();
  const has = (enrId, key) => db.prepare("SELECT code FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(enrId, key);

  const enrs = db.prepare(`SELECT e.*, s.full_name, s.code, c.name AS class_name, c.fee_type, c.billing_timing FROM enrollments e JOIN students s ON s.id = e.student_id
    JOIN classes c ON c.id = e.class_id WHERE c.status IN ('active','finished') AND e.status IN ('active','reserved') ORDER BY c.name, s.full_name`).all();
  for (const e of enrs) {
    const cls = B.getClassRow(db, e.class_id);
    const post = B.isPostpaid(cls);
    const base = { enrollment_id: e.id, student_id: e.student_id, student: `${e.code} – ${e.full_name}`, class_name: e.class_name, fee_type: e.fee_type, timing: post ? 'postpaid' : 'prepaid' };
    const push = (c, note = '') => items.push({ ...base, key: `${e.id}|${c.period_key}`, period_key: c.period_key, period_label: c.period_label, amount: c.base_amount, lines: c.lines,
      credit: B.credit(db, e.student_id).free, note });
    if (e.status === 'reserved') {
      if (e.fee_type !== 'course') exceptions.push({ ...base, reason: 'Đang bảo lưu – không phát sinh học phí' });
      continue;
    }
    if (post) {
      // ----- THU CUỐI KỲ
      const ms = D.monthStart(ymPost); const me = D.monthEnd(ymPost);
      if (e.fee_type === 'course') {
        if (has(e.id, 'COURSE')) continue;
        const last = db.prepare("SELECT MAX(date) d FROM class_sessions WHERE class_id = ? AND status <> 'cancelled'").get(cls.id).d;
        if (!last || last > me) continue; // khóa chưa kết thúc
        const c = B.calcCourse(db, e, cls);
        if (c.error) { exceptions.push({ ...base, reason: c.error }); continue; }
        push(c, `Khóa kết thúc ${D.display(last)}`);
        continue;
      }
      if (e.start_date > me || (e.end_date && e.end_date < ms)) continue;
      const ex = has(e.id, ymPost);
      if (ex) { exceptions.push({ ...base, reason: `Đã có khoản ${ex.code} cho tháng ${D.displayMonth(ymPost)} – bỏ qua` }); continue; }
      const c = e.fee_type === 'monthly' ? B.calcMonthly(db, e, cls, ymPost) : B.calcPackageUsage(db, e, cls, ymPost);
      if (c.error) { if (!/Không có buổi học nào được tính phí/.test(c.error) || c.pending) exceptions.push({ ...base, reason: c.error }); continue; }
      const notes = [];
      if (today < me) notes.push('Tháng chưa kết thúc');
      if (c.pending) notes.push(`${c.pending} buổi chưa điểm danh`);
      push(c, notes.join(' · '));
      continue;
    }
    // ----- THU ĐẦU KỲ
    if (e.fee_type === 'monthly') {
      const ms = D.monthStart(ym); const me = D.monthEnd(ym);
      if (e.start_date > me || (e.end_date && e.end_date < ms)) continue;
      const ex = has(e.id, ym);
      if (ex) { exceptions.push({ ...base, reason: `Đã có khoản ${ex.code} cho tháng ${D.displayMonth(ym)} – bỏ qua` }); continue; }
      const c = B.calcMonthly(db, e, cls, ym);
      if (c.error) { exceptions.push({ ...base, reason: c.error }); continue; }
      push(c, c.base_amount !== cls.fee_amount ? 'Khác mức phí tháng – xem diễn giải' : '');
    } else if (e.fee_type === 'package') {
      const u = E.packageUsage(db, e.id);
      const unpaid = db.prepare(`SELECT COUNT(*) n FROM invoices i WHERE i.enrollment_id = ? AND i.status = 'active' AND i.period_key LIKE 'PKG-%'
        AND i.amount > COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status = 'valid'),0)`).get(e.id).n;
      if (u.remaining > low) continue;
      if (unpaid) { exceptions.push({ ...base, reason: `Còn ${u.remaining} buổi nhưng gói trước chưa đóng đủ – nhắc phí trước` }); continue; }
      push(B.calcPackage(db, e, cls), `Gói hiện tại còn ${u.remaining} buổi`);
    } else if (e.fee_type === 'course') {
      if (has(e.id, 'COURSE')) continue;
      const c = B.calcCourse(db, e, cls);
      if (c.error) { exceptions.push({ ...base, reason: c.error }); continue; }
      push(c, 'Chưa có học phí khóa');
    }
  }
  const sum = (t) => items.filter((i) => i.timing === t).reduce((a, i) => a + i.amount, 0);
  return { ym, ymPost, items, exceptions, total: items.reduce((a, i) => a + i.amount, 0), totalPre: sum('prepaid'), totalPost: sum('postpaid') };
}

/** Ghi các khoản đã chọn. Chạy lại không tạo trùng (ràng buộc duy nhất học sinh + lớp + kỳ). */
function commit(db, user, { ym, ymPost = null, keys, apply_credit = true }) {
  perms.require(user, 'collectMoney');
  const p = preview(db, { ym, ymPost });
  const want = new Set(keys || []);
  let created = 0; let skipped = 0; let applied = 0;
  db.transaction(() => {
    for (const it of p.items) {
      if (!want.has(it.key)) continue;
      if (db.prepare("SELECT 1 FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(it.enrollment_id, it.period_key)) { skipped++; continue; }
      const id = B.createTuitionInvoice(db, user, { enrollment_id: it.enrollment_id, ym: /^\d{4}-\d{2}$/.test(it.period_key) ? it.period_key : null });
      created++;
      if (apply_credit) applied += B.applyCredit(db, user, { invoice_id: id, note: 'Trừ tiền trả trước khi tạo học phí' });
    }
    audit.log(db, user, 'invoice.bulk', 'invoice', null, null, { ym, ymPost: p.ymPost, created, skipped, applied });
  })();
  return { created, skipped, applied };
}

module.exports = { preview, commit, defaultPostMonth };
