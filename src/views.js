'use strict';
/**
 * Hiển thị giao diện EJS.
 *  - Node: biên dịch file .ejs khi chạy (có bộ nhớ đệm).
 *  - Cloudflare: dùng các hàm đã biên dịch sẵn lúc build (globalThis.__EDU_VIEWS__), vì Workers không cho phép new Function.
 */
const path = require('path');

const VIEWS_DIR = typeof __dirname !== 'undefined' ? path.join(__dirname, 'views') : 'views'; // Cloudflare không có __dirname (dùng giao diện biên dịch sẵn)
const cache = new Map();
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
function escapeXML(s) { return s == null ? '' : String(s).replace(/[&<>'"]/g, (c) => ESC[c]); }

function render(name, locals) {
  const pre = globalThis.__EDU_VIEWS__;
  if (pre) {
    const fn = pre[name];
    if (!fn) throw new Error(`Không tìm thấy giao diện "${name}"`);
    const include = (p, data) => render(path.posix.join(path.posix.dirname(name), p), { ...locals, ...(data || {}) });
    return fn(locals, escapeXML, include);
  }
  let fn = cache.get(name);
  if (!fn) {
    const ejs = require('ejs');
    const file = path.join(VIEWS_DIR, `${name}.ejs`);
    fn = ejs.compile(require('fs').readFileSync(file, 'utf8'), { filename: file, views: [VIEWS_DIR] });
    cache.set(name, fn);
  }
  return fn(locals);
}

module.exports = { render, escapeXML, VIEWS_DIR };
