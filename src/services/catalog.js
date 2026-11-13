'use strict';
const { assert } = require('../lib/errors');
const { mustMoney } = require('../lib/money');
const audit = require('./audit');

const t = (s) => (s == null ? '' : String(s).trim());

// ---- Môn học / chương trình
function listSubjects(db, all = false) { return db.prepare(`SELECT * FROM subjects ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all(); }
function saveSubject(db, user, { id, name, description, active }) {
  name = t(name); assert(name, 'Vui lòng nhập tên môn học');
  const dup = db.prepare('SELECT id FROM subjects WHERE name = ? AND id IS NOT ?').get(name, id || null);
  assert(!dup, 'Môn học này đã có');
  if (id) db.prepare('UPDATE subjects SET name=?, description=?, active=? WHERE id=?').run(name, t(description), active === false || active === '0' ? 0 : 1, id);
  else id = db.prepare('INSERT INTO subjects(name, description) VALUES (?,?)').run(name, t(description)).lastInsertRowid;
  return Number(id);
}

// ---- Phòng học
function listRooms(db, all = false) { return db.prepare(`SELECT * FROM rooms ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all(); }
function saveRoom(db, user, { id, name, capacity, active }) {
  name = t(name); assert(name, 'Vui lòng nhập tên phòng');
  const dup = db.prepare('SELECT id FROM rooms WHERE name = ? AND id IS NOT ?').get(name, id || null);
  assert(!dup, 'Tên phòng đã có');
  const cap = capacity ? parseInt(capacity, 10) || null : null;
  if (id) db.prepare('UPDATE rooms SET name=?, capacity=?, active=? WHERE id=?').run(name, cap, active === false || active === '0' ? 0 : 1, id);
  else id = db.prepare('INSERT INTO rooms(name, capacity) VALUES (?,?)').run(name, cap).lastInsertRowid;
  return Number(id);
}

// ---- Giáo viên
function listTeachers(db, all = false) { return db.prepare(`SELECT * FROM teachers ${all ? '' : 'WHERE active = 1'} ORDER BY full_name`).all(); }
function getTeacher(db, id) { return db.prepare('SELECT * FROM teachers WHERE id = ?').get(id); }
function saveTeacher(db, user, { id, full_name, phone, email, default_rate, note, active }) {
  full_name = t(full_name); assert(full_name, 'Vui lòng nhập tên giáo viên');
  const rate = default_rate === '' || default_rate == null ? 0 : mustMoney(default_rate, 'Đơn giá/buổi', { allowZero: true });
  if (id) {
    const old = getTeacher(db, id);
    db.prepare('UPDATE teachers SET full_name=?, phone=?, email=?, default_rate=?, note=?, active=? WHERE id=?')
      .run(full_name, t(phone), t(email), rate, t(note), active === false || active === '0' ? 0 : 1, id);
    if (old && old.default_rate !== rate) audit.log(db, user, 'teacher.rate', 'teacher', id, null, { from: old.default_rate, to: rate });
  } else {
    id = db.prepare('INSERT INTO teachers(full_name, phone, email, default_rate, note) VALUES (?,?,?,?,?)').run(full_name, t(phone), t(email), rate, t(note)).lastInsertRowid;
  }
  return Number(id);
}

/** Trung tâm chỉ dạy tiếng Anh: mọi lớp gắn môn "Tiếng Anh" (tự tạo nếu chưa có) */
const DEFAULT_SUBJECT = 'Tiếng Anh';
function defaultSubjectId(db) {
  const r = db.prepare('SELECT id FROM subjects WHERE name = ?').get(DEFAULT_SUBJECT);
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO subjects(name) VALUES (?)').run(DEFAULT_SUBJECT).lastInsertRowid);
}

module.exports = { DEFAULT_SUBJECT, defaultSubjectId, listSubjects, saveSubject, listRooms, saveRoom, listTeachers, getTeacher, saveTeacher };
