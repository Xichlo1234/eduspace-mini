'use strict';
/**
 * Sao lưu / khôi phục. CSDL là một file SQLite duy nhất.
 *  - Sao lưu tự động mỗi ngày vào thư mục backups/ (giữ 30 bản gần nhất).
 *  - Tải bản sao lưu về máy từ Cài đặt → Sao lưu.
 *  - Khôi phục: tải lên file .db, hệ thống kiểm tra cấu trúc, tự sao lưu dữ liệu hiện tại rồi mới thay thế.
 */
const fs = require('fs');
const path = require('path');
const Database = require('../sqlite');

function backupDir(dbFile) { return path.join(path.dirname(path.resolve(dbFile)), 'backups'); }
function stamp() { return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); }

async function backupTo(db, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await db.backup(target);
  return target;
}
async function autoBackup(db, keep = 30) {
  if (db.file === ':memory:') return null;
  const dir = backupDir(db.file);
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(dir, { recursive: true });
  const exists = fs.readdirSync(dir).some((f) => f.startsWith(`auto-${today}`));
  if (exists) return null;
  const file = await backupTo(db, path.join(dir, `auto-${stamp()}.db`));
  const autos = fs.readdirSync(dir).filter((f) => f.startsWith('auto-')).sort();
  for (const f of autos.slice(0, Math.max(0, autos.length - keep))) fs.unlinkSync(path.join(dir, f));
  return file;
}
function list(db) {
  if (db.file === ':memory:') return [];
  const dir = backupDir(db.file);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse()
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, mtime: fs.statSync(path.join(dir, f)).mtime.toISOString() }));
}
/** Kiểm tra file tải lên có đúng là CSDL của ứng dụng */
function validateFile(file) {
  let x;
  try {
    x = new Database(file, { readonly: true });
    const tables = new Set(x.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of ['users', 'students', 'classes', 'invoices', 'receipts']) if (!tables.has(t)) return `File không phải bản sao lưu hợp lệ (thiếu bảng ${t})`;
    if (!x.prepare("SELECT 1 FROM users WHERE role = 'owner'").get()) return 'Bản sao lưu không có tài khoản chủ trung tâm';
    const ok = x.pragma('integrity_check', { simple: true });
    if (ok !== 'ok') return 'File sao lưu bị hỏng';
    return null;
  } catch (e) {
    return 'Không đọc được file sao lưu: ' + e.message;
  } finally { if (x) x.close(); }
}

module.exports = { backupDir, backupTo, autoBackup, list, validateFile, stamp };
