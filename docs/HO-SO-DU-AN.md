# Hồ sơ dự án Eduspace Mini – đọc file này thay vì đọc lại toàn bộ mã

> Cập nhật: 13/11/2026 · Commit gần nhất khi viết: `611d71b` · Repo: https://github.com/Xichlo1234/eduspace-mini (riêng tư, nhánh `main`)
>
> Mục đích: ghi lại **yêu cầu, quyết định, kiến trúc, quy tắc tính tiền, bản đồ mã, lịch sử thay đổi, cách chạy/kiểm thử/triển khai**
> để lần sau (người hoặc Claude) tiếp tục làm việc chỉ cần đọc file này. Khi sửa mã, **cập nhật file này** (mục 11 – Nhật ký).

---

## 1. Bối cảnh & yêu cầu gốc

- Ứng dụng web quản lý **trung tâm tiếng Anh** quy mô nhỏ: **một cơ sở, < 200 học sinh**, một người (chủ) vận hành phần lớn công việc; tối đa 1 nhân viên + các giáo viên.
- Tham khảo quy trình “Eduspace – Quản lý đào tạo”, đã giản lược (không đa chi nhánh, không CRM, không kế toán/thuế/lương, không app di động, không tài khoản phụ huynh/học sinh).
- Tiếng Việt, dùng tốt trên máy tính & điện thoại; tiền **VND**; ngày **dd/mm/yyyy**; múi giờ **Asia/Ho_Chi_Minh**.
- Tiêu chí thành công: chủ trung tâm tự vận hành trên ứng dụng, không phải nhập lại dữ liệu vào nhiều file Excel.
- Người dùng (chủ repo GitHub `Xichlo1234`) dùng **Windows**, Node.js v26, **không cài Git** (tải ZIP từ GitHub), quen dùng **Cloudflare**, **không có VPS**.

### Yêu cầu bổ sung trong quá trình làm (theo thứ tự)
1. Tạo repo GitHub mới và đẩy mã → repo `eduspace-mini` (người dùng tự tạo repo trống vì phiên không có quyền tạo).
2. Chạy được trên Windows → bỏ `better-sqlite3` (cần biên dịch/Python), dùng `node:sqlite` có sẵn; `npm run demo` đa nền tảng.
3. **Học phí thường thu cuối kỳ** → thêm “Thời điểm thu” đầu kỳ/cuối kỳ cho từng lớp (mặc định **cuối kỳ**).
4. **Chỉ dạy tiếng Anh** → bỏ quản lý môn học, mọi lớp gắn môn “Tiếng Anh”.
5. **Đưa lên Cloudflare** (không VPS) → chạy trên Cloudflare Workers + Durable Object SQLite.

## 2. Vai trò & phân quyền (kiểm tra ở backend – `src/services/perms.js`)

| Quyền (`perms.can.*`) | Chủ (`owner`) | Nhân viên (`staff`) | Giáo viên (`teacher`) |
|---|---|---|---|
| manageStudents / manageClasses / collectMoney | ✔ | ✔ | ✘ |
| spendMoney (chi tiền) | ✔ | nếu `perm_expense` | ✘ |
| adjustMoney (miễn giảm, hủy/điều chỉnh giao dịch) | ✔ | nếu `perm_void` | ✘ |
| viewReports (báo cáo tài chính) | ✔ | nếu `perm_reports` | ✘ |
| payTeachers, manageSettings, manageUsers, backup | ✔ | ✘ | ✘ |
| Điểm danh/điểm/nhận xét | ✔ | ✔ | chỉ lớp mình phụ trách hoặc buổi dạy thay (`assertSessionAccess`) |

- Không có mật khẩu mặc định: lần đầu `/setup` cho chủ tự tạo tài khoản; tài khoản do chủ tạo phải đổi mật khẩu lần đầu (`must_change_password`).
- Mật khẩu: scrypt (`src/lib/password.js`), ≥ 8 ký tự có chữ và số. Phiên đăng nhập lưu bảng `auth_sessions` (cookie `sid`, 14 ngày), CSRF token theo phiên (`_csrf` trong mọi form POST), đăng nhập sai 8 lần/15 phút bị khóa tạm theo IP+tên.

## 3. Kiến trúc & công nghệ

- **Node.js ≥ 22.13**, **Express 5**, giao diện **EJS** render phía server + CSS/JS thuần (`public/`), không framework frontend.
- **SQLite** qua lớp bọc có cùng giao diện (`prepare().run/get/all`, `exec`, `pragma`, `transaction` lồng nhau, `backup`):
  - Node: `src/sqlite.js` (dùng `node:sqlite`, giao dịch lồng bằng SAVEPOINT).
  - Cloudflare: `src/sqlite-do.js` (dùng `ctx.storage.sql` của Durable Object; tham số `@ten` được đổi sang `?`; giao dịch = `storage.transactionSync`, lồng nhau chạy trong giao dịch ngoài).
- `src/db.js`: `initDb(db, schemaText)` (tạo bảng + `migrate`) dùng chung; `openDb(file)` chỉ cho Node.
- Giao diện: `src/views.js` – Node biên dịch `.ejs` lúc chạy; Cloudflare dùng hàm biên dịch sẵn `globalThis.__EDU_VIEWS__` (sinh bởi `scripts/build-cf.js`, vì Workers cấm `new Function` và ESM strict cấm `with`; biến tự do trong mẫu được lấy từ `locals` nhờ phân tích phạm vi bằng `espree` + `eslint-scope`). `res.render` được ghi đè trong `src/app.js` để đi qua `views.render`; `res.page(view, data)` = render view rồi bọc `layout`.
- **Hai môi trường chạy cùng một mã nguồn:**
  - **Máy (Node)**: `src/server.js` – mở `data/app.db` (hoặc `DATA_FILE`), gia hạn lịch & tự sao lưu `.db` mỗi 6 giờ (mỗi ngày 1 bản, giữ 30).
  - **Cloudflare Workers**: `cf/worker.js` – Worker gắn `x-forwarded-proto`/`x-forwarded-for` rồi chuyển mọi request vào **một Durable Object `EduspaceApp` tên "main"**, trong đó Express chạy qua `httpServerHandler` (`cloudflare:node`). File tĩnh `/public/*` do Cloudflare Assets phục vụ (`cf/assets`). `state.cloudflare = true` → `trust proxy` = true, không dùng `express.static`, sao lưu chỉ dạng JSON.

```
src/
  app.js          createApp(state): middleware (bảo mật header, body, cookie, phiên, flash, res.render/res.page, CSRF), gắn routes, xử lý lỗi
  server.js       chạy trên máy (Node)
  db.js           initDb/openDb/migrate/nextCode (mã tự sinh HS00001, HP000001, PT000001, PC/TK000001)
  schema.sql      lược đồ CSDL
  sqlite.js       adapter node:sqlite        sqlite-do.js  adapter Durable Object
  views.js        render EJS (Node) / hàm biên dịch sẵn (Cloudflare)
  lib/            dates.js (ngày VN, dd/mm/yyyy), money.js (vnd, parseMoney "800k", mustMoney), password.js, errors.js (AppError)
  services/       NGHIỆP VỤ (kiểm tra quyền tại đây)
    perms.js        phân quyền
    settings.js     cài đặt + giá trị mặc định (DEFAULTS)
    audit.js        nhật ký thao tác
    catalog.js      phòng, giáo viên, môn (chỉ "Tiếng Anh": defaultSubjectId)
    classes.js      lớp, lịch lặp, sinh buổi, trùng lịch, đổi lịch, hủy/dời buổi, ngày nghỉ
    students.js     hồ sơ, tìm kiếm, cảnh báo trùng, nhập Excel (validate/commit)
    enrollments.js  xếp lớp, chờ lớp, chuyển lớp, bảo lưu, quay lại, nghỉ, hoàn thành, quyết toán (settle), billUnbilled
    billing.js      tính học phí, khoản phải thu, phiếu thu, tiền trả trước, phân bổ, hủy/điều chỉnh, hoàn tiền
    bulk.js         tạo học phí hàng loạt (xem trước + ngoại lệ)
    attendance.js   điểm danh, xác nhận đã dạy, nhắc việc, vắng nhiều
    teacherpay.js   tiền dạy theo buổi đã xác nhận
    cashbook.js     thu khác / chi
    reports.js      báo cáo tài chính, công nợ, theo lớp, chuyên cần
    messages.js     mẫu tin phụ huynh, ghi nhận đã liên hệ
    dashboard.js    dữ liệu trang Tổng quan + checklist bắt đầu nhanh + nhắc kỳ thu cuối tháng
    excel.js        xuất/nhập Excel (exceljs)
    backup.js       sao lưu .db (Node) + exportData/importData JSON (cả hai môi trường)
    users.js        tài khoản, đăng nhập, phiên
  routes/         auth, main (tổng quan, lịch tuần, buổi học, tin nhắn), students, classes, finance, teachers, reports, settings, _util (h, need, tryForm, slotsFrom)
  views/          48 mẫu EJS (layout, partials/{csrf,form_error,slots,statement,settings_tabs}, ...)
cf/worker.js      điểm vào Cloudflare     wrangler.jsonc  cấu hình Cloudflare
scripts/          seed-demo.js (dữ liệu mẫu riêng data/demo.db), demo.js (npm run demo), build-cf.js, smoke.js,
                  backup.js, reset-owner-password.js, chay-trung-tam.bat, thu-nghiem-cloudflare.bat
test/             acceptance (12), postpaid (5), http (5), http-cf-views (5 – chạy lại http với giao diện biên dịch sẵn), helpers
docs/             PHAN-TICH-NGHIEP-VU.md, TRIEN-KHAI-CLOUDFLARE.md, HO-SO-DU-AN.md (file này)
```

## 4. Mô hình dữ liệu (`src/schema.sql`)

Tiền là số nguyên VND; ngày `YYYY-MM-DD` theo giờ VN; thời điểm ISO UTC.

| Bảng | Vai trò chính |
|---|---|
| settings, counters, audit_logs | cài đặt key/value; bộ đếm mã; nhật ký (người, thời điểm, lý do, dữ liệu) |
| users, auth_sessions | tài khoản & phiên |
| subjects (chỉ “Tiếng Anh”), rooms, teachers (`default_rate`/buổi), holidays | danh mục |
| classes | `fee_type` monthly/course/package, `fee_amount` (tháng / cả khóa / đơn giá buổi), `total_sessions` (khóa), `package_sessions` (gói trả trước), **`billing_timing` prepaid/postpaid**, `prorate_first_month`, `excused_absence_charged`, `unexcused_absence_charged`, `teacher_rate`, `generated_until` |
| class_schedules | lịch lặp theo thứ, có `effective_from/to` (đổi lịch = đóng phiên bản cũ) |
| class_sessions | buổi học; `teacher_id` = GV thực tế (dạy thay); `status` scheduled/completed/cancelled; `origin` = khung lịch gốc (UNIQUE theo lớp, chống sinh lại buổi đã hủy/dời); `teacher_rate` chốt khi xác nhận hoàn thành; AUTOINCREMENT |
| students | `code` HSxxxxx duy nhất; SĐT phụ huynh **không** là khóa (anh chị em dùng chung) |
| enrollments (+ enrollment_events) | mỗi lần đăng ký lớp; trạng thái waiting/active/reserved/completed/dropped/transferred; `start_date`/`end_date` quyết định danh sách điểm danh |
| reservations | bảo lưu: ngày, lý do, `credit_amount`, `credit_sessions` |
| attendance | UNIQUE(session, student); present/excused/unexcused/unmarked; điểm, nhận xét |
| invoices (+ invoice_adjustments) | khoản phải thu; `base_amount` theo cách tính, `amount` sau điều chỉnh; `period_key` (`YYYY-MM` / `COURSE` / `PKG-n`); `calc_detail` JSON diễn giải; **UNIQUE(enrollment_id, period_key) khi active**; hủy = `status='void'` |
| receipts | phiếu thu (mỗi lần nhận tiền 1 phiếu), `idempotency_key` UNIQUE, hủy = void + lý do |
| allocations | phân bổ tiền vào khoản phải thu (từ phiếu thu hoặc từ trả trước; **âm** = rút phần đã đóng dư ra) |
| credit_entries | sổ tiền trả trước; `reservation_id` ≠ NULL = tiền giữ cho bảo lưu |
| cash_transactions | thu khác/chi; tiền dạy GV UNIQUE(teacher_id, payout_month) khi valid; hoàn tiền `refund` |
| contact_logs, import_batches | đã liên hệ phụ huynh; phiên nhập Excel (chống lưu trùng) |

**Bất biến tiền** (kiểm thử kiểm tra): `tổng phiếu thu hợp lệ = tổng phân bổ hợp lệ + tổng credit_entries + tổng hoàn tiền`. Còn nợ = `amount − Σ allocations`.

**Migration** (`migrate` trong `src/db.js`, chạy mỗi lần mở CSDL, an toàn khi chạy lại): thêm cột `billing_timing` (lớp cũ = prepaid); gom mọi môn về “Tiếng Anh”.

## 5. Quy tắc nghiệp vụ & tính tiền (đã chốt)

### Lịch học (`classes.js`)
- Tạo lớp → sinh buổi từ lịch lặp, **bỏ ngày nghỉ**. Lớp khóa sinh tới khi đủ `total_sessions` buổi không hủy; lớp mở sinh tới `end_date` hoặc +120 ngày (tự gia hạn: `extendAll` khi mở tổng quan/lịch/khởi động/lập học phí).
- Thêm ngày nghỉ sau khi đã có lịch → hủy buổi chưa điểm danh ngày đó; lớp khóa tự thêm buổi bù cuối khóa. Hủy buổi (cần lý do) → lớp khóa tự bù.
- Đổi lịch lặp từ ngày áp dụng: xóa buổi `scheduled` chưa điểm danh từ ngày đó, sinh theo lịch mới; **không đụng buổi đã hoàn thành/đã điểm danh**.
- Trùng giờ GV/phòng: chặn (HTTP 409 `ConflictError` kèm danh sách), cho “vẫn lưu” bằng `force`.
- Đổi GV/phòng của lớp áp dụng cho buổi chưa dạy từ ngày chọn; đổi GV từng buổi = dạy thay.

### Học phí (`billing.js`)
- **Theo tháng** (`calcMonthly`): đủ tháng = mức phí; vào/ra giữa tháng & bật tỷ lệ → `phí × buổi trong thời gian đăng ký ÷ tổng buổi hợp lệ của tháng` (VD 800.000 × 4/8 = 400.000), làm tròn `rounding_step` (1.000đ). Buổi hủy không tính. Nếu lớp cấu hình “vắng … không tính phí”: giá trị buổi vắng tháng trước trừ vào tháng sau (một lần).
- **Theo khóa** (`calcCourse`): phí gắn tổng số buổi; vào muộn = `phí × buổi còn lại ÷ tổng`.
- **Theo buổi – thu đầu kỳ** (`calcPackage`): gói = `package_sessions × đơn giá`; theo dõi mua/dùng/còn (`packageUsage`); cảnh báo còn ≤ 2 buổi.
- **Theo buổi – thu cuối kỳ** (`calcPackageUsage`): tháng = số buổi **đã dạy xong & đã điểm danh** được tính (có mặt luôn tính; vắng tính theo cấu hình) × đơn giá.
- Mặc định vắng: tháng/khóa tính phí cả hai loại vắng; lớp gói: vắng có phép không trừ buổi, vắng không phép trừ buổi (tick trong form lớp).
- **Thời điểm thu** (`billing_timing`):
  - **Đầu kỳ (prepaid)**: xếp lớp → tạo ngay khoản kỳ đầu + trừ tiền trả trước; hạn = ngày `monthly_due_day` (10) của tháng, không sớm hơn ngày lập + `due_days` (7).
  - **Cuối kỳ (postpaid, mặc định lớp mới)**: xếp lớp **không** lập khoản (chỉ hiển thị dự tính); cuối tháng lập học phí tháng đã học qua “Tạo học phí hàng loạt”; lớp khóa lập khi buổi cuối đã qua; hạn = ngày `postpaid_due_day` (5) tháng sau (khóa: sau buổi cuối + 7 ngày), không sớm hơn ngày lập. Chuyển lớp/bảo lưu/nghỉ/hoàn thành gọi `billUnbilled` để lập phần đã học chưa lập (rồi trừ tiền trả trước).
  - Không đổi `fee_type` hay `billing_timing` khi lớp đã có khoản phải thu.
- **Khoản thu khác** (sách, đồng phục, khác): tạo trong hồ sơ học sinh, có hạn đóng; hoặc ghi “thu khác” ở sổ thu chi nếu không gắn học sinh.
- **Tạo hàng loạt** (`bulk.js`): hai tháng riêng – `ym` (đầu kỳ, mặc định tháng sau) và `ymPost` (cuối kỳ, mặc định tháng hiện tại nếu ngày ≥ 25, ngược lại tháng trước); ngoại lệ: đã có khoản, bảo lưu, không có buổi, buổi chưa điểm danh, gói trước chưa đóng đủ; commit chạy lại không tạo trùng. Tổng quan nhắc kỳ thu cuối tháng từ ngày 25 đến ngày 10.

### Tiền (`billing.js`)
- Thu tiền (`recordReceipt`): có `invoice_id` → phân bổ vào khoản có sẵn (**thu nợ không tạo thêm học phí**); vượt số còn nợ chỉ khi chọn “phần dư thành trả trước”; không `invoice_id` → **đặt cọc/trả trước**. `idempotency_key` từ form → bấm nhiều lần chỉ 1 phiếu (kể cả 2 request đồng thời). JS cũng khóa nút sau lần bấm đầu.
- Tiền trả trước tự trừ khi xếp lớp / lập khoản mới / lập hàng loạt (`applyCredit`), mỗi đồng dùng một lần.
- Miễn giảm/điều chỉnh (`adjustInvoice`) bắt buộc lý do, lưu `invoice_adjustments`; nếu số mới < đã đóng → phần dư rút ra trả trước (`releaseToCredit`).
- Hủy phiếu thu/khoản/giao dịch: chỉ đổi trạng thái + lý do + người + thời điểm; không xóa. Không hủy được khoản đã có tiền; không hủy phiếu cọc nếu tiền đã được dùng.
- Hoàn tiền trả trước: tạo đúng 1 phiếu chi `refund`.

### Chuyển lớp / bảo lưu / nghỉ (`enrollments.js`)
- Mọi thao tác có **xem trước** (dry-run: chạy logic thật trong giao dịch rồi rollback) → người dùng xác nhận bảng tính → mới ghi.
- `settle(cutoff)`: (cuối kỳ: lập phần chưa lập) → tính **nghĩa vụ đã phát sinh** trước ngày hiệu lực (`obligationStatement`: lớp tháng theo buổi trong tháng; khóa/gói phân bổ buổi đã dùng FIFO) → giảm khoản phải thu về đúng phần đã phát sinh → **chỉ phần đã đóng vượt nghĩa vụ** được rút ra trả trước → ưu tiên bù nợ cũ của chính đăng ký.
- Chuyển lớp: đăng ký cũ `transferred` (end_date = ngày trước hiệu lực), đăng ký mới từ ngày hiệu lực, giữ nguyên lịch sử điểm danh/phiếu thu.
- Bảo lưu: phần chuyển được đưa vào “ngăn bảo lưu” (`credit_entries.reservation_id`), không dùng cho việc khác; không phát sinh học phí khi bảo lưu; quay lại → chọn lớp, giá trị bảo lưu ra trả trước rồi trừ vào học phí.
- Nghỉ học: mặc định tính lại theo phần đã học (dư vào trả trước, hoàn khi chủ lập phiếu chi) hoặc chọn giữ nguyên học phí; không xóa dữ liệu.

### Điểm danh & tiền dạy
- Chỉ ghi khi bấm Lưu; nút “Đánh dấu tất cả có mặt”; không điểm danh buổi tương lai; tick “xác nhận đã dạy xong” → buổi `completed`, chốt `teacher_rate` (đơn giá lớp hoặc GV).
- Danh sách điểm danh của buổi = đăng ký có `start_date ≤ ngày ≤ end_date` (người đã chuyển/nghỉ vẫn hiện ở buổi cũ).
- Tiền dạy = buổi `completed` theo GV thực tế (dạy thay tính cho người dạy); buổi chỉ lên lịch không tính; chủ xác nhận chi → 1 giao dịch/GV/tháng.

### Báo cáo
Thực thu (phiếu thu + thu khác), thực chi, **chênh lệch thu–chi tiền (ghi rõ không phải lợi nhuận kế toán)**, học phí phát sinh, công nợ & quá hạn, tiền trả trước chưa phân bổ, tiền giữ bảo lưu, theo lớp, chuyên cần; xuất Excel (tổng hợp, phiếu thu, sổ thu chi, công nợ, học sinh, tiền dạy).

### Liên lạc phụ huynh (`messages.js`)
4 mẫu (nhắc học phí, báo vắng, đổi lịch, nhận xét) có biến `{hoc_sinh}`, `{lop}`, `{so_tien_con_no}`…; xem trước, sửa, **sao chép**, nút mở `https://zalo.me/<sđt>`, rồi người dùng tự bấm **“Đánh dấu đã liên hệ”**. Ứng dụng **không tự gửi** và không bao giờ hiện “đã gửi”.

## 6. Giao diện (menu 7 mục)
Tổng quan · Học sinh · Lớp học & lịch học · Học phí & thu chi · Giáo viên · Báo cáo (nếu có quyền) · Cài đặt. Giáo viên chỉ thấy: Tổng quan, Lịch dạy, Lớp của tôi, Buổi dạy & tiền dạy. Responsive (menu trượt trên điện thoại, bảng chuyển thành thẻ). Phiếu thu in khổ A5 / lưu PDF qua trình duyệt (`/receipts/:id?print=1`). Dữ liệu mẫu có dải vàng cảnh báo.

## 7. Chạy, kiểm thử, dữ liệu mẫu

| Việc | Lệnh |
|---|---|
| Cài | `npm install` |
| Dữ liệu mẫu (file riêng `data/demo.db`, cổng 3001, tài khoản `chu.demo` / `nhanvien.demo` / `gv.lan`, mật khẩu `Demo2026`) | `npm run demo` |
| Chạy thật trên máy (`data/app.db`, cổng 3000) | `npm start` (Windows: `scripts\chay-trung-tam.bat`) |
| Kiểm thử (28 bài) | `npm test` |
| Chạy giả lập Cloudflare (workerd) | `npx wrangler dev` (cổng 8787) |
| Kiểm thử toàn quy trình qua HTTP trên bản CSDL trống | `node scripts/smoke.js http://127.0.0.1:8787` |
| Kiểm tra gói triển khai | `npx wrangler deploy --dry-run --outdir /tmp/x` (≈ 831KB gzip, giới hạn Free 3MB) |
| Sao lưu .db dòng lệnh / đặt lại mật khẩu chủ | `npm run backup` / `node scripts/reset-owner-password.js "MatKhauMoi1"` |

Script dữ liệu mẫu **từ chối** ghi vào file không có chữ “demo” trong tên. Trong môi trường cloud của Claude: `gh` dùng được REST API theo repo (không GraphQL, không tạo repo); đẩy mã bằng `git push origin main` (cần `add_repo` repo vào phiên trước).

## 8. Triển khai Cloudflare (chi tiết: `docs/TRIEN-KHAI-CLOUDFLARE.md`)
- Cách khuyên dùng: Dashboard → Workers & Pages → Create → **Import a repository** → repo `Xichlo1234/eduspace-mini` → Project name `eduspace-mini`, Build command trống, Deploy `npx wrangler deploy`. Mỗi lần đẩy lên `main` tự triển khai lại; dữ liệu trong Durable Object giữ nguyên.
- `wrangler.jsonc`: `main: cf/worker.js`, `compatibility_flags: ["nodejs_compat"]`, `build.command: node scripts/build-cf.js`, `assets.directory: cf/assets`, rule Text cho `*.sql`, DO binding `APP` → class `EduspaceApp`, migration `v1` `new_sqlite_classes`. **Không đổi tên class/migration** (mất dữ liệu); thêm migration mới nếu cần.
- Sau triển khai: mở ngay URL tạo tài khoản chủ (trang /setup mở cho người đầu tiên). Nên bật Cloudflare Access. Sao lưu JSON hằng tuần (Cài đặt → Sao lưu). Chuyển dữ liệu máy → Cloudflare bằng file JSON.
- Phương án dự phòng: chạy trên máy tại trung tâm + Cloudflare Tunnel (`scripts/thu-nghiem-cloudflare.bat`).
- **Trạng thái khi viết file này:** mã đã sẵn sàng & kiểm thử trên workerd; **người dùng chưa xác nhận đã triển khai thành công** lên tài khoản Cloudflare.

## 9. Lưu ý kỹ thuật dễ vấp (đã gặp)
- `better-sqlite3` không có bản dựng sẵn cho Node 26 trên Windows → đã thay bằng `node:sqlite` (require bằng chuỗi ghép để bundler Cloudflare không cố nạp).
- Express 4 lỗi khi bundle cho Workers (iconv-lite) → dùng **Express 5**; Express 5 để `req.body` undefined khi không có body → middleware gán `{}`.
- Workers không có `__dirname`, `new Function`, `with` → `views.js` kiểm tra `__dirname`; giao diện biên dịch sẵn.
- Durable Object SQL: không có `BEGIN/SAVEPOINT` (dùng `transactionSync`), một số PRAGMA bị cấm (adapter bỏ qua lỗi), không `VACUUM INTO`/backup file.
- `exceljs`, `multer` (memoryStorage) chạy được trên Workers với `nodejs_compat`. Mọi upload dùng bộ nhớ (không ghi đĩa).
- Thuộc tính `hidden` bị `display:flex` đè → CSS đầu file: `[hidden]{display:none!important}`.
- Form gửi `action=preview|confirm` qua nút submit; JS khóa nút **sau** khi gửi (không thêm input ẩn – từng gây gửi trùng giá trị `action` thành mảng).
- Hạn đóng không bao giờ sớm hơn ngày lập khoản (kiểm thử dùng `max(...)` theo ngày hiện tại).
- Cookie `sid` có `Secure` khi qua HTTPS (dựa `x-forwarded-proto`, `trust proxy`).

## 10. Việc có thể làm tiếp (chưa làm)
- Gửi Zalo/SMS tự động (Zalo OA/ZNS có phí), QR VietQR trên phiếu thu/tin nhắc phí.
- Mã bảo vệ trang `/setup` khi mới triển khai (biến môi trường) – hiện dựa vào việc chủ mở ngay sau deploy.
- Sao lưu JSON tự động định kỳ trên Cloudflare (ví dụ ghi vào R2 bằng alarm của Durable Object).
- Nhiều chi nhánh, cổng phụ huynh (ngoài phạm vi phiên bản đầu).

## 11. Nhật ký thay đổi (commit trên `main`)

| Commit | Nội dung |
|---|---|
| `c63925b` | Phiên bản đầu: toàn bộ nghiệp vụ (lớp/lịch, học sinh/Excel, xếp lớp/chờ/đặt cọc, điểm danh, học phí tháng/khóa/gói, phiếu thu, công nợ, chuyển lớp, bảo lưu, thu chi, tiền dạy, liên lạc, báo cáo, sao lưu, phân quyền, dữ liệu mẫu, 17 kiểm thử) |
| `211a8a1` | `npm run demo` chạy trên Windows; hướng dẫn tải ZIP không cần Git |
| `50e187c` | Thay `better-sqlite3` bằng `node:sqlite` (cài không cần Python/Visual Studio) |
| `3f56217` | Thu học phí **cuối kỳ** (trả sau) theo lớp; hạn ngày 5 tháng sau; lập tự động khi chuyển/bảo lưu/nghỉ; tạo hàng loạt 2 tháng; nhắc trên tổng quan; khoản thu khác có hạn đóng; sửa CSS `hidden`; 5 kiểm thử |
| `4f752d8` | Chỉ dạy **tiếng Anh**: bỏ quản lý môn, gom dữ liệu về “Tiếng Anh” |
| `7abb8c4` | Hướng dẫn Cloudflare Tunnel + `.bat` chạy trên Windows (phương án dự phòng) |
| `611d71b` | Chạy **trực tiếp trên Cloudflare Workers + Durable Object SQLite**; Express 5; giao diện biên dịch sẵn; logo trong CSDL; sao lưu/khôi phục JSON; `scripts/smoke.js`; 28 kiểm thử |

> Khi thêm thay đổi: thêm một dòng vào bảng trên, cập nhật các mục bị ảnh hưởng (quy tắc tính tiền, bản đồ mã, lưu ý) và số lượng kiểm thử.
