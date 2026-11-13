'use strict';
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const { mustMoney } = require('../lib/money');
const { nextCode } = require('../db');
const audit = require('./audit');
const perms = require('./perms');

const IN_CATEGORIES = { book_sale: 'Bán sách/giáo trình', uniform_sale: 'Bán đồng phục', other_in: 'Thu khác' };
const OUT_CATEGORIES = { rent: 'Thuê mặt bằng/phòng', utilities: 'Điện, nước, internet', materials: 'Giáo trình, đồ dùng', teacher_pay: 'Tiền dạy giáo viên', marketing: 'Quảng cáo, tuyển sinh', refund: 'Hoàn tiền học phí', other_out: 'Chi khác' };
const ALL_CATEGORIES = { ...IN_CATEGORIES, ...OUT_CATEGORIES };

function create(db, user, input) {
  const direction = input.direction === 'out' ? 'out' : 'in';
  if (direction === 'out') perms.require(user, 'spendMoney', 'Bạn chưa được chủ trung tâm cấp quyền chi tiền');
  else perms.require(user, 'collectMoney');
  const key = input.idempotency_key ? String(input.idempotency_key) : null;
  if (key) { const ex = db.prepare('SELECT id FROM cash_transactions WHERE idempotency_key = ?').get(key); if (ex) return ex.id; }
  const cats = direction === 'in' ? IN_CATEGORIES : OUT_CATEGORIES;
  assert(cats[input.category], 'Vui lòng chọn danh mục');
  assert(input.category !== 'teacher_pay', 'Chi tiền dạy thực hiện ở mục Giáo viên → Tiền dạy để đối chiếu đúng số buổi');
  assert(input.category !== 'refund', 'Hoàn tiền thực hiện trong hồ sơ học sinh để trừ đúng tiền trả trước');
  const amount = mustMoney(input.amount);
  const date = D.parseInput(input.date) || D.todayVN();
  return db.transaction(() => {
    const code = nextCode(db, direction === 'in' ? 'cash_in' : 'cash_out', direction === 'in' ? 'TK' : 'PC', 6);
    const id = Number(db.prepare(`INSERT INTO cash_transactions(code, direction, date, amount, category, party, method, note, idempotency_key, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, direction, date, amount, input.category, String(input.party || '').trim(), input.method === 'transfer' ? 'transfer' : 'cash',
      String(input.note || '').trim(), key, user.id).lastInsertRowid);
    audit.log(db, user, 'cash.create', 'cash', id, null, { code, direction, amount, category: input.category });
    return id;
  })();
}

function voidTx(db, user, id, reason) {
  perms.require(user, 'adjustMoney', 'Bạn chưa được chủ trung tâm cấp quyền hủy giao dịch');
  reason = String(reason || '').trim(); assert(reason, 'Vui lòng nhập lý do hủy');
  const t = db.prepare('SELECT * FROM cash_transactions WHERE id = ?').get(id); assert(t && t.status === 'valid', 'Giao dịch không tồn tại hoặc đã hủy');
  assert(t.category !== 'refund', 'Phiếu hoàn tiền đã trừ tiền trả trước của học sinh; hãy ghi nhận lại bằng phiếu thu nếu hoàn nhầm');
  db.prepare("UPDATE cash_transactions SET status = 'void', void_reason = ?, voided_by = ?, voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(reason, user.id, id);
  audit.log(db, user, 'cash.void', 'cash', id, reason, { amount: t.amount });
}

function list(db, { from, to, direction = null, category = null } = {}) {
  const where = ['t.date >= ?', 't.date <= ?']; const args = [from || '0000-00-00', to || '9999-12-31'];
  if (direction) { where.push('t.direction = ?'); args.push(direction); }
  if (category) { where.push('t.category = ?'); args.push(category); }
  return db.prepare(`SELECT t.*, u.full_name AS created_by_name, te.full_name AS teacher_name FROM cash_transactions t
    LEFT JOIN users u ON u.id = t.created_by LEFT JOIN teachers te ON te.id = t.teacher_id
    WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC`).all(...args);
}
function get(db, id) {
  return db.prepare(`SELECT t.*, u.full_name AS created_by_name, vu.full_name AS voided_by_name FROM cash_transactions t
    LEFT JOIN users u ON u.id = t.created_by LEFT JOIN users vu ON vu.id = t.voided_by WHERE t.id = ?`).get(id);
}

module.exports = { IN_CATEGORIES, OUT_CATEGORIES, ALL_CATEGORIES, create, voidTx, list, get };
