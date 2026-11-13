'use strict';
const D = require('../lib/dates');
const { assert } = require('../lib/errors');
const { nextCode } = require('../db');
const audit = require('./audit');

const t = (s) => (s == null ? '' : String(s).trim());
function normPhone(p) {
  let s = t(p).replace(/[\s.\-()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (/^84\d{9}$/.test(s)) s = '0' + s.slice(2);
  return s;
}
function validPhone(p) { return !p || /^0\d{9,10}$/.test(p); }

function readInput(input) {
  const full_name = t(input.full_name).replace(/\s+/g, ' ');
  assert(full_name, 'Vui lòng nhập họ tên học sinh');
  const dobRaw = t(input.dob);
  const dob = dobRaw ? D.parseInput(dobRaw) : null;
  assert(!dobRaw || dob, 'Ngày sinh không hợp lệ (dd/mm/yyyy)');
  const parent_phone = normPhone(input.parent_phone);
  assert(validPhone(parent_phone), 'Số điện thoại phụ huynh không hợp lệ');
  return {
    full_name, dob, gender: t(input.gender), parent_name: t(input.parent_name), parent_phone,
    address: t(input.address), entry_level: t(input.entry_level), note: t(input.note),
  };
}

/** Tạo hồ sơ. Mã HS tự sinh. Không dùng SĐT làm khóa: anh chị em có thể chung số phụ huynh. */
function createStudent(db, user, input) {
  const v = readInput(input);
  return db.transaction(() => {
    const code = nextCode(db, 'student', 'HS', 5);
    const id = Number(db.prepare(`INSERT INTO students(code, full_name, dob, gender, parent_name, parent_phone, address, entry_level, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(code, v.full_name, v.dob, v.gender, v.parent_name, v.parent_phone, v.address, v.entry_level, v.note, user ? user.id : null).lastInsertRowid);
    audit.log(db, user, 'student.create', 'student', id, null, { code, ...v });
    return id;
  })();
}
function updateStudent(db, user, id, input) {
  const old = getStudent(db, id); assert(old, 'Không tìm thấy học sinh', 404);
  const v = readInput(input);
  const status = input.status === 'inactive' ? 'inactive' : 'active';
  db.prepare(`UPDATE students SET full_name=?, dob=?, gender=?, parent_name=?, parent_phone=?, address=?, entry_level=?, note=?, status=? WHERE id=?`)
    .run(v.full_name, v.dob, v.gender, v.parent_name, v.parent_phone, v.address, v.entry_level, v.note, status, id);
  audit.log(db, user, 'student.update', 'student', id);
}
function getStudent(db, id) { return db.prepare('SELECT * FROM students WHERE id = ?').get(id); }

/** Hồ sơ có thể trùng: cùng họ tên + ngày sinh, hoặc cùng họ tên + SĐT phụ huynh */
function findPossibleDuplicates(db, { full_name, dob, parent_phone }) {
  const name = t(full_name).replace(/\s+/g, ' ');
  if (!name) return [];
  return db.prepare(`SELECT * FROM students WHERE lower(full_name) = lower(?) AND ((? IS NOT NULL AND dob = ?) OR (? <> '' AND parent_phone = ?))`)
    .all(name, dob || null, dob || null, normPhone(parent_phone), normPhone(parent_phone));
}
function siblings(db, student) {
  if (!student.parent_phone) return [];
  return db.prepare('SELECT id, code, full_name FROM students WHERE parent_phone = ? AND id <> ?').all(student.parent_phone, student.id);
}

function search(db, { q = '', status = 'active', classId = null, limit = 500 } = {}) {
  const where = []; const args = [];
  if (status && status !== 'all') { where.push('s.status = ?'); args.push(status); }
  if (q) {
    where.push('(s.full_name LIKE ? OR s.code LIKE ? OR s.parent_phone LIKE ? OR s.parent_name LIKE ?)');
    const like = `%${t(q)}%`; args.push(like, like, `%${normPhone(q) || t(q)}%`, like);
  }
  if (classId) { where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.class_id = ? AND e.status IN ('active','reserved'))"); args.push(classId); }
  args.push(limit);
  return db.prepare(`SELECT s.*,
      (SELECT group_concat(c.name, ', ') FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.status = 'active') AS active_classes,
      (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.id AND e.status = 'waiting') AS waiting_count,
      (SELECT COUNT(*) FROM enrollments e WHERE e.student_id = s.id AND e.status = 'reserved') AS reserved_count
    FROM students s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.full_name LIMIT ?`).all(...args);
}

// ---- Nhập Excel
const IMPORT_COLUMNS = [
  { key: 'full_name', label: 'Họ tên học sinh (*)' },
  { key: 'dob', label: 'Ngày sinh (dd/mm/yyyy)' },
  { key: 'gender', label: 'Giới tính' },
  { key: 'parent_name', label: 'Họ tên phụ huynh' },
  { key: 'parent_phone', label: 'SĐT phụ huynh' },
  { key: 'address', label: 'Địa chỉ' },
  { key: 'entry_level', label: 'Trình độ đầu vào' },
  { key: 'note', label: 'Ghi chú' },
];

/** Kiểm tra từng dòng: lỗi (không lưu được) và cảnh báo (có thể trùng hồ sơ) */
function validateImportRows(db, rows) {
  const seen = new Map();
  return rows.map((r, i) => {
    const errors = []; const warnings = [];
    let v = null;
    try { v = readInput(r); } catch (e) { errors.push(e.message); }
    if (v) {
      const key = `${v.full_name.toLowerCase()}|${v.dob || ''}|${v.parent_phone}`;
      if (seen.has(key)) errors.push(`Trùng với dòng ${seen.get(key)} trong file`); else seen.set(key, r.__row || i + 2);
      const dups = findPossibleDuplicates(db, v);
      if (dups.length) warnings.push(`Có thể đã có hồ sơ: ${dups.map((d) => d.code + ' ' + d.full_name).join(', ')}`);
      if (v.parent_phone) {
        const sib = db.prepare('SELECT code, full_name FROM students WHERE parent_phone = ?').all(v.parent_phone).filter((s) => s.full_name.toLowerCase() !== v.full_name.toLowerCase());
        if (sib.length) warnings.push(`Chung SĐT phụ huynh với ${sib.map((s) => s.code).join(', ')} (anh chị em?) – vẫn tạo hồ sơ riêng`);
      }
    }
    return { row: r.__row || i + 2, input: r, value: v, errors, warnings };
  });
}

function commitImport(db, user, batchId, { skipWarnings = false } = {}) {
  const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  assert(b, 'Không tìm thấy phiên nhập dữ liệu', 404);
  if (b.status === 'done') return JSON.parse(b.data).result; // bấm lưu lần 2 không tạo trùng
  const rows = validateImportRows(db, JSON.parse(b.data).rows);
  return db.transaction(() => {
    const created = []; const skipped = [];
    for (const r of rows) {
      if (r.errors.length || (skipWarnings && r.warnings.some((w) => w.startsWith('Có thể')))) { skipped.push(r.row); continue; }
      created.push(createStudent(db, user, r.input));
    }
    const result = { created: created.length, skipped };
    db.prepare("UPDATE import_batches SET status = 'done', data = ? WHERE id = ?").run(JSON.stringify({ rows: [], result }), batchId);
    return result;
  })();
}

module.exports = { normPhone, createStudent, updateStudent, getStudent, findPossibleDuplicates, siblings, search, IMPORT_COLUMNS, validateImportRows, commitImport };
