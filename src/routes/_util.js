'use strict';
const perms = require('../services/perms');
const { AppError } = require('../lib/errors');

const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const need = (perm) => (req, res, next) => (perms.can[perm](req.user) ? next() : next(new AppError('Bạn không có quyền truy cập chức năng này', 403)));
const operator = need('manageStudents');
const id = (req, name = 'id') => { const v = parseInt(req.params[name], 10); if (!v) throw new AppError('Không tìm thấy', 404); return v; };
/** Chạy thao tác; lỗi nghiệp vụ → hiển thị lại form với dữ liệu đã nhập */
function tryForm(res, view, data, fn) {
  try { return fn(); } catch (e) {
    if (!e.status || e.status >= 500 || e.status === 403) throw e;
    res.status(e.status === 409 ? 409 : 400);
    res.page(view, { ...data, error: e.message, conflicts: e.conflicts || null });
    return undefined;
  }
}
/** form gửi lịch học dạng slots[i][weekday] ... */
function slotsFrom(body) {
  const raw = body.slots ? (Array.isArray(body.slots) ? body.slots : Object.values(body.slots)) : [];
  return raw.filter((s) => s && s.weekday && s.start_time && s.end_time);
}
module.exports = { h, need, operator, id, tryForm, slotsFrom };
