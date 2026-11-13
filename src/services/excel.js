'use strict';
const ExcelJS = require('exceljs');
const D = require('../lib/dates');
const students = require('./students');

/** Tạo workbook từ danh sách cột {header, key, width, type: 'money'|'date'} */
async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Eduspace Mini';
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31));
    ws.columns = sh.columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
    for (const r of sh.rows) {
      const row = {};
      for (const c of sh.columns) {
        let v = typeof c.value === 'function' ? c.value(r) : r[c.key];
        if (c.type === 'date' && v) v = D.display(v);
        row[c.key] = v;
      }
      ws.addRow(row);
    }
    sh.columns.forEach((c, i) => { if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0'; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return wb.xlsx.writeBuffer();
}

async function studentTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoc sinh');
  ws.columns = students.IMPORT_COLUMNS.map((c) => ({ header: c.label, key: c.key, width: 24 }));
  ws.getRow(1).font = { bold: true };
  ws.addRow({ full_name: 'Nguyễn Văn An', dob: '15/03/2015', gender: 'Nam', parent_name: 'Nguyễn Văn Bình', parent_phone: '0901234567', entry_level: 'A1', note: 'Dòng mẫu – xóa trước khi nhập' });
  ws.addRow({ full_name: 'Nguyễn Thị Hoa', dob: '02/09/2017', gender: 'Nữ', parent_name: 'Nguyễn Văn Bình', parent_phone: '0901234567', note: 'Em gái – chung SĐT vẫn tạo hồ sơ riêng' });
  ws.getColumn(2).numFmt = '@'; ws.getColumn(5).numFmt = '@';
  const help = wb.addWorksheet('Huong dan');
  help.addRow(['Hướng dẫn nhập danh sách học sinh']).font = { bold: true };
  ['Chỉ cột "Họ tên học sinh" là bắt buộc.', 'Ngày sinh nhập dạng dd/mm/yyyy (ví dụ 15/03/2015).', 'Số điện thoại 10 số, bắt đầu bằng 0. Anh chị em có thể dùng chung số.',
    'Mã học sinh do hệ thống tự sinh, không cần nhập.', 'Sau khi tải lên, hệ thống hiển thị lỗi và cảnh báo từng dòng để bạn xem trước rồi mới lưu.'].forEach((t) => help.addRow([t]));
  help.getColumn(1).width = 90;
  return wb.xlsx.writeBuffer();
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return D.parseInput(v) || '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result != null) return String(v.result);
  }
  return String(v);
}

/** Đọc file Excel theo tiêu đề cột của file mẫu */
async function parseStudentFile(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const header = ws.getRow(1).values.map((v) => cellText(v).trim().toLowerCase());
  const idx = {};
  for (const c of students.IMPORT_COLUMNS) {
    const label = c.label.toLowerCase();
    const short = label.replace(/\s*\(.*\)\s*/g, '').trim();
    const i = header.findIndex((h) => h && (h === label || h.replace(/\s*\(.*\)\s*/g, '').trim() === short));
    if (i > 0) idx[c.key] = i;
  }
  if (!idx.full_name) throw Object.assign(new Error('Không tìm thấy cột "Họ tên học sinh". Vui lòng dùng file mẫu.'), { status: 400 });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = { __row: n };
    for (const [k, i] of Object.entries(idx)) r[k] = cellText(row.getCell(i).value).trim();
    if (Object.entries(r).some(([k, v]) => k !== '__row' && v)) {
      if (/dòng mẫu/i.test(r.note || '')) return;
      rows.push(r);
    }
  });
  return rows;
}

module.exports = { workbook, studentTemplate, parseStudentFile };
