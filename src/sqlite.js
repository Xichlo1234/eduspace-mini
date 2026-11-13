'use strict';
/**
 * Lớp bọc mỏng quanh SQLite có sẵn trong Node.js (node:sqlite) – không cần biên dịch thư viện native,
 * nên `npm install` chạy được trên mọi máy Windows/macOS/Linux có Node.js >= 22.13.
 * Cung cấp các hàm quen thuộc: prepare/exec/pragma/transaction (lồng nhau bằng SAVEPOINT)/backup/close.
 */
// Ẩn cảnh báo "SQLite is an experimental feature" trên một số phiên bản Node
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning && warning.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return origEmit.call(process, warning, ...args);
};
const sqlite = require(['node', 'sqlite'].join(':')); // chỉ dùng trên Node (Cloudflare dùng src/sqlite-do.js)
process.emitWarning = origEmit;

class Database {
  constructor(file, { readonly = false } = {}) {
    this.raw = new sqlite.DatabaseSync(file, readonly ? { readOnly: true } : {});
    this.name = file;
    this.cache = new Map();
    this.depth = 0;
    this.open = true;
  }
  prepare(sql) {
    let st = this.cache.get(sql);
    if (!st) { st = this.raw.prepare(sql); if (this.cache.size < 500) this.cache.set(sql, st); }
    return st;
  }
  exec(sql) { this.raw.exec(sql); return this; }
  /** db.pragma('user_version', { simple: true }) */
  pragma(text, { simple = false } = {}) {
    const rows = this.raw.prepare(`PRAGMA ${text}`).all();
    if (!simple) return rows;
    const r = rows[0];
    return r ? Object.values(r)[0] : undefined;
  }
  /** Trả về hàm chạy fn trong giao dịch; gọi lồng nhau dùng SAVEPOINT như better-sqlite3 */
  transaction(fn) {
    return (...args) => {
      const outer = this.depth === 0;
      const sp = `sp_${this.depth}`;
      this.raw.exec(outer ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.depth--;
        this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        this.depth--;
        try { this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch (e2) { /* đã hủy */ }
        throw e;
      }
    };
  }
  /** Sao lưu trực tuyến sang file khác */
  async backup(target) {
    if (typeof sqlite.backup === 'function') return sqlite.backup(this.raw, target);
    // Node cũ: VACUUM INTO tạo bản sao nhất quán
    this.raw.prepare('VACUUM INTO ?').run(target);
    return undefined;
  }
  close() { if (this.open) { this.cache.clear(); this.raw.close(); this.open = false; } }
}

module.exports = Database;
