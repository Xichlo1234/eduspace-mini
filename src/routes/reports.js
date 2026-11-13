'use strict';
const express = require('express');
const D = require('../lib/dates');
const { AppError } = require('../lib/errors');
const reports = require('../services/reports');
const B = require('../services/billing');
const cashbook = require('../services/cashbook');
const excel = require('../services/excel');
const { h, need } = require('./_util');

const r = express.Router();
r.use('/reports', need('viewReports'));

function range(req) {
  const today = D.todayVN();
  const from = D.parseInput(req.query.from) || D.monthStart(D.monthOf(today));
  const to = D.parseInput(req.query.to) || today;
  if (from > to) throw new AppError('Khoảng ngày không hợp lệ');
  return { from, to };
}

r.get('/reports', h((req, res) => {
  const { from, to } = range(req);
  res.page('reports', {
    title: 'Báo cáo', from, to, f: reports.finance(req.db, { from, to }), debts: reports.debtByStudent(req.db),
    byClass: reports.revenueByClass(req.db, { from, to }), att: reports.attendanceByClass(req.db, { from, to }),
  });
}));

r.get('/reports/export/:kind.xlsx', h(async (req, res) => {
  const { from, to } = range(req);
  const kind = req.params.kind;
  let sheets;
  if (kind === 'receipts') {
    sheets = [{ name: 'Phieu thu', rows: B.listReceipts(req.db, { from, to }), columns: [
      { header: 'Mã phiếu', key: 'code', width: 12 }, { header: 'Ngày thu', key: 'paid_date', type: 'date', width: 12 }, { header: 'Mã HS', key: 'student_code', width: 10 },
      { header: 'Học sinh', key: 'student_name', width: 24 }, { header: 'Lớp', key: 'class_name', width: 20 }, { header: 'Kỳ thu', key: 'period_label', width: 18 },
      { header: 'Số tiền', key: 'amount', type: 'money', width: 14 }, { header: 'Hình thức', key: 'method', value: (x) => B.METHODS[x.method] },
      { header: 'Người thu', key: 'collector_name', width: 18 }, { header: 'Trạng thái', key: 'status', value: (x) => (x.status === 'void' ? `ĐÃ HỦY: ${x.void_reason}` : 'Hợp lệ'), width: 20 },
      { header: 'Ghi chú', key: 'note', width: 24 }] }];
  } else if (kind === 'debts') {
    sheets = [{ name: 'Cong no', rows: B.listInvoices(req.db, { status: 'open' }), columns: [
      { header: 'Mã khoản', key: 'code', width: 12 }, { header: 'Mã HS', key: 'student_code', width: 10 }, { header: 'Học sinh', key: 'student_name', width: 24 },
      { header: 'Phụ huynh', key: 'parent_name', width: 20 }, { header: 'SĐT', key: 'parent_phone', width: 14 }, { header: 'Lớp', key: 'class_name', width: 20 },
      { header: 'Kỳ', key: 'period_label', width: 16 }, { header: 'Phải thu', key: 'amount', type: 'money', width: 14 }, { header: 'Đã đóng', key: 'paid', type: 'money', width: 14 },
      { header: 'Còn nợ', key: 'due', type: 'money', width: 14 }, { header: 'Hạn đóng', key: 'due_date', type: 'date', width: 12 }] }];
  } else if (kind === 'cashbook') {
    const rows = [
      ...B.listReceipts(req.db, { from, to, includeVoid: false }).map((x) => ({ date: x.paid_date, code: x.code, dir: 'Thu', cat: 'Học phí / thu học sinh', party: `${x.student_code} ${x.student_name}`, amount: x.amount, method: B.METHODS[x.method], note: x.period_label })),
      ...cashbook.list(req.db, { from, to }).filter((t) => t.status === 'valid').map((t) => ({ date: t.date, code: t.code, dir: t.direction === 'in' ? 'Thu' : 'Chi', cat: cashbook.ALL_CATEGORIES[t.category], party: t.party, amount: t.direction === 'in' ? t.amount : -t.amount, method: B.METHODS[t.method], note: t.note })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    sheets = [{ name: 'So thu chi', rows, columns: [
      { header: 'Ngày', key: 'date', type: 'date', width: 12 }, { header: 'Mã', key: 'code', width: 12 }, { header: 'Thu/Chi', key: 'dir', width: 8 }, { header: 'Danh mục', key: 'cat', width: 24 },
      { header: 'Người nộp/nhận', key: 'party', width: 24 }, { header: 'Số tiền (+thu/−chi)', key: 'amount', type: 'money', width: 16 }, { header: 'Hình thức', key: 'method', width: 14 }, { header: 'Ghi chú', key: 'note', width: 30 }] }];
  } else if (kind === 'summary') {
    const f = reports.finance(req.db, { from, to });
    const rows = [
      { k: 'Thực thu học sinh (phiếu thu)', v: f.tuitionIn }, { k: '  trong đó đặt cọc/trả trước', v: f.deposits }, { k: 'Thu khác', v: f.otherIn }, { k: 'TỔNG THỰC THU', v: f.totalIn },
      ...f.outByCat.map((o) => ({ k: `Chi: ${o.label}`, v: o.s })), { k: 'TỔNG THỰC CHI', v: f.totalOut },
      { k: 'Chênh lệch thu – chi tiền (không phải lợi nhuận kế toán)', v: f.net },
      { k: 'Công nợ hiện tại (chưa thu)', v: f.debt }, { k: '  trong đó quá hạn', v: f.overdue }, { k: 'Tiền trả trước chưa phân bổ', v: f.prepaid }, { k: 'Tiền đang giữ cho bảo lưu', v: f.reservedCredit },
    ];
    sheets = [{ name: 'Tong hop', rows, columns: [{ header: `Khoản mục (${D.display(from)} – ${D.display(to)})`, key: 'k', width: 55 }, { header: 'Số tiền', key: 'v', type: 'money', width: 18 }] }];
  } else throw new AppError('Loại báo cáo không hợp lệ', 404);
  const buf = await excel.workbook(sheets);
  res.attachment(`bao-cao-${kind}-${from}-${to}.xlsx`).type('xlsx').send(Buffer.from(buf));
}));

module.exports = r;
