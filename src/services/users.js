'use strict';
const { assert, AppError } = require('../lib/errors');
const { hashPassword, verifyPassword, validatePassword, randomToken } = require('../lib/password');
const audit = require('./audit');
const perms = require('./perms');

const ROLES = { owner: 'Chủ trung tâm', staff: 'Nhân viên vận hành', teacher: 'Giáo viên' };
const SESSION_DAYS = 14;

function hasAnyUser(db) { return !!db.prepare('SELECT 1 FROM users LIMIT 1').get(); }

/** Lần chạy đầu: chủ trung tâm tự đặt tài khoản. Không có mật khẩu mặc định. */
function createOwner(db, { username, full_name, password }) {
  assert(!hasAnyUser(db), 'Đã có tài khoản chủ trung tâm', 403);
  return insertUser(db, null, { username, full_name, password, role: 'owner' });
}

function insertUser(db, actor, { username, full_name, password, role, teacher_id, perm_expense, perm_void, perm_reports }) {
  username = String(username || '').trim().toLowerCase();
  assert(/^[a-z0-9._-]{3,32}$/.test(username), 'Tên đăng nhập 3–32 ký tự: chữ không dấu, số, dấu chấm, gạch');
  assert(ROLES[role], 'Vai trò không hợp lệ');
  full_name = String(full_name || '').trim(); assert(full_name, 'Vui lòng nhập họ tên');
  const pwErr = validatePassword(password); assert(!pwErr, pwErr);
  assert(!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username), 'Tên đăng nhập đã tồn tại');
  if (role === 'teacher') assert(teacher_id, 'Tài khoản giáo viên cần gắn với hồ sơ giáo viên');
  const b = (v) => (v === true || v === '1' || v === 'on' ? 1 : 0);
  const id = Number(db.prepare(`INSERT INTO users(username, password_hash, full_name, role, teacher_id, perm_expense, perm_void, perm_reports, must_change_password)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(username, hashPassword(password), full_name, role, role === 'teacher' ? Number(teacher_id) : null,
    role === 'staff' ? b(perm_expense) : 0, role === 'staff' ? b(perm_void) : 0, role === 'staff' ? b(perm_reports) : 0, actor ? 1 : 0).lastInsertRowid);
  audit.log(db, actor, 'user.create', 'user', id, null, { username, role });
  return id;
}
function createUser(db, actor, input) { perms.require(actor, 'manageUsers'); assert(input.role !== 'owner', 'Chỉ có một chủ trung tâm'); return insertUser(db, actor, input); }

function updateUser(db, actor, id, input) {
  perms.require(actor, 'manageUsers');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id); assert(u, 'Không tìm thấy tài khoản', 404);
  const b = (v) => (v === true || v === '1' || v === 'on' ? 1 : 0);
  if (u.role === 'owner') assert(input.active === undefined || b(input.active), 'Không thể khóa tài khoản chủ trung tâm');
  db.prepare('UPDATE users SET full_name = ?, perm_expense = ?, perm_void = ?, perm_reports = ?, active = ?, teacher_id = ? WHERE id = ?').run(
    String(input.full_name || u.full_name).trim(), u.role === 'staff' ? b(input.perm_expense) : 0, u.role === 'staff' ? b(input.perm_void) : 0,
    u.role === 'staff' ? b(input.perm_reports) : 0, u.role === 'owner' ? 1 : b(input.active), u.role === 'teacher' ? Number(input.teacher_id || u.teacher_id) : null, id);
  if (!b(input.active) && u.role !== 'owner') db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  audit.log(db, actor, 'user.update', 'user', id, null, { perm_expense: b(input.perm_expense), perm_void: b(input.perm_void), perm_reports: b(input.perm_reports), active: b(input.active) });
}
function resetPassword(db, actor, id, password) {
  perms.require(actor, 'manageUsers');
  const err = validatePassword(password); assert(!err, err);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), id);
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
  audit.log(db, actor, 'user.reset_password', 'user', id);
}
function changePassword(db, user, { current, password }) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert(verifyPassword(current, u.password_hash), 'Mật khẩu hiện tại không đúng');
  const err = validatePassword(password); assert(!err, err);
  assert(current !== password, 'Mật khẩu mới phải khác mật khẩu cũ');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(password), user.id);
  audit.log(db, user, 'user.change_password', 'user', user.id);
}

function login(db, username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
  if (!u || !u.active || !verifyPassword(password, u.password_hash)) throw new AppError('Tên đăng nhập hoặc mật khẩu không đúng', 401);
  const token = randomToken(32); const csrf = randomToken(18);
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO auth_sessions(token, user_id, csrf, expires_at) VALUES (?,?,?,?)').run(token, u.id, csrf, exp);
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
  audit.log(db, u, 'user.login', 'user', u.id);
  return { token, user: u };
}
function sessionUser(db, token) {
  if (!token) return null;
  const r = db.prepare(`SELECT u.*, a.csrf FROM auth_sessions a JOIN users u ON u.id = a.user_id
    WHERE a.token = ? AND a.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.active = 1`).get(token);
  if (!r) return null;
  delete r.password_hash;
  return r;
}
function logout(db, token) { db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token); }
function list(db) {
  return db.prepare('SELECT u.id, u.username, u.full_name, u.role, u.teacher_id, u.perm_expense, u.perm_void, u.perm_reports, u.active, u.created_at, t.full_name AS teacher_name FROM users u LEFT JOIN teachers t ON t.id = u.teacher_id ORDER BY u.role, u.full_name').all();
}

module.exports = { ROLES, hasAnyUser, createOwner, createUser, updateUser, resetPassword, changePassword, login, sessionUser, logout, list };
