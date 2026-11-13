'use strict';
/**
 * Liên lạc phụ huynh: tạo nội dung từ mẫu, người dùng xem trước, sao chép gửi qua Zalo rồi tự đánh dấu "đã liên hệ".
 * Ứng dụng KHÔNG tự gửi và không bao giờ hiển thị "đã gửi" khi chưa gửi thực tế.
 */
const D = require('../lib/dates');
const { vnd } = require('../lib/money');
const { assert } = require('../lib/errors');
const settings = require('./settings');
const audit = require('./audit');

const TEMPLATES = { fee: 'Nhắc học phí', absence: 'Thông báo vắng học', schedule: 'Thay đổi lịch học', review: 'Nhận xét học tập' };
const ATT = { excused: 'vắng có phép', unexcused: 'vắng không phép', present: 'có mặt', unmarked: 'chưa điểm danh' };

function fill(tpl, vars) { return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }

function build(db, { type, student_id, invoice_id, session_id, class_id, change_text }) {
  assert(TEMPLATES[type], 'Mẫu tin không hợp lệ');
  const s = settings.getAll(db);
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(student_id); assert(st, 'Không tìm thấy học sinh', 404);
  const vars = {
    hoc_sinh: st.full_name, phu_huynh: st.parent_name || 'phụ huynh', trung_tam: s.center_name, sdt_trung_tam: s.center_phone,
    thong_tin_chuyen_khoan: s.bank_info ? `Chuyển khoản: ${s.bank_info} – nội dung: ${st.code} ${st.full_name}` : '', ngay: D.display(D.todayVN()),
  };
  if (type === 'fee') {
    const rows = invoice_id
      ? db.prepare("SELECT i.*, c.name AS class_name FROM invoices i LEFT JOIN classes c ON c.id = i.class_id WHERE i.id = ? AND i.student_id = ?").all(invoice_id, student_id)
      : db.prepare("SELECT i.*, c.name AS class_name FROM invoices i LEFT JOIN classes c ON c.id = i.class_id WHERE i.student_id = ? AND i.status = 'active'").all(student_id);
    const withPaid = rows.map((i) => ({ ...i, paid: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM allocations WHERE invoice_id = ? AND status='valid'").get(i.id).s })).filter((i) => invoice_id || i.amount - i.paid > 0);
    const sum = (f) => withPaid.reduce((a, i) => a + f(i), 0);
    Object.assign(vars, {
      lop: [...new Set(withPaid.map((i) => i.class_name || i.description))].join(', '), ky: withPaid.map((i) => i.period_label).join(', '),
      so_tien_phai_thu: vnd(sum((i) => i.amount)), so_tien_da_dong: vnd(sum((i) => i.paid)), so_tien_con_no: vnd(sum((i) => i.amount - i.paid)),
      han_dong: withPaid.map((i) => D.display(i.due_date)).filter(Boolean).sort()[0] || '',
    });
  }
  if (type === 'absence' && session_id) {
    const se = db.prepare('SELECT s.*, c.name AS class_name FROM class_sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?').get(session_id);
    const a = db.prepare('SELECT status FROM attendance WHERE session_id = ? AND student_id = ?').get(session_id, student_id);
    Object.assign(vars, { lop: se.class_name, ngay: D.display(se.date), gio: `${se.start_time}–${se.end_time}`, trang_thai_vang: ATT[a ? a.status : 'unmarked'] });
  }
  if ((type === 'schedule' || type === 'review' || type === 'absence') && class_id && !vars.lop) {
    const c = db.prepare('SELECT name FROM classes WHERE id = ?').get(class_id); vars.lop = c ? c.name : '';
  }
  if (type === 'schedule') vars.noi_dung_thay_doi = change_text || '[ghi nội dung thay đổi]';
  if (type === 'review') {
    const args = [student_id]; let extra = '';
    if (class_id) { extra = 'AND s.class_id = ?'; args.push(class_id); }
    const rows = db.prepare(`SELECT a.*, s.date FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE a.student_id = ? ${extra} ORDER BY s.date DESC LIMIT 8`).all(...args);
    vars.nhan_xet = rows.filter((r) => r.comment || r.score != null).map((r) => `- ${D.display(r.date)}: ${r.score != null ? `điểm ${r.score}. ` : ''}${r.comment || ''}`).join('\n') || '[nhập nhận xét]';
    vars.chuyen_can = `${rows.filter((r) => r.status === 'present').length}/${rows.length} buổi có mặt gần đây`;
  }
  return { type, title: TEMPLATES[type], text: fill(s[`tpl_${type}`] || '', vars).replace(/\n{3,}/g, '\n\n').trim(), student: st };
}

/** Ghi nhận việc người dùng đã tự liên hệ phụ huynh */
function markContacted(db, user, { student_id, template, content, channel, note }) {
  assert(String(content || '').trim(), 'Nội dung trống');
  const id = Number(db.prepare('INSERT INTO contact_logs(student_id, template, content, channel, note, user_id) VALUES (?,?,?,?,?,?)')
    .run(Number(student_id), template || null, String(content).trim(), channel || 'zalo', String(note || '').trim(), user.id).lastInsertRowid);
  audit.log(db, user, 'contact.log', 'student', Number(student_id), null, { template, channel });
  return id;
}
function history(db, studentId) {
  return db.prepare('SELECT l.*, u.full_name AS user_name FROM contact_logs l LEFT JOIN users u ON u.id = l.user_id WHERE l.student_id = ? ORDER BY l.id DESC').all(studentId);
}
function zaloLink(phone) { const p = String(phone || '').replace(/\D/g, ''); return p ? `https://zalo.me/${p}` : null; }

module.exports = { TEMPLATES, build, markContacted, history, zaloLink, fill };
