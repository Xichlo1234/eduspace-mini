'use strict';
const { AppError } = require('./errors');

function vnd(n) {
  n = Math.round(Number(n) || 0);
  const s = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + s + ' đ';
}
function num(n) { return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
/** Nhận "800.000", "800,000", "800000", "800k", "1,5tr" -> số nguyên VND */
function parseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v);
  let s = String(v).trim().toLowerCase().replace(/\s|đ|vnd/g, '');
  if (!s) return null;
  let mult = 1;
  if (s.endsWith('k')) { mult = 1000; s = s.slice(0, -1); } else if (s.endsWith('tr')) { mult = 1000000; s = s.slice(0, -2); }
  if (mult > 1) s = s.replace(',', '.'); else s = s.replace(/[.,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * mult);
}
/** Làm tròn theo bước (mặc định 1.000đ) */
function roundTo(n, step) { step = Number(step) || 1; return Math.round(n / step) * step; }
/** Đọc số tiền người dùng nhập: số nguyên VND không âm. */
function mustMoney(v, label = 'Số tiền', { allowZero = false } = {}) {
  const n = parseMoney(v);
  if (n == null || !Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) throw new AppError(`${label} không hợp lệ`);
  return n;
}
module.exports = { vnd, num, parseMoney, roundTo, mustMoney };
