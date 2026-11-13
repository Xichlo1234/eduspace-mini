'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const D = require('./lib/dates');
const M = require('./lib/money');
const { randomToken } = require('./lib/password');
const { AppError } = require('./lib/errors');
const users = require('./services/users');
const perms = require('./services/perms');
const settings = require('./services/settings');

/**
 * state = { db, demo } – giữ tham chiếu CSDL để có thể khôi phục (đổi file) khi đang chạy.
 */
function createApp(state) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 10000 }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    req.db = state.db;
    req.state = state;
    const token = req.cookies.sid;
    req.user = token ? users.sessionUser(req.db, token) : null;
    // flash
    res.locals.flash = null;
    if (req.cookies.flash) { try { res.locals.flash = JSON.parse(req.cookies.flash); } catch (e) { /* bỏ qua */ } res.clearCookie('flash'); }
    req.flash = (type, msg) => res.cookie('flash', JSON.stringify({ type, msg }), { httpOnly: true, sameSite: 'lax', maxAge: 60000 });
    const s = settings.getAll(req.db);
    Object.assign(res.locals, {
      user: req.user, can: Object.fromEntries(Object.entries(perms.can).map(([k, f]) => [k, f(req.user)])), isTeacher: perms.isTeacher(req.user),
      csrf: req.user ? req.user.csrf : null, D, M, vnd: M.vnd, dmy: D.display, path: req.path, query: req.query, center: s, demo: !!state.demo,
      newKey: () => randomToken(12), today: D.todayVN(), title: '',
    });
    res.page = (view, data = {}) => {
      res.render(view, data, (err, html) => {
        if (err) return next(err);
        res.render('layout', { ...data, body: html });
      });
    };
    next();
  });

  // CSRF: mọi POST của người đã đăng nhập phải mang token của phiên
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    if (req.is('multipart/form-data')) return next(); // kiểm tra sau khi multer đọc form
    if (!req.user) return next();
    if (req.body._csrf !== req.user.csrf) return next(new AppError('Phiên làm việc đã hết hạn, vui lòng tải lại trang', 403));
    next();
  });

  app.use(require('./routes/auth'));
  // các route sau yêu cầu đăng nhập
  app.use((req, res, next) => {
    if (!req.user) {
      if (!users.hasAnyUser(req.db)) return res.redirect('/setup');
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (req.user.must_change_password && !req.path.startsWith('/account')) return res.redirect('/account/password');
    next();
  });
  app.use(require('./routes/main'));
  app.use(require('./routes/students'));
  app.use(require('./routes/classes'));
  app.use(require('./routes/finance'));
  app.use(require('./routes/teachers'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/settings'));

  app.use((req, res) => { res.status(404); res.page('error', { title: 'Không tìm thấy', message: 'Trang không tồn tại.' }); });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    const msg = status >= 500 ? 'Có lỗi xảy ra. Dữ liệu chưa được ghi. Vui lòng thử lại.' : err.message;
    if (req.method === 'POST' && status < 500 && status !== 403 && req.get('referer')) {
      req.flash('error', msg);
      return res.redirect(303, req.get('referer'));
    }
    res.status(status);
    if (!res.locals.D) return res.send(msg);
    res.page('error', { title: status === 403 ? 'Không có quyền' : 'Lỗi', message: msg });
  });
  return app;
}

module.exports = { createApp };
