'use strict';

const DEFAULTS = {
  center_name: 'Trung tâm của tôi',
  center_address: '',
  center_phone: '',
  center_email: '',
  logo_path: '',
  bank_info: '',
  rounding_step: '1000',           // làm tròn học phí tính theo tỷ lệ
  due_days: '7',                   // hạn đóng = ngày phát hành + n ngày (khoản phát sinh khi xếp lớp)
  monthly_due_day: '10',           // hạn đóng học phí tháng: ngày n của tháng
  package_low_threshold: '2',      // cảnh báo sắp hết gói khi còn <= n buổi
  absence_alert_count: '3',        // cảnh báo vắng nhiều: >= n buổi vắng trong 30 ngày
  reservation_alert_days: '7',     // cảnh báo sắp hết bảo lưu trước n ngày
  receipt_title: 'PHIẾU THU',
  receipt_footer: 'Cảm ơn quý phụ huynh. Vui lòng giữ phiếu thu để đối chiếu khi cần.',
  tuition_policy: 'Học phí đóng trước ngày 10 hằng tháng. Buổi trung tâm cho nghỉ không tính phí.',
  tpl_fee: 'Kính gửi phụ huynh em {hoc_sinh},\n{trung_tam} xin thông báo học phí lớp {lop} kỳ {ky}: {so_tien_phai_thu}. Đã đóng: {so_tien_da_dong}. Còn lại: {so_tien_con_no}.\nHạn đóng: {han_dong}.\n{thong_tin_chuyen_khoan}\nTrân trọng cảm ơn!',
  tpl_absence: 'Kính gửi phụ huynh em {hoc_sinh},\nHôm nay {ngay} em vắng buổi học lớp {lop} ({gio}). Trạng thái: {trang_thai_vang}.\nPhụ huynh vui lòng phản hồi giúp trung tâm. Cảm ơn!\n{trung_tam} – {sdt_trung_tam}',
  tpl_schedule: 'Kính gửi phụ huynh em {hoc_sinh},\n{trung_tam} thông báo thay đổi lịch học lớp {lop}: {noi_dung_thay_doi}.\nMong phụ huynh thông cảm. Cảm ơn!',
  tpl_review: 'Kính gửi phụ huynh em {hoc_sinh},\nNhận xét học tập lớp {lop} (gần đây):\n{nhan_xet}\nChuyên cần: {chuyen_can}.\n{trung_tam}',
};

function getAll(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function get(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : DEFAULTS[key];
}
function getInt(db, key) { return parseInt(get(db, key), 10) || 0; }
function set(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value == null ? '' : String(value));
}
module.exports = { DEFAULTS, getAll, get, getInt, set };
