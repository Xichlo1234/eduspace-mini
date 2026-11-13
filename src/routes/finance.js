'use strict';
const express = require('express');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const B = require('../services/billing');
const E = require('../services/enrollments');
const bulk = require('../services/bulk');
const cashbook = require('../services/cashbook');
const classes = require('../services/classes');
const students = require('../services/students');
const audit = require('../services/audit');
const { h, id, need } = require('./_util');

const r = express.Router();
const collect = need('collectMoney');

// Công nợ / khoản phải thu
r.get('/finance', collect, h((req, res) => {
  const status = req.query.status || 'open';
  const list = B.listInvoices(req.db, { status: status === 'overdue' ? 'open' : status, overdueOnly: status === 'overdue', classId: req.query.class_id || null, q: req.query.q || null });
  const sum = (f) => list.reduce((a, i) => a + f(i), 0);
  res.page('finance', { title: 'Học phí & công nợ', list, status, classes: classes.listClasses(req.db, { status: 'all' }), totals: { amount: sum((i) => i.amount), paid: sum((i) => i.paid), due: sum((i) => i.due) } });
}));

r.get('/invoices/new', collect, h((req, res) => {
  const sid = Number(req.query.student_id); const s = students.getStudent(req.db, sid); if (!s) throw new AppError('Không tìm thấy học sinh', 404);
  const enrs = E.studentEnrollments(req.db, sid).filter((e) => e.status === 'active');
  const next = enrs.map((e) => {
    const enr = B.getEnrollment(req.db, e.id); const cls = B.getClassRow(req.db, e.class_id);
    let ym = null;
    const monthBased = cls.fee_type === 'monthly' || (cls.fee_type === 'package' && B.isPostpaid(cls));
    if (monthBased) {
      const last = req.db.prepare("SELECT MAX(period_key) p FROM invoices WHERE enrollment_id = ? AND status = 'active' AND period_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'").get(e.id).p;
      ym = last ? D.nextMonth(last) : D.monthOf(B.isPostpaid(cls) ? enr.start_date : D.maxDate(enr.start_date, D.todayVN()));
      classes.extendAll(req.db, D.monthEnd(ym));
    }
    const calc = B.calcPeriod(req.db, enr, cls, ym);
    return { e, cls, ym, calc, postpaid: B.isPostpaid(cls) };
  });
  res.page('invoice_new', { title: `Tạo khoản thu: ${s.full_name}`, s, next, CATEGORIES: B.CATEGORIES, classesList: enrs });
}));
r.post('/invoices', collect, h((req, res) => {
  let invId;
  if (req.body.kind === 'tuition') {
    invId = B.createTuitionInvoice(req.db, req.user, { enrollment_id: Number(req.body.enrollment_id), ym: req.body.ym || null, idempotency_key: req.body.idempotency_key,
      discount: req.body.discount || 0, discount_reason: req.body.discount_reason });
    if (req.body.apply_credit === '1') B.applyCredit(req.db, req.user, { invoice_id: invId, note: 'Trừ tiền trả trước' });
  } else {
    invId = B.createOtherInvoice(req.db, req.user, req.body);
  }
  req.flash('success', 'Đã tạo khoản phải thu');
  res.redirect(303, `/invoices/${invId}`);
}));
r.get('/invoices/:id', collect, h((req, res) => {
  const inv = B.getInvoice(req.db, id(req)); if (!inv) throw new AppError('Không tìm thấy khoản phải thu', 404);
  res.page('invoice', { title: `Khoản phải thu ${inv.code}`, inv, credit: B.credit(req.db, inv.student_id), history: audit.forEntity(req.db, 'invoice', inv.id) });
}));
r.post('/invoices/:id/adjust', collect, h((req, res) => {
  const out = B.adjustInvoice(req.db, req.user, { invoice_id: id(req), new_amount: req.body.new_amount, reason: req.body.reason });
  req.flash('success', `Đã điều chỉnh số phải thu${out.released ? ` – ${require('../lib/money').vnd(out.released)} đã đóng dư chuyển vào tiền trả trước` : ''}`);
  res.redirect(303, `/invoices/${id(req)}`);
}));
r.post('/invoices/:id/void', collect, h((req, res) => {
  B.voidInvoice(req.db, req.user, id(req), req.body.reason);
  req.flash('success', 'Đã hủy khoản phải thu (vẫn lưu lịch sử)');
  res.redirect(303, `/invoices/${id(req)}`);
}));
r.post('/invoices/:id/apply-credit', collect, h((req, res) => {
  const n = B.applyCredit(req.db, req.user, { invoice_id: id(req), amount: req.body.amount || null });
  req.flash('success', `Đã trừ ${require('../lib/money').vnd(n)} tiền trả trước`);
  res.redirect(303, `/invoices/${id(req)}`);
}));

// Thu tiền
r.get('/payments/new', collect, h((req, res) => {
  let inv = null; let s;
  if (req.query.invoice_id) { inv = B.getInvoice(req.db, Number(req.query.invoice_id)); if (!inv) throw new AppError('Không tìm thấy khoản phải thu', 404); s = students.getStudent(req.db, inv.student_id); }
  else { s = students.getStudent(req.db, Number(req.query.student_id)); if (!s) throw new AppError('Không tìm thấy học sinh', 404); }
  const open = B.listInvoices(req.db, { studentId: s.id, status: 'open' });
  res.page('payment', { title: 'Thu tiền', inv, s, open, credit: B.credit(req.db, s.id), METHODS: B.METHODS, deposit: req.query.deposit === '1' });
}));
r.post('/payments', collect, h((req, res) => {
  const out = B.recordReceipt(req.db, req.user, { ...req.body, excess_to_credit: req.body.excess_to_credit === '1' });
  req.flash('success', out.duplicate ? 'Phiếu thu này đã được ghi nhận trước đó (không tạo trùng)' : 'Đã ghi nhận phiếu thu');
  res.redirect(303, `/receipts/${out.id}`);
}));
r.get('/receipts', collect, h((req, res) => {
  const from = D.parseInput(req.query.from) || D.monthStart(D.monthOf(D.todayVN())); const to = D.parseInput(req.query.to) || D.todayVN();
  const list = B.listReceipts(req.db, { from, to });
  res.page('receipts', { title: 'Phiếu thu', list, from, to, METHODS: B.METHODS, total: list.filter((x) => x.status === 'valid').reduce((a, x) => a + x.amount, 0) });
}));
r.get('/receipts/:id', collect, h((req, res) => {
  const rc = B.getReceipt(req.db, id(req)); if (!rc) throw new AppError('Không tìm thấy phiếu thu', 404);
  const inv = rc.invoice_id ? B.balance(req.db, rc.invoice_id) : null;
  if (req.query.print) return res.render('receipt_print', { rc, inv, METHODS: B.METHODS });
  res.page('receipt', { title: `Phiếu thu ${rc.code}`, rc, inv, METHODS: B.METHODS, credit: B.credit(req.db, rc.student_id) });
}));
r.post('/receipts/:id/void', collect, h((req, res) => {
  B.voidReceipt(req.db, req.user, id(req), req.body.reason);
  req.flash('success', 'Đã hủy phiếu thu (phiếu vẫn được lưu, có ghi lý do)');
  res.redirect(303, `/receipts/${id(req)}`);
}));

// Tạo học phí hàng loạt
r.get('/billing/bulk', collect, h((req, res) => {
  const ym = D.isValidMonth(req.query.ym) ? req.query.ym : D.nextMonth(D.monthOf(D.todayVN()));
  const ymPost = D.isValidMonth(req.query.ym_post) ? req.query.ym_post : bulk.defaultPostMonth();
  const hasPost = !!req.db.prepare("SELECT 1 FROM classes WHERE billing_timing = 'postpaid' AND status <> 'cancelled'").get();
  const hasPre = !!req.db.prepare("SELECT 1 FROM classes WHERE billing_timing = 'prepaid' AND status <> 'cancelled'").get();
  res.page('bulk', { title: 'Tạo học phí hàng loạt', p: bulk.preview(req.db, { ym, ymPost }), ym, ymPost, hasPost, hasPre });
}));
r.post('/billing/bulk', collect, h((req, res) => {
  const keys = req.body.keys ? [].concat(req.body.keys) : [];
  const out = bulk.commit(req.db, req.user, { ym: req.body.ym, ymPost: req.body.ym_post, keys, apply_credit: req.body.apply_credit === '1' });
  req.flash('success', `Đã tạo ${out.created} khoản phải thu${out.skipped ? `, bỏ qua ${out.skipped} khoản đã có` : ''}${out.applied ? `, trừ ${require('../lib/money').vnd(out.applied)} tiền trả trước` : ''}`);
  res.redirect(303, `/finance?status=open`);
}));

// Thu chi
r.get('/cashbook', collect, h((req, res) => {
  const from = D.parseInput(req.query.from) || D.monthStart(D.monthOf(D.todayVN())); const to = D.parseInput(req.query.to) || D.todayVN();
  const list = cashbook.list(req.db, { from, to, direction: req.query.direction || null });
  const receipts = B.listReceipts(req.db, { from, to, includeVoid: false });
  res.page('cashbook', { title: 'Thu chi', list, from, to, receipts, IN: cashbook.IN_CATEGORIES, OUT: cashbook.OUT_CATEGORIES, ALL: cashbook.ALL_CATEGORIES, METHODS: B.METHODS, direction: req.query.direction || '' });
}));
r.post('/cashbook', collect, h((req, res) => {
  cashbook.create(req.db, req.user, req.body);
  req.flash('success', req.body.direction === 'out' ? 'Đã ghi phiếu chi' : 'Đã ghi khoản thu');
  res.redirect(303, '/cashbook');
}));
r.post('/cashbook/:id/void', collect, h((req, res) => {
  cashbook.voidTx(req.db, req.user, id(req), req.body.reason);
  req.flash('success', 'Đã hủy giao dịch (vẫn lưu lịch sử)');
  res.redirect(303, '/cashbook');
}));

module.exports = r;
