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
  const cur = db.pragma('user_version', { simple: true });
  if (cur < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  db.file = file;
  return db;
}

/** Sinh mã tăng dần duy nhất, vd nextCode(db,'HS','HS',5) -> HS00001 */
function nextCode(db, counter, prefix, width = 5) {
  db.prepare('INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING').run(counter);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counter);
  const v = db.prepare('SELECT value FROM counters WHERE name = ?').get(counter).value;
  return prefix + String(v).padStart(width, '0');
}

module.exports = { openDb, nextCode };
