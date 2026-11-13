'use strict';
const express = require('express');
const crypto = require('crypto');
const users = require('../services/users');
const settings = require('../services/settings');
const { h } = require('./_util');

const r = express.Router();
const attempts = new Map(); // chống dò mật khẩu đơn giản theo IP + tên
function tooMany(key) {
  const a = attempts.get(key); const now = Date.now();
  if (!a || now - a.t > 15 * 60e3) return false;
  return a.n >= 8;
}
function bump(key) { const a = attempts.get(key); const now = Date.now(); if (!a || now - a.t > 15 * 60e3) attempts.set(key, { n: 1, t: now }); else a.n++; }

function preCsrf(req, res) {
  let t = req.cookies.pcsrf;
  if (!t) { t = crypto.randomBytes(16).toString('hex'); res.cookie('pcsrf', t, { httpOnly: true, sameSite: 'lax' }); }
  return t;
}
function checkPre(req) { return req.cookies.pcsrf && req.body._csrf === req.cookies.pcsrf; }
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 14 * 864e5 });

r.get('/setup', (req, res) => {
  if (users.hasAnyUser(req.db)) return res.redirect('/login');
  res.render('setup', { pcsrf: preCsrf(req, res), error: null, values: {} });
});
r.post('/setup', h((req, res) => {
  if (users.hasAnyUser(req.db)) return res.redirect('/login');
  if (!checkPre(req)) return res.status(403).send('Phiên không hợp lệ, tải lại trang');
  const { username, full_name, password, password2, center_name } = req.body;
  try {
    if (password !== password2) throw Object.assign(new Error('Hai lần nhập mật khẩu không khớp'), { status: 400 });
    users.createOwner(req.db, { username, full_name, password });
    if (center_name) settings.set(req.db, 'center_name', center_name.trim());
  } catch (e) {
    if (e.status && e.status < 500) return res.status(400).render('setup', { pcsrf: preCsrf(req, res), error: e.message, values: req.body });
    throw e;
  }
  const { token } = users.login(req.db, username, password);
  res.cookie('sid', token, cookieOpts(req));
  res.redirect('/');
}));

r.get('/login', (req, res) => {
  if (!users.hasAnyUser(req.db)) return res.redirect('/setup');
  if (req.user) return res.redirect('/');
  res.render('login', { pcsrf: preCsrf(req, res), error: null, next: req.query.next || '/', username: '' });
});
r.post('/login', h((req, res) => {
  if (!checkPre(req)) return res.status(403).render('login', { pcsrf: preCsrf(req, res), error: 'Phiên đăng nhập hết hạn, vui lòng thử lại', next: '/', username: '' });
  const key = `${req.ip}|${String(req.body.username || '').toLowerCase()}`;
  const nextUrl = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
  if (tooMany(key)) return res.status(429).render('login', { pcsrf: preCsrf(req, res), error: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.', next: nextUrl, username: req.body.username });
  try {
    const { token } = users.login(req.db, req.body.username, req.body.password);
    attempts.delete(key);
    res.cookie('sid', token, cookieOpts(req));
    res.redirect(nextUrl);
  } catch (e) {
    if (e.status !== 401) throw e;
    bump(key);
    res.status(401).render('login', { pcsrf: preCsrf(req, res), error: e.message, next: nextUrl, username: req.body.username });
  }
}));
r.post('/logout', (req, res) => {
  if (req.user && req.body._csrf === req.user.csrf) users.logout(req.db, req.cookies.sid);
  res.clearCookie('sid');
  res.redirect('/login');
});

r.get('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.page('account_password', { title: 'Đổi mật khẩu', error: null });
});
r.post('/account/password', h((req, res) => {
  if (!req.user) return res.redirect('/login');
  try {
    if (req.body.password !== req.body.password2) throw Object.assign(new Error('Hai lần nhập mật khẩu mới không khớp'), { status: 400 });
    users.changePassword(req.db, req.user, { current: req.body.current, password: req.body.password });
  } catch (e) {
    if (e.status && e.status < 500) return res.status(400).page('account_password', { title: 'Đổi mật khẩu', error: e.message });
    throw e;
  }
  req.flash('success', 'Đã đổi mật khẩu');
  res.redirect('/');
}));

module.exports = r;
