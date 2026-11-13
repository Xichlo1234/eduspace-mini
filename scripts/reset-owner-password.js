#!/usr/bin/env node
'use strict';
// Đặt lại mật khẩu chủ trung tâm khi quên (chạy trên máy chủ): node scripts/reset-owner-password.js "MatKhauMoi123"
const path = require('path');
const { openDb } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/lib/password');
const pw = process.argv[2];
const err = validatePassword(pw);
if (err) { console.error(err); process.exit(1); }
const db = openDb(path.resolve(process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'app.db')));
const u = db.prepare("SELECT * FROM users WHERE role = 'owner'").get();
if (!u) { console.error('Chưa có tài khoản chủ trung tâm'); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(pw), u.id);
db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(u.id);
db.prepare("INSERT INTO audit_logs(user_id, action, entity, entity_id, reason) VALUES (NULL, 'user.reset_password', 'user', ?, 'Đặt lại bằng dòng lệnh trên máy chủ')").run(u.id);
console.log(`Đã đặt lại mật khẩu cho tài khoản "${u.username}".`);
