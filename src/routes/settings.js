'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { AppError } = require('../lib/errors');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const classes = require('../services/classes');
const users = require('../services/users');
const audit = require('../services/audit');
const backup = require('../services/backup');
const { openDb } = require('../db');
const { h, id, need } = require('./_util');

const r = express.Router();
const owner = need('manageSettings');
const ops = need('manageClasses');
const csrfMultipart = (req, res, next) => (req.body._csrf === req.user.csrf ? next() : next(new AppError('Phiên làm việc đã hết hạn, vui lòng tải lại trang', 403)));

const EDITABLE = ['center_name', 'center_address', 'center_phone', 'center_email', 'bank_info', 'rounding_step', 'due_days', 'monthly_due_day', 'package_low_threshold',
  'absence_alert_count', 'reservation_alert_days', 'receipt_title', 'receipt_footer', 'tuition_policy', 'tpl_fee', 'tpl_absence', 'tpl_schedule', 'tpl_review'];

r.get('/settings', owner, (req, res) => res.page('settings', { title: 'Cài đặt', s: settings.getAll(req.db) }));
const logoUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(file.mimetype)),
});
r.post('/settings', owner, logoUpload.single('logo'), csrfMultipart, h((req, res) => {
  for (const k of EDITABLE) if (req.body[k] !== undefined) settings.set(req.db, k, String(req.body[k]).slice(0, 4000));
  if (req.file) {
    const dir = path.join(path.dirname(path.resolve(req.db.file === ':memory:' ? 'data/x' : req.db.file)), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.file.mimetype];
    const name = `logo${ext}`;
    fs.writeFileSync(path.join(dir, name), req.file.buffer);
    settings.set(req.db, 'logo_path', name);
  }
  if (req.body.remove_logo === '1') settings.set(req.db, 'logo_path', '');
  audit.log(req.db, req.user, 'settings.update', 'settings', null);
  req.flash('success', 'Đã lưu cài đặt');
  res.redirect(303, req.body.back || '/settings');
}));
// logo được phục vụ từ thư mục dữ liệu
r.get('/logo', (req, res) => {
  const name = settings.get(req.db, 'logo_path');
  if (!name || !/^logo\.(png|jpg|webp)$/.test(name)) return res.status(404).end();
  res.sendFile(path.join(path.dirname(path.resolve(req.db.file)), 'uploads', name));
});

// Danh mục: môn học, phòng học
r.get('/settings/catalog', ops, (req, res) => res.page('catalog', { title: 'Môn học & phòng học', subjects: catalog.listSubjects(req.db, true), rooms: catalog.listRooms(req.db, true) }));
r.post('/settings/subjects', ops, h((req, res) => { catalog.saveSubject(req.db, req.user, { ...req.body, id: req.body.id ? Number(req.body.id) : null }); req.flash('success', 'Đã lưu môn học'); res.redirect(303, req.body.back || '/settings/catalog'); }));
r.post('/settings/rooms', ops, h((req, res) => { catalog.saveRoom(req.db, req.user, { ...req.body, id: req.body.id ? Number(req.body.id) : null }); req.flash('success', 'Đã lưu phòng học'); res.redirect(303, req.body.back || '/settings/catalog'); }));

// Ngày nghỉ
r.get('/settings/holidays', ops, (req, res) => res.page('holidays', { title: 'Ngày nghỉ, ngày lễ', list: classes.listHolidays(req.db) }));
r.post('/settings/holidays', ops, h((req, res) => {
  const out = classes.addHoliday(req.db, req.user, req.body);
  req.flash('success', `Đã thêm ngày nghỉ${out.cancelled ? `: hủy ${out.cancelled} buổi đã lên lịch${out.makeup ? `, thêm ${out.makeup} buổi bù cho lớp theo khóa` : ''}` : ''}`);
  res.redirect(303, '/settings/holidays');
}));
r.post('/settings/holidays/:id/delete', ops, h((req, res) => {
  classes.removeHoliday(req.db, req.user, id(req));
  req.flash('success', 'Đã xóa ngày nghỉ. Các buổi đã hủy trước đó không tự khôi phục – mở buổi để khôi phục nếu cần.');
  res.redirect(303, '/settings/holidays');
}));

// Tài khoản
r.get('/settings/users', need('manageUsers'), (req, res) => res.page('users', { title: 'Tài khoản', list: users.list(req.db), teachers: catalog.listTeachers(req.db), ROLES: users.ROLES, error: null, v: {} }));
r.post('/settings/users', need('manageUsers'), h((req, res) => {
  try { users.createUser(req.db, req.user, req.body); } catch (e) {
    if (e.status && e.status < 500) return res.status(400).page('users', { title: 'Tài khoản', list: users.list(req.db), teachers: catalog.listTeachers(req.db), ROLES: users.ROLES, error: e.message, v: req.body });
    throw e;
  }
  req.flash('success', 'Đã tạo tài khoản. Người dùng sẽ phải đổi mật khẩu ở lần đăng nhập đầu.');
  res.redirect(303, '/settings/users');
}));
r.post('/settings/users/:id', need('manageUsers'), h((req, res) => { users.updateUser(req.db, req.user, id(req), req.body); req.flash('success', 'Đã cập nhật quyền'); res.redirect(303, '/settings/users'); }));
r.post('/settings/users/:id/password', need('manageUsers'), h((req, res) => { users.resetPassword(req.db, req.user, id(req), req.body.password); req.flash('success', 'Đã đặt lại mật khẩu'); res.redirect(303, '/settings/users'); }));

// Nhật ký thao tác
r.get('/settings/audit', owner, (req, res) => res.page('audit', { title: 'Nhật ký thao tác', list: audit.recent(req.db, 500) }));

// Sao lưu / khôi phục
r.get('/settings/backup', need('backup'), (req, res) => res.page('backup', { title: 'Sao lưu & khôi phục', list: backup.list(req.db), file: req.db.file }));
r.post('/settings/backup/now', need('backup'), h(async (req, res) => {
  const f = await backup.backupTo(req.db, path.join(backup.backupDir(req.db.file), `manual-${backup.stamp()}.db`));
  audit.log(req.db, req.user, 'backup.create', 'backup', null, null, { file: path.basename(f) });
  req.flash('success', `Đã tạo bản sao lưu ${path.basename(f)}`);
  res.redirect(303, '/settings/backup');
}));
r.get('/settings/backup/download/:name', need('backup'), h(async (req, res) => {
  const name = req.params.name;
  if (name === 'current') {
    const tmp = path.join(backup.backupDir(req.db.file), `download-${backup.stamp()}.db`);
    await backup.backupTo(req.db, tmp);
    return res.download(tmp, `saoluu-${backup.stamp()}.db`, () => fs.unlink(tmp, () => {}));
  }
  if (!/^[\w.-]+\.db$/.test(name)) throw new AppError('Tên file không hợp lệ', 400);
  const f = path.join(backup.backupDir(req.db.file), name);
  if (!fs.existsSync(f)) throw new AppError('Không tìm thấy file', 404);
  res.download(f);
}));
const restoreUpload = multer({ dest: path.join(require('os').tmpdir(), 'edu-restore'), limits: { fileSize: 500 * 1024 * 1024 } });
r.post('/settings/backup/restore', need('backup'), restoreUpload.single('file'), csrfMultipart, h(async (req, res) => {
  if (!req.file) throw new AppError('Vui lòng chọn file sao lưu (.db)');
  if (req.body.confirm !== 'KHOI PHUC') { fs.unlink(req.file.path, () => {}); throw new AppError('Vui lòng gõ chính xác KHOI PHUC để xác nhận'); }
  const err = backup.validateFile(req.file.path);
  if (err) { fs.unlink(req.file.path, () => {}); throw new AppError(err); }
  const state = req.state; const file = state.db.file;
  await backup.backupTo(state.db, path.join(backup.backupDir(file), `before-restore-${backup.stamp()}.db`));
  state.db.close();
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.unlinkSync(file + ext);
  fs.copyFileSync(req.file.path, file);
  fs.unlink(req.file.path, () => {});
  state.db = openDb(file);
  audit.log(state.db, null, 'backup.restore', 'backup', null, `Khôi phục bởi ${req.user.username}`);
  res.clearCookie('sid');
  res.redirect(303, '/login');
}));

module.exports = r;
