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

const EDITABLE = ['center_name', 'center_address', 'center_phone', 'center_email', 'bank_info', 'rounding_step', 'due_days', 'monthly_due_day', 'default_billing_timing', 'postpaid_due_day', 'package_low_threshold',
  'absence_alert_count', 'reservation_alert_days', 'receipt_title', 'receipt_footer', 'tuition_policy', 'tpl_fee', 'tpl_absence', 'tpl_schedule', 'tpl_review'];

r.get('/settings', owner, (req, res) => res.page('settings', { title: 'Cài đặt', s: settings.getAll(req.db) }));
const logoUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(file.mimetype)),
});
r.post('/settings', owner, logoUpload.single('logo'), csrfMultipart, h((req, res) => {
  for (const k of EDITABLE) if (req.body[k] !== undefined) settings.set(req.db, k, String(req.body[k]).slice(0, 4000));
  if (req.file) {
    // logo lưu trong CSDL (dùng được cả trên Cloudflare, không cần ổ đĩa)
    settings.set(req.db, 'logo_data', req.file.buffer.toString('base64'));
    settings.set(req.db, 'logo_type', req.file.mimetype);
    settings.set(req.db, 'logo_path', '1');
  }
  if (req.body.remove_logo === '1') { settings.set(req.db, 'logo_path', ''); settings.set(req.db, 'logo_data', ''); }
  audit.log(req.db, req.user, 'settings.update', 'settings', null);
  req.flash('success', 'Đã lưu cài đặt');
  res.redirect(303, req.body.back || '/settings');
}));
r.get('/logo', (req, res) => {
  const data = settings.get(req.db, 'logo_data');
  if (data) return res.type(settings.get(req.db, 'logo_type') || 'image/png').set('Cache-Control', 'private, max-age=300').send(Buffer.from(data, 'base64'));
  const name = settings.get(req.db, 'logo_path'); // logo kiểu cũ (file trong data/uploads) trên Node
  if (!req.db.cloudflare && name && /^logo\.(png|jpg|webp)$/.test(name)) return res.sendFile(path.join(path.dirname(path.resolve(req.db.file)), 'uploads', name));
  res.status(404).end();
});

// Danh mục: môn học, phòng học
r.get('/settings/catalog', ops, (req, res) => res.page('catalog', { title: 'Phòng học', rooms: catalog.listRooms(req.db, true) }));
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
const nodeOnly = (req, res, next) => (req.db.cloudflare ? next(new AppError('Trên Cloudflare hãy dùng sao lưu dạng file JSON', 400)) : next());
r.get('/settings/backup', need('backup'), (req, res) => res.page('backup', { title: 'Sao lưu & khôi phục', list: req.db.cloudflare ? [] : backup.list(req.db), file: req.db.file, cloudflare: !!req.db.cloudflare }));

// Sao lưu dạng JSON: dùng được cả trên Node và Cloudflare
r.get('/settings/backup/export.json', need('backup'), h((req, res) => {
  const data = backup.exportData(req.db);
  audit.log(req.db, req.user, 'backup.export', 'backup', null, null, { rows: Object.values(data.tables).reduce((a, t) => a + t.length, 0) });
  res.attachment(`saoluu-eduspace-${backup.stamp()}.json`).type('json').send(JSON.stringify(data));
}));
const jsonUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
r.post('/settings/backup/import', need('backup'), jsonUpload.single('file'), csrfMultipart, h((req, res) => {
  if (!req.file) throw new AppError('Vui lòng chọn file sao lưu (.json)');
  if (req.body.confirm !== 'KHOI PHUC') throw new AppError('Vui lòng gõ chính xác KHOI PHUC để xác nhận');
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch (e) { throw new AppError('File không phải bản sao lưu JSON hợp lệ'); }
  const n = backup.importData(req.db, data);
  audit.log(req.db, null, 'backup.restore', 'backup', null, `Khôi phục JSON bởi ${req.user.username}`, { rows: n });
  res.clearCookie('sid');
  res.redirect(303, '/login');
}));

// Sao lưu file .db: chỉ khi chạy trên máy (Node)
r.post('/settings/backup/now', need('backup'), nodeOnly, h(async (req, res) => {
  const f = await backup.backupTo(req.db, path.join(backup.backupDir(req.db.file), `manual-${backup.stamp()}.db`));
  audit.log(req.db, req.user, 'backup.create', 'backup', null, null, { file: path.basename(f) });
  req.flash('success', `Đã tạo bản sao lưu ${path.basename(f)}`);
  res.redirect(303, '/settings/backup');
}));
r.get('/settings/backup/download/:name', need('backup'), nodeOnly, h(async (req, res) => {
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
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
r.post('/settings/backup/restore', need('backup'), nodeOnly, restoreUpload.single('file'), csrfMultipart, h(async (req, res) => {
  if (!req.file) throw new AppError('Vui lòng chọn file sao lưu (.db)');
  if (req.body.confirm !== 'KHOI PHUC') throw new AppError('Vui lòng gõ chính xác KHOI PHUC để xác nhận');
  const tmpFile = path.join(require('os').tmpdir(), `edu-restore-${backup.stamp()}.db`);
  fs.writeFileSync(tmpFile, req.file.buffer);
  const err = backup.validateFile(tmpFile);
  if (err) { fs.unlink(tmpFile, () => {}); throw new AppError(err); }
  const state = req.state; const file = state.db.file;
  await backup.backupTo(state.db, path.join(backup.backupDir(file), `before-restore-${backup.stamp()}.db`));
  state.db.close();
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.unlinkSync(file + ext);
  fs.copyFileSync(tmpFile, file);
  fs.unlink(tmpFile, () => {});
  state.db = openDb(file);
  audit.log(state.db, null, 'backup.restore', 'backup', null, `Khôi phục bởi ${req.user.username}`);
  res.clearCookie('sid');
  res.redirect(303, '/login');
}));

module.exports = r;
