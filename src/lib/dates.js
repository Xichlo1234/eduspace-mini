'use strict';
// Mọi ngày nghiệp vụ là chuỗi 'YYYY-MM-DD' theo múi giờ Việt Nam (UTC+7, không có giờ mùa hè).
const TZ = 'Asia/Ho_Chi_Minh';

function todayVN(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function nowTimeVN(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}
function parse(d) { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); }
function fmt(dt) { return dt.toISOString().slice(0, 10); }
function addDays(d, n) { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return fmt(x); }
function addMonths(d, n) {
  const x = parse(d); const day = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last)); return fmt(x);
}
/** 1 = Thứ 2 ... 7 = Chủ nhật */
function weekday(d) { const w = parse(d).getUTCDay(); return w === 0 ? 7 : w; }
function monthOf(d) { return d.slice(0, 7); }
function monthStart(ym) { return ym + '-01'; }
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return fmt(new Date(Date.UTC(y, m, 0))); }
function nextMonth(ym) { return monthOf(addMonths(ym + '-01', 1)); }
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fmt(parse(s)) === s;
}
function isValidMonth(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }
/** Nhận dd/mm/yyyy hoặc yyyy-mm-dd (hoặc Date), trả yyyy-mm-dd hoặc null */
function parseInput(s) {
  if (s == null) return null;
  if (s instanceof Date && !isNaN(s)) return fmt(new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate())));
  s = String(s).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) { const r = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isValidDate(r) ? r : null; }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const r = `${m[1]}-${m[2]}-${m[3]}`; return isValidDate(r) ? r : null; }
  return null;
}
function display(d) { if (!d) return ''; const s = String(d).slice(0, 10); const [y, m, dd] = s.split('-'); return `${dd}/${m}/${y}`; }
function displayMonth(ym) { if (!ym) return ''; const [y, m] = ym.split('-'); return `${m}/${y}`; }
function displayDateTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}`;
}
const WEEKDAY_NAMES = { 1: 'Thứ 2', 2: 'Thứ 3', 3: 'Thứ 4', 4: 'Thứ 5', 5: 'Thứ 6', 6: 'Thứ 7', 7: 'Chủ nhật' };
const WEEKDAY_SHORT = { 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7', 7: 'CN' };
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function isValidTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }
function minDate(a, b) { if (!a) return b; if (!b) return a; return a < b ? a : b; }
function maxDate(a, b) { if (!a) return b; if (!b) return a; return a > b ? a : b; }

module.exports = {
  TZ, todayVN, nowTimeVN, addDays, addMonths, weekday, monthOf, monthStart, monthEnd, nextMonth,
  isValidDate, isValidMonth, parseInput, display, displayMonth, displayDateTime, WEEKDAY_NAMES, WEEKDAY_SHORT,
  timeToMin, isValidTime, minDate, maxDate,
};
