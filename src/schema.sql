-- Lược đồ CSDL – Eduspace Mini
-- Tiền: số nguyên VND. Ngày: 'YYYY-MM-DD' theo giờ Việt Nam. Thời điểm: ISO UTC.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','staff','teacher')),
  teacher_id    INTEGER REFERENCES teachers(id),
  perm_expense  INTEGER NOT NULL DEFAULT 0, -- nhân viên được chi tiền
  perm_void     INTEGER NOT NULL DEFAULT 0, -- nhân viên được hủy/điều chỉnh giao dịch, miễn giảm
  perm_reports  INTEGER NOT NULL DEFAULT 0, -- nhân viên được xem báo cáo tài chính
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  csrf       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  reason     TEXT,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE IF NOT EXISTS subjects (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS rooms (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  capacity INTEGER,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS teachers (
  id           INTEGER PRIMARY KEY,
  full_name    TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  default_rate INTEGER NOT NULL DEFAULT 0, -- đơn giá/buổi mặc định
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS holidays (
  id   INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  subject_id      INTEGER REFERENCES subjects(id),
  teacher_id      INTEGER REFERENCES teachers(id),
  room_id         INTEGER REFERENCES rooms(id),
  max_students    INTEGER,
  start_date      TEXT NOT NULL,
  end_date        TEXT,                -- tùy chọn, với lớp tháng/gói
  total_sessions  INTEGER,             -- bắt buộc với lớp theo khóa
  fee_type        TEXT NOT NULL CHECK (fee_type IN ('monthly','course','package')),
  fee_amount      INTEGER NOT NULL DEFAULT 0, -- tháng: phí/tháng; khóa: phí cả khóa; gói: đơn giá/buổi
  package_sessions INTEGER,            -- gói: số buổi mỗi gói
  prorate_first_month INTEGER NOT NULL DEFAULT 1, -- tháng: nhập học giữa tháng tính theo tỷ lệ buổi
  excused_absence_charged   INTEGER NOT NULL DEFAULT 1, -- vắng có phép vẫn tính phí / trừ buổi
  unexcused_absence_charged INTEGER NOT NULL DEFAULT 1, -- vắng không phép vẫn tính phí / trừ buổi
  teacher_rate    INTEGER,             -- đơn giá tiền dạy riêng của lớp (nếu khác mặc định GV)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','cancelled')),
  generated_until TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Lịch lặp theo tuần, có hiệu lực theo khoảng ngày (đổi lịch = đóng phiên bản cũ, mở phiên bản mới)
CREATE TABLE IF NOT EXISTS class_schedules (
  id             INTEGER PRIMARY KEY,
  class_id       INTEGER NOT NULL REFERENCES classes(id),
  weekday        INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1=Thứ 2 ... 7=Chủ nhật
  start_time     TEXT NOT NULL,
  end_time       TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to   TEXT                -- NULL = còn hiệu lực
);
CREATE INDEX IF NOT EXISTS ix_sched_class ON class_schedules(class_id);

CREATE TABLE IF NOT EXISTS class_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id      INTEGER NOT NULL REFERENCES classes(id),
  date          TEXT NOT NULL,
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  teacher_id    INTEGER REFERENCES teachers(id), -- giáo viên thực tế (có thể dạy thay)
  room_id       INTEGER REFERENCES rooms(id),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  cancel_reason TEXT,
  is_makeup     INTEGER NOT NULL DEFAULT 0,
  origin        TEXT,               -- 'YYYY-MM-DD|HH:MM' của khung lịch lặp sinh ra buổi này (giữ nguyên khi dời buổi)
  attendance_saved_at TEXT,
  completed_at  TEXT,
  completed_by  INTEGER REFERENCES users(id),
  teacher_rate  INTEGER,             -- chốt đơn giá khi xác nhận hoàn thành
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_sess_class_date ON class_sessions(class_id, date);
CREATE INDEX IF NOT EXISTS ix_sess_date ON class_sessions(date);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sess_origin ON class_sessions(class_id, origin) WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sess_teacher ON class_sessions(teacher_id, date);

CREATE TABLE IF NOT EXISTS students (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  full_name    TEXT NOT NULL,
  dob          TEXT,
  gender       TEXT,
  parent_name  TEXT,
  parent_phone TEXT,
  address      TEXT,
  entry_level  TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_students_phone ON students(parent_phone);

-- Mỗi lần đăng ký lớp. Trạng thái quản lý theo đăng ký.
CREATE TABLE IF NOT EXISTS enrollments (
  id           INTEGER PRIMARY KEY,
  student_id   INTEGER NOT NULL REFERENCES students(id),
  class_id     INTEGER REFERENCES classes(id), -- NULL khi chờ xếp lớp chưa chọn lớp
  subject_id   INTEGER REFERENCES subjects(id), -- nhu cầu khi chờ xếp lớp
  status       TEXT NOT NULL CHECK (status IN ('waiting','active','reserved','completed','dropped','transferred')),
  start_date   TEXT,
  end_date     TEXT,
  from_enrollment_id INTEGER REFERENCES enrollments(id),
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_enr_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS ix_enr_class ON enrollments(class_id, status);

CREATE TABLE IF NOT EXISTS enrollment_events (
  id            INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  type          TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  date          TEXT,
  reason        TEXT,
  data          TEXT,
  user_id       INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id                   INTEGER PRIMARY KEY,
  enrollment_id        INTEGER NOT NULL REFERENCES enrollments(id),
  student_id           INTEGER NOT NULL REFERENCES students(id),
  start_date           TEXT NOT NULL,
  expected_return_date TEXT,
  reason               TEXT NOT NULL,
  credit_amount        INTEGER NOT NULL DEFAULT 0, -- giá trị học phí còn được sử dụng
  credit_sessions      INTEGER NOT NULL DEFAULT 0, -- số buổi còn được sử dụng (gói/khóa)
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned','closed')),
  returned_enrollment_id INTEGER REFERENCES enrollments(id),
  returned_at          TEXT,
  calc_detail          TEXT,
  created_by           INTEGER REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attendance (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES class_sessions(id),
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
  student_id    INTEGER NOT NULL REFERENCES students(id),
  status        TEXT NOT NULL DEFAULT 'unmarked' CHECK (status IN ('present','excused','unexcused','unmarked')),
  score         REAL,
  comment       TEXT,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TEXT,
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS ix_att_enr ON attendance(enrollment_id);

-- Khoản phải thu
CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  student_id    INTEGER NOT NULL REFERENCES students(id),
  enrollment_id INTEGER REFERENCES enrollments(id),
  class_id      INTEGER REFERENCES classes(id),
  category      TEXT NOT NULL DEFAULT 'tuition', -- tuition/book/uniform/other
  period_key    TEXT,               -- '2026-11' | 'COURSE' | 'PKG-1' ...
  period_label  TEXT,
  description   TEXT,
  base_amount   INTEGER NOT NULL,   -- số tiền theo cách tính
  amount        INTEGER NOT NULL,   -- số phải thu sau điều chỉnh
  sessions_count INTEGER,           -- gói: số buổi mua; tháng/khóa: số buổi tính phí
  due_date      TEXT,
  calc_detail   TEXT,               -- diễn giải cách tính (JSON)
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  void_reason   TEXT,
  voided_by     INTEGER REFERENCES users(id),
  voided_at     TEXT,
  idempotency_key TEXT UNIQUE,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Không tạo trùng khoản phải thu cho cùng đăng ký (học sinh + lớp) và kỳ
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_period ON invoices(enrollment_id, period_key)
  WHERE status = 'active' AND enrollment_id IS NOT NULL AND period_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_inv_student ON invoices(student_id);

-- Lịch sử miễn giảm / điều chỉnh học phí
CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id         INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  delta      INTEGER NOT NULL,     -- âm = giảm, dương = tăng
  kind       TEXT NOT NULL,        -- discount/increase/transfer/reservation/drop
  reason     TEXT NOT NULL,
  old_amount INTEGER NOT NULL,
  new_amount INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Phiếu thu: mỗi lần nhận tiền một phiếu
CREATE TABLE IF NOT EXISTS receipts (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  student_id    INTEGER NOT NULL REFERENCES students(id),
  invoice_id    INTEGER REFERENCES invoices(id), -- NULL = đặt cọc / trả trước
  class_id      INTEGER REFERENCES classes(id),
  period_label  TEXT,
  kind          TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','deposit')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  paid_date     TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('cash','transfer')),
  payer_name    TEXT,
  collector_id  INTEGER REFERENCES users(id),
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  void_reason   TEXT,
  voided_by     INTEGER REFERENCES users(id),
  voided_at     TEXT,
  idempotency_key TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_receipt_student ON receipts(student_id);
CREATE INDEX IF NOT EXISTS ix_receipt_date ON receipts(paid_date);

-- Sổ tiền trả trước của học sinh (đặt cọc, tiền dư, giá trị chuyển lớp, bảo lưu)
-- reservation_id NOT NULL = tiền đang giữ cho một lần bảo lưu (không dùng được cho việc khác)
CREATE TABLE IF NOT EXISTS credit_entries (
  id             INTEGER PRIMARY KEY,
  student_id     INTEGER NOT NULL REFERENCES students(id),
  amount         INTEGER NOT NULL,  -- dương = tăng số dư, âm = dùng
  type           TEXT NOT NULL,     -- deposit/overpay/release/apply/reserve_in/reserve_out/refund/void
  reservation_id INTEGER REFERENCES reservations(id),
  receipt_id     INTEGER REFERENCES receipts(id),
  invoice_id     INTEGER REFERENCES invoices(id),
  note           TEXT,
  user_id        INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_credit_student ON credit_entries(student_id);

-- Phân bổ tiền vào khoản phải thu (từ phiếu thu hoặc từ số dư trả trước). Âm = rút ra khi giảm nghĩa vụ.
CREATE TABLE IF NOT EXISTS allocations (
  id              INTEGER PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES invoices(id),
  amount          INTEGER NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('receipt','credit')),
  receipt_id      INTEGER REFERENCES receipts(id),
  credit_entry_id INTEGER REFERENCES credit_entries(id),
  status          TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  user_id         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_alloc_invoice ON allocations(invoice_id);

-- Thu chi ngoài học phí học sinh (thuê phòng, điện nước, tiền dạy, thu khác...)
CREATE TABLE IF NOT EXISTS cash_transactions (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  date          TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  category      TEXT NOT NULL,
  party         TEXT,
  method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','transfer')),
  note          TEXT,
  teacher_id    INTEGER REFERENCES teachers(id),
  student_id    INTEGER REFERENCES students(id),
  payout_month  TEXT,
  status        TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  void_reason   TEXT,
  voided_by     INTEGER REFERENCES users(id),
  voided_at     TEXT,
  idempotency_key TEXT UNIQUE,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_cash_date ON cash_transactions(date);
-- Mỗi giáo viên mỗi tháng chỉ một giao dịch chi tiền dạy còn hiệu lực
CREATE UNIQUE INDEX IF NOT EXISTS ux_teacher_payout ON cash_transactions(teacher_id, payout_month)
  WHERE status = 'valid' AND category = 'teacher_pay';

CREATE TABLE IF NOT EXISTS contact_logs (
  id         INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  template   TEXT,
  content    TEXT NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'zalo',
  note       TEXT,
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS import_batches (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
