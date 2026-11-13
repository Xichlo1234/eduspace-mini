'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('./sqlite');

const SCHEMA_VERSION = 1;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
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
}

/** Sinh mã tăng dần duy nhất, vd nextCode(db,'HS','HS',5) -> HS00001 */
function nextCode(db, counter, prefix, width = 5) {
  db.prepare('INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING').run(counter);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counter);
  const v = db.prepare('SELECT value FROM counters WHERE name = ?').get(counter).value;
  return prefix + String(v).padStart(width, '0');
}

module.exports = { openDb, nextCode };
