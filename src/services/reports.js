'use strict';
/**
 * Báo cáo tài chính. Phân biệt rõ:
 *  - Thực thu: tiền thực nhận trong kỳ (phiếu thu học sinh + thu khác).
 *  - Thực chi: tiền thực trả trong kỳ.
 *  - Chênh lệch thu – chi tiền (KHÔNG phải lợi nhuận kế toán).
 *  - Công nợ: số phải thu chưa đóng (tại thời điểm xem).
 *  - Tiền trả trước chưa phân bổ và tiền đang giữ cho bảo lưu.
 */
const D = require('../lib/dates');
const cashbook = require('./cashbook');

function finance(db, { from, to }) {
  const rc = db.prepare(`SELECT method, kind, COUNT(*) n, COALESCE(SUM(amount),0) s FROM receipts WHERE status = 'valid' AND paid_date >= ? AND paid_date <= ? GROUP BY method, kind`).all(from, to);
  const tuitionIn = rc.reduce((a, r) => a + r.s, 0);
  const deposits = rc.filter((r) => r.kind === 'deposit').reduce((a, r) => a + r.s, 0);
  const otherIn = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_transactions WHERE status = 'valid' AND direction = 'in' AND date >= ? AND date <= ?").get(from, to).s;
  const outByCat = db.prepare("SELECT category, COUNT(*) n, COALESCE(SUM(amount),0) s FROM cash_transactions WHERE status = 'valid' AND direction = 'out' AND date >= ? AND date <= ? GROUP BY category ORDER BY s DESC").all(from, to)
    .map((r) => ({ ...r, label: cashbook.ALL_CATEGORIES[r.category] || r.category }));
  const inByCat = db.prepare("SELECT category, COUNT(*) n, COALESCE(SUM(amount),0) s FROM cash_transactions WHERE status = 'valid' AND direction = 'in' AND date >= ? AND date <= ? GROUP BY category").all(from, to)
    .map((r) => ({ ...r, label: cashbook.ALL_CATEGORIES[r.category] || r.category }));
  const totalOut = outByCat.reduce((a, r) => a + r.s, 0);
  const byMethod = { cash: 0, transfer: 0 };
  for (const r of rc) byMethod[r.method] += r.s;
  for (const r of db.prepare("SELECT method, direction, COALESCE(SUM(amount),0) s FROM cash_transactions WHERE status = 'valid' AND date >= ? AND date <= ? GROUP BY method, direction").all(from, to)) {
    byMethod[r.method] += r.direction === 'in' ? r.s : -r.s;
  }
  const billed = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM invoices WHERE status = 'active' AND date(created_at, '+7 hours') >= ? AND date(created_at, '+7 hours') <= ?`).get(from, to).s;
  return { from, to, tuitionIn, deposits, otherIn, totalIn: tuitionIn + otherIn, totalOut, net: tuitionIn + otherIn - totalOut, outByCat, inByCat, byMethod, receiptsByMethod: rc, billed, ...snapshot(db) };
}

/** Số dư tại thời điểm xem */
function snapshot(db) {
  const today = D.todayVN();
  const rows = db.prepare(`SELECT i.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status = 'valid'),0) AS due, i.due_date
    FROM invoices i WHERE i.status = 'active'`).all().filter((r) => r.due > 0);
  const debt = rows.reduce((a, r) => a + r.due, 0);
  const overdue = rows.filter((r) => r.due_date && r.due_date < today).reduce((a, r) => a + r.due, 0);
  const cr = db.prepare(`SELECT COALESCE(SUM(CASE WHEN reservation_id IS NULL THEN amount END),0) free, COALESCE(SUM(CASE WHEN reservation_id IS NOT NULL THEN amount END),0) reserved FROM credit_entries`).get();
  return { debt, overdue, debtCount: rows.length, prepaid: cr.free, reservedCredit: cr.reserved };
}

function debtByStudent(db) {
  return db.prepare(`SELECT s.id, s.code, s.full_name, s.parent_name, s.parent_phone, COUNT(*) AS n, SUM(x.due) AS due, MIN(x.due_date) AS oldest_due,
      group_concat(x.label, '; ') AS items
    FROM (SELECT i.student_id, i.due_date, COALESCE(c.name || ' – ', '') || COALESCE(i.period_label, i.description) AS label,
      i.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status = 'valid'),0) AS due
      FROM invoices i LEFT JOIN classes c ON c.id = i.class_id WHERE i.status = 'active') x
    JOIN students s ON s.id = x.student_id WHERE x.due > 0 GROUP BY s.id ORDER BY due DESC`).all();
}

function revenueByClass(db, { from, to }) {
  return db.prepare(`SELECT c.id, c.name, c.fee_type,
      (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') AS students,
      COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.class_id = c.id AND r.status = 'valid' AND r.paid_date >= ? AND r.paid_date <= ?),0) AS collected,
      COALESCE((SELECT SUM(i.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.invoice_id = i.id AND a.status='valid'),0))
        FROM invoices i WHERE i.class_id = c.id AND i.status = 'active'),0) AS debt
    FROM classes c WHERE c.status <> 'cancelled' ORDER BY c.name`).all(from, to);
}

function attendanceByClass(db, { from, to }) {
  return db.prepare(`SELECT c.name, COUNT(DISTINCT s.id) AS sessions, SUM(a.status='present') AS present, SUM(a.status='excused') AS excused,
      SUM(a.status='unexcused') AS unexcused, SUM(a.status='unmarked') AS unmarked
    FROM class_sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN attendance a ON a.session_id = s.id
    WHERE s.status = 'completed' AND s.date >= ? AND s.date <= ? GROUP BY c.id ORDER BY c.name`).all(from, to);
}

module.exports = { finance, snapshot, debtByStudent, revenueByClass, attendanceByClass };
