# Eduspace Mini – Quản lý trung tâm đào tạo nhỏ

Ứng dụng web quản lý trung tâm **một cơ sở, dưới 200 học sinh**, để **một người** vận hành phần lớn công việc hằng ngày: lớp & lịch học, học sinh, điểm danh, học phí – công nợ – phiếu thu, chuyển lớp/bảo lưu, thu chi, tiền dạy giáo viên, liên lạc phụ huynh và báo cáo.

- Giao diện tiếng Việt, dùng tốt trên máy tính và điện thoại.
- Tiền VND, ngày `dd/mm/yyyy`, múi giờ Việt Nam.
- Một ứng dụng Node.js + một file CSDL SQLite (dùng `node:sqlite` có sẵn, không cần biên dịch): chi phí thấp, dễ sao lưu, dễ bảo trì.

Phân tích nghiệp vụ, mô hình dữ liệu, chính sách học phí và kết quả kiểm thử: **[docs/PHAN-TICH-NGHIEP-VU.md](docs/PHAN-TICH-NGHIEP-VU.md)**.

## Chạy thử nhanh với dữ liệu mẫu

Yêu cầu: Node.js 22.13 trở lên (khuyên dùng bản LTS mới nhất; dùng SQLite có sẵn trong Node, không cần Python hay Visual Studio) (https://nodejs.org). Không bắt buộc cài Git: có thể tải mã nguồn bằng nút **Code → Download ZIP** trên GitHub rồi giải nén. Các lệnh dưới đây chạy được trên Windows (Command Prompt), macOS và Linux, chạy trong thư mục đã giải nén.

```bash
npm install
```

```bash
npm run demo
```

Mở http://localhost:3001 – đăng nhập `chu.demo` / `Demo2026` (chủ), `nhanvien.demo` / `Demo2026` (nhân viên), `gv.lan` / `Demo2026` (giáo viên).

Dữ liệu mẫu nằm trong file **riêng** `data/demo.db` (có dải cảnh báo “DỮ LIỆU MẪU” trên mọi trang). Script tạo mẫu từ chối ghi vào file không có chữ “demo” trong tên, nên không bao giờ đụng tới dữ liệu thật `data/app.db`.

## Cài đặt dùng thật

```bash
npm install --omit=dev
```

```bash
npm start
```

Mở http://localhost:3000. Lần đầu, ứng dụng yêu cầu **tạo tài khoản chủ trung tâm** (tự đặt mật khẩu – không có mật khẩu mặc định). Trang Tổng quan hiển thị danh sách “Bắt đầu nhanh”:

1. Cài đặt → nhập tên trung tâm, logo, địa chỉ, thông tin chuyển khoản, chính sách.
2. Cài đặt → Phòng học (chỉ cần khi có nhiều phòng). Trung tâm chỉ dạy tiếng Anh nên không cần khai báo môn học: mọi lớp tự gắn môn Tiếng Anh, phân biệt chương trình bằng tên lớp (Starters, Movers, IELTS…).
3. Giáo viên → thêm giáo viên (nếu tự dạy, thêm chính mình) và đơn giá/buổi.
4. Cài đặt → Ngày nghỉ (lễ, Tết).
5. Lớp học → Tạo lớp: chọn lịch trong tuần, hình thức & mức học phí → hệ thống tự sinh buổi học.
6. Học sinh → Thêm (hoặc nhập Excel theo file mẫu) → “Lưu & xếp lớp ngay” → xem bảng tính → xác nhận → thu tiền, in phiếu.

Biến môi trường: `PORT` (mặc định 3000), `DATA_FILE` (mặc định `data/app.db`), `HOST`.

### Triển khai

**Đưa lên Internet bằng Cloudflare (khuyên dùng, miễn phí):** xem **[docs/TRIEN-KHAI-CLOUDFLARE.md](docs/TRIEN-KHAI-CLOUDFLARE.md)** – chạy ứng dụng trên máy tại trung tâm bằng `scripts/chay-trung-tam.bat`, rồi dùng Cloudflare Tunnel để có địa chỉ HTTPS dạng `https://quanly.tentrungtam.vn`.


- **Máy tính tại trung tâm / VPS rẻ (1 vCPU, 512MB RAM là đủ):** chạy `npm start` dưới `pm2` hoặc systemd, đặt sau Nginx/Caddy có HTTPS.
- **Docker:**

```bash
docker build -t eduspace-mini .
```

```bash
docker run -d --name eduspace -p 3000:3000 -v eduspace-data:/data --restart unless-stopped eduspace-mini
```

Khi đưa lên Internet, bắt buộc dùng HTTPS (cookie đăng nhập được đặt `Secure` khi truy cập qua HTTPS phía sau proxy).

## Sao lưu & khôi phục

Toàn bộ dữ liệu (kể cả logo trong `data/uploads/`) nằm trong thư mục `data/`.

- **Tự động:** mỗi ngày một bản vào `data/backups/auto-*.db`, giữ 30 bản gần nhất.
- **Tải về máy:** Cài đặt → Sao lưu → “Tải bản sao lưu hiện tại” (nên làm hằng tuần, lưu lên Google Drive/USB).
- **Dòng lệnh:**

```bash
npm run backup
```

- **Khôi phục:** Cài đặt → Sao lưu → chọn file `.db` → gõ `KHOI PHUC`. Hệ thống kiểm tra file, **tự sao lưu dữ liệu hiện tại** (`before-restore-*.db`) rồi mới thay thế; mọi người đăng nhập lại.
- **Khôi phục thủ công khi máy hỏng:** cài lại ứng dụng, dừng ứng dụng, chép file sao lưu thành `data/app.db`, khởi động lại.

### Khôi phục mật khẩu chủ

Chạy trên máy chủ:

```bash
node scripts/reset-owner-password.js "MatKhauMoi123"
```

## Xuất Excel

Học sinh, công nợ, phiếu thu, sổ thu chi, báo cáo tổng hợp, tiền dạy giáo viên (Báo cáo → Xuất Excel). Nhập học sinh từ Excel có file mẫu, kiểm tra lỗi và xem trước trước khi lưu.

## Kiểm thử

```bash
npm test
```

22 kiểm thử (gồm thu cuối kỳ): các tình huống nghiệm thu (học phí theo tỷ lệ, thu nợ, đặt cọc, ngày lễ, chuyển lớp, bảo lưu, dạy thay, phân quyền, chống bấm trùng…) và kiểm thử HTTP duyệt toàn bộ trang với dữ liệu mẫu.

## Cấu trúc mã

```
src/
  server.js          khởi động, gia hạn lịch & sao lưu tự động
  app.js             Express: phiên đăng nhập, CSRF, bố cục, xử lý lỗi
  schema.sql         lược đồ CSDL
  services/          nghiệp vụ (kiểm tra quyền ở đây): classes, students, enrollments,
                     billing, attendance, bulk, cashbook, teacherpay, reports, messages…
  routes/            các trang
  views/             giao diện EJS
public/              CSS, JS
scripts/             dữ liệu mẫu, sao lưu, đặt lại mật khẩu chủ
test/                kiểm thử nghiệm thu
```

## Phần mở rộng sau

Gửi Zalo/SMS tự động (cần Zalo OA/ZNS có phí – hiện tại ứng dụng chỉ soạn tin, sao chép và để người dùng tự đánh dấu “đã liên hệ”, không bao giờ hiển thị “đã gửi” khi chưa gửi), QR chuyển khoản VietQR trên phiếu, nhiều chi nhánh, cổng phụ huynh.
