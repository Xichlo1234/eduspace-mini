'use strict';
/**
 * Bộ chuyển đổi SQLite của Cloudflare Durable Object (ctx.storage.sql) sang cùng giao diện với src/sqlite.js,
 * để toàn bộ mã nghiệp vụ chạy y hệt trên Node và trên Cloudflare.
 *  - prepare(sql).run/get/all với tham số vị trí (?) hoặc tên (@ten + object)
 *  - transaction(fn): dùng storage.transactionSync, gọi lồng nhau chạy trong giao dịch ngoài cùng
 */

/** Tách nhiều câu lệnh SQL (bỏ qua ; trong chuỗi và chú thích) */
function splitStatements(text) {
  const out = []; let cur = ''; let i = 0; let q = null;
  while (i < text.length) {
    const ch = text[i];
    if (q) { cur += ch; if (ch === q) q = null; i++; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; i++; continue; }
    if (ch === '-' && text[i + 1] === '-') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Đổi tham số tên @ten thành ? theo thứ tự xuất hiện */
function compileNamed(sql) {
  const names = []; let out = ''; let q = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (q) { out += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    if (ch === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let j = i + 1; while (j < sql.length && /\w/.test(sql[j])) j++;
      names.push(sql.slice(i + 1, j)); out += '?'; i = j - 1; continue;
    }
    out += ch;
  }
  return { sql: out, names };
}

class Statement {
  constructor(db, sql) { this.db = db; this.src = sql; this.named = null; }
  bind(args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !(args[0] instanceof Uint8Array)) {
      if (!this.named) this.named = compileNamed(this.src);
      const o = args[0];
      return { sql: this.named.sql, params: this.named.names.map((n) => { if (!(n in o)) throw new Error(`Thiếu tham số @${n}`); return norm(o[n]); }) };
    }
    return { sql: this.src, params: args.map(norm) };
  }
  run(...args) {
    const { sql, params } = this.bind(args);
    this.db.sql.exec(sql, ...params);
    const r = this.db.sql.exec('SELECT changes() AS c, last_insert_rowid() AS id').one();
    return { changes: r.c, lastInsertRowid: r.id };
  }
  get(...args) { const { sql, params } = this.bind(args); const rows = this.db.sql.exec(sql, ...params).toArray(); return rows[0]; }
  all(...args) { const { sql, params } = this.bind(args); return this.db.sql.exec(sql, ...params).toArray(); }
}
function norm(v) { if (v === undefined) return null; if (typeof v === 'boolean') return v ? 1 : 0; return v; }

class DoDatabase {
  constructor(storage) { this.storage = storage; this.sql = storage.sql; this.depth = 0; this.file = 'cloudflare-durable-object'; this.cloudflare = true; }
  prepare(sql) { return new Statement(this, sql); }
  exec(text) { for (const s of splitStatements(text)) this.sql.exec(s); return this; }
  pragma(text, { simple = false } = {}) {
    let rows;
    try { rows = this.sql.exec(`PRAGMA ${text}`).toArray(); } catch (e) { return simple ? undefined : []; } // một số PRAGMA không được phép trên Cloudflare
    if (!simple) return rows;
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  }
  transaction(fn) {
    return (...args) => {
      if (this.depth > 0) return fn(...args);
      this.depth++;
      try { return this.storage.transactionSync(() => fn(...args)); } finally { this.depth--; }
    };
  }
  async backup() { throw new Error('Trên Cloudflare dùng sao lưu dạng file JSON'); }
  close() { /* do Cloudflare quản lý */ }
}

module.exports = DoDatabase;
module.exports.splitStatements = splitStatements;
module.exports.compileNamed = compileNamed;
