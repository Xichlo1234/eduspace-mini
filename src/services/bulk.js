'use strict';
/** Tạo học phí hàng loạt cho kỳ tiếp theo: xem trước + danh sách ngoại lệ, chỉ ghi khi xác nhận */
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const perms = require('./perms');
const B = require('./billing');
const E = require('./enrollments');
const classes = require('./classes');
const settings = require('./settings');
const audit = require('./audit');

function preview(db, { ym }) {
  assert(D.isValidMonth(ym), 'Tháng không hợp lệ');
  classes.extendAll(db, D.monthEnd(ym));
  const items = []; const exceptions = [];
  const ms = D.monthStart(ym); const me = D.monthEnd(ym);
  const low = settings.getInt(db, 'package_low_threshold');

  const enrs = db.prepare(`SELECT e.*, s.full_name, s.code, c.name AS class_name, c.fee_type FROM enrollments e JOIN students s ON s.id = e.student_id
    JOIN classes c ON c.id = e.class_id WHERE c.status = 'active' AND e.status IN ('active','reserved') ORDER BY c.name, s.full_name`).all();
  for (const e of enrs) {
    const cls = B.getClassRow(db, e.class_id);
    const base = { enrollment_id: e.id, student_id: e.student_id, student: `${e.code} – ${e.full_name}`, class_name: e.class_name, fee_type: e.fee_type };
    if (e.status === 'reserved') {
      if (e.fee_type === 'monthly') exceptions.push({ ...base, reason: 'Đang bảo lưu – không phát sinh học phí' });
      continue;
    }
    if (e.fee_type === 'monthly') {
      if (e.start_date > me || (e.end_date && e.end_date < ms)) continue;
      const ex = db.prepare("SELECT code FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(e.id, ym);
      if (ex) { exceptions.push({ ...base, reason: `Đã có khoản ${ex.code} cho tháng này – bỏ qua` }); continue; }
      const c = B.calcMonthly(db, e, cls, ym);
      if (c.error) { exceptions.push({ ...base, reason: c.error }); continue; }
      const cr = B.credit(db, e.student_id).free;
      items.push({ ...base, key: `${e.id}|${ym}`, period_key: ym, period_label: c.period_label, amount: c.base_amount, lines: c.lines, credit: cr,
        note: c.base_amount !== cls.fee_amount ? 'Khác mức phí tháng – xem diễn giải' : '' });
    } else if (e.fee_type === 'package') {
      const u = E.packageUsage(db, e.id);
      const unpaid = db.prepare(`SELECT COUNT(*) n FROM invoices i WHERE i.enrollment_id = ? AND i.status = 'active' AND i.period_key LIKE 'PKG-%'
        AND i.amount > COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status = 'valid'),0)`).get(e.id).n;
      if (u.remaining > low) continue;
      if (unpaid) { exceptions.push({ ...base, reason: `Còn ${u.remaining} buổi nhưng gói trước chưa đóng đủ – nhắc phí trước` }); continue; }
      const c = B.calcPackage(db, e, cls);
      items.push({ ...base, key: `${e.id}|${c.period_key}`, period_key: c.period_key, period_label: c.period_label, amount: c.base_amount, lines: c.lines,
        credit: B.credit(db, e.student_id).free, note: `Gói hiện tại còn ${u.remaining} buổi` });
    } else if (e.fee_type === 'course') {
      const ex = db.prepare("SELECT 1 FROM invoices WHERE enrollment_id = ? AND period_key = 'COURSE' AND status = 'active'").get(e.id);
      if (ex) continue;
      const c = B.calcCourse(db, e, cls);
      if (c.error) { exceptions.push({ ...base, reason: c.error }); continue; }
      items.push({ ...base, key: `${e.id}|COURSE`, period_key: 'COURSE', period_label: 'Cả khóa', amount: c.base_amount, lines: c.lines, credit: B.credit(db, e.student_id).free, note: 'Chưa có học phí khóa' });
    }
  }
  return { ym, items, exceptions, total: items.reduce((a, i) => a + i.amount, 0) };
}

/** Ghi các khoản đã chọn. Chạy lại không tạo trùng (ràng buộc duy nhất học sinh + lớp + kỳ). */
function commit(db, user, { ym, keys, apply_credit = true }) {
  perms.require(user, 'collectMoney');
  const p = preview(db, { ym });
  const want = new Set(keys || []);
  let created = 0; let skipped = 0; let applied = 0;
  db.transaction(() => {
    for (const it of p.items) {
      if (!want.has(it.key)) continue;
      const exists = db.prepare("SELECT 1 FROM invoices WHERE enrollment_id = ? AND period_key = ? AND status = 'active'").get(it.enrollment_id, it.period_key);
      if (exists) { skipped++; continue; }
      const id = B.createTuitionInvoice(db, user, { enrollment_id: it.enrollment_id, ym: /^\d{4}-\d{2}$/.test(it.period_key) ? it.period_key : null });
      created++;
      if (apply_credit) applied += B.applyCredit(db, user, { invoice_id: id, note: 'Trừ tiền trả trước khi tạo học phí kỳ mới' });
    }
    audit.log(db, user, 'invoice.bulk', 'invoice', null, null, { ym, created, skipped, applied });
  })();
  return { created, skipped, applied };
}

module.exports = { preview, commit };
