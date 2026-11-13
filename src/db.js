'use strict';
const SCHEMA_VERSION = 1;

/** Tạo bảng (nếu chưa có) và nâng cấp. Dùng chung cho Node và Cloudflare. */
function initDb(db, schemaText) {
  db.pragma('foreign_keys = ON');
  db.exec(schemaText);
  migrate(db);
  return db;
}

/** Node.js: mở file SQLite (dùng node:sqlite có sẵn) */
function openDb(file) {
  const fs = require('fs');
  const path = require('path');
  const Database = require('./sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initDb(db, fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const cur = db.pragma('user_version', { simple: true });
  if (cur < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.file = file;
  return db;
}

/** Nâng cấp CSDL đã có từ phiên bản trước (thêm cột mới, giữ nguyên dữ liệu) */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(classes)').all().map((c) => c.name));
  if (!cols.has('billing_timing')) {
    db.exec("ALTER TABLE classes ADD COLUMN billing_timing TEXT NOT NULL DEFAULT 'prepaid' CHECK (billing_timing IN ('prepaid','postpaid'))");
  }
  // Trung tâm chỉ dạy tiếng Anh: gom mọi lớp/đăng ký về môn "Tiếng Anh", bỏ các môn khác
  if (db.prepare("SELECT 1 FROM subjects WHERE name <> 'Tiếng Anh' LIMIT 1").get() || db.prepare("SELECT 1 FROM classes WHERE subject_id IS NULL LIMIT 1").get()) {
    db.transaction(() => {
      db.prepare("INSERT INTO subjects(name) SELECT 'Tiếng Anh' WHERE NOT EXISTS (SELECT 1 FROM subjects WHERE name = 'Tiếng Anh')").run();
      const en = db.prepare("SELECT id FROM subjects WHERE name = 'Tiếng Anh'").get().id;
      db.prepare('UPDATE classes SET subject_id = ?').run(en);
      db.prepare('UPDATE enrollments SET subject_id = ? WHERE subject_id IS NOT NULL').run(en);
      db.prepare('DELETE FROM subjects WHERE id <> ?').run(en);
    })();
  }
}

/** Sinh mã tăng dần duy nhất, vd nextCode(db,'HS','HS',5) -> HS00001 */
function nextCode(db, counter, prefix, width = 5) {
  db.prepare('INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING').run(counter);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counter);
  const v = db.prepare('SELECT value FROM counters WHERE name = ?').get(counter).value;
  return prefix + String(v).padStart(width, '0');
}

module.exports = { openDb, initDb, nextCode };
