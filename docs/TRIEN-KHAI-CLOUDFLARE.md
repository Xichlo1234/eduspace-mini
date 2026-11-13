# Đưa Eduspace Mini lên Internet bằng Cloudflare Tunnel

## Vì sao dùng Cloudflare Tunnel (không dùng Cloudflare Pages/Workers)

Eduspace Mini là một server Node.js lưu toàn bộ dữ liệu trong **một file SQLite trên ổ đĩa** (`data/app.db`).
Cloudflare Pages/Workers không có ổ đĩa lâu dài, nên không chạy được kiểu ứng dụng này nếu không viết lại phần dữ liệu.

**Cloudflare Tunnel** giải quyết đúng nhu cầu:

```
Điện thoại / máy tính ở bất kỳ đâu
        │  https://quanly.tentrungtam.vn   (HTTPS, chứng chỉ do Cloudflare cấp)
        ▼
   Cloudflare  ◄──── đường hầm mã hóa (cloudflared tự kết nối ra ngoài) ────┐
                                                                           │
                         Máy tính đặt tại trung tâm (hoặc VPS)             │
                         ├─ Eduspace Mini  http://localhost:3000  ◄─────────┘
                         └─ data/app.db  (dữ liệu của bạn, nằm trên máy bạn)
```

- Miễn phí; không cần IP tĩnh, không cần mở cổng modem.
- Dữ liệu vẫn nằm trên máy của trung tâm, sao lưu như hướng dẫn trong README.
- Máy chạy ứng dụng phải **bật và có mạng** thì mọi người mới truy cập được (nếu muốn chạy 24/7 không phụ thuộc máy tại trung tâm, dùng một VPS ~100–150 nghìn/tháng và làm y hệt các bước dưới).

## Bước 0 – Chạy ứng dụng với dữ liệu thật

Trên máy sẽ làm “máy chủ” (Windows):

1. Cài Node.js bản LTS (https://nodejs.org) nếu chưa có.
2. Giải nén mã nguồn vào một thư mục cố định, ví dụ `C:\eduspace-mini` (không để trên Desktop/Downloads để tránh xóa nhầm).
3. Bấm đúp `scripts\chay-trung-tam.bat`. Lần đầu sẽ tự cài thư viện. Khi thấy `Eduspace Mini đang chạy: http://localhost:3000` là xong.
4. Mở http://localhost:3000 → tạo tài khoản chủ trung tâm (mật khẩu mạnh, vì sắp đưa lên Internet).

> Dữ liệu mẫu (`npm run demo`, cổng 3001) chỉ để thử, **không** đưa dữ liệu mẫu lên Internet.

## Bước 1 – Thử nhanh (không cần tài khoản, không cần tên miền)

1. Tải `cloudflared` cho Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (file `cloudflared-windows-amd64.msi`), cài đặt.
2. Giữ ứng dụng đang chạy (bước 0), bấm đúp `scripts\thu-nghiem-cloudflare.bat`.
3. Trong cửa sổ hiện ra dòng `https://xxxx-xxxx.trycloudflare.com` → mở địa chỉ đó trên điện thoại (dùng 4G để chắc chắn đi qua Internet).

Địa chỉ này **tạm thời**, đổi mỗi lần chạy – chỉ để kiểm tra. Dùng lâu dài làm Bước 2.

## Bước 2 – Tên miền cố định (dùng lâu dài)

Cần: tài khoản Cloudflare (miễn phí) và **một tên miền** đã trỏ nameserver về Cloudflare
(mua tên miền `.vn`/`.com` ở nhà cung cấp bất kỳ, rồi trong Cloudflare chọn *Add a domain* và làm theo hướng dẫn đổi nameserver).

1. Vào https://one.dash.cloudflare.com → **Networks → Tunnels → Create a tunnel** → chọn **Cloudflared** → đặt tên, ví dụ `eduspace`.
2. Ở bước *Install connector*, chọn **Windows**, sao chép lệnh dạng
   `cloudflared.exe service install eyJhIjoi...` → mở **Command Prompt bằng quyền Administrator** → dán và chạy.
   Lệnh này cài cloudflared thành dịch vụ Windows, tự chạy khi bật máy.
3. Bấm **Next** → *Public hostname*:
   - Subdomain: `quanly` · Domain: `tentrungtam.vn`
   - Service: **Type** `HTTP` · **URL** `localhost:3000`
4. **Save tunnel**. Sau ~1 phút mở `https://quanly.tentrungtam.vn` là dùng được.

Ứng dụng đã được cấu hình sẵn để chạy sau Cloudflare: nhận đúng HTTPS, cookie đăng nhập đặt chế độ `Secure`, chống dò mật khẩu theo IP thật của người dùng.

## Bước 3 – Cho ứng dụng tự chạy khi bật máy

cloudflared đã tự chạy (dịch vụ Windows). Với ứng dụng:

1. Nhấn `Win + R`, gõ `shell:startup`, Enter.
2. Tạo **shortcut** tới `C:\eduspace-mini\scripts\chay-trung-tam.bat` trong thư mục vừa mở.
3. Trong Windows: *Settings → System → Power* đặt **Sleep: Never** khi cắm điện (máy ngủ thì không truy cập được).

## Bước 4 (khuyên dùng) – Thêm lớp bảo vệ Cloudflare Access

Ứng dụng đã có đăng nhập riêng, nhưng có thể bật thêm Cloudflare Access để chỉ email được phép mới thấy trang đăng nhập:

1. Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Domain: `quanly.tentrungtam.vn`.
3. Policy: *Allow* · *Emails* = email của chủ, nhân viên, giáo viên. Phương thức đăng nhập: *One-time PIN* (mã gửi qua email).
4. Miễn phí cho tối đa 50 người dùng.

## Vận hành an toàn

- **Sao lưu**: Cài đặt → Sao lưu → tải bản sao lưu về máy khác/Google Drive **mỗi tuần** (máy chủ hỏng ổ cứng là mất dữ liệu nếu không có bản sao).
- **Cập nhật phiên bản mới**: tắt cửa sổ `chay-trung-tam.bat` → sao lưu → giải nén mã mới đè lên (giữ nguyên thư mục `data`) → chạy lại `chay-trung-tam.bat`. Ứng dụng tự nâng cấp CSDL.
- **Không** chép/xóa thư mục `data` khi ứng dụng đang chạy.
- Quên mật khẩu chủ: xem README → “Khôi phục mật khẩu chủ”.

## Nếu muốn chạy trên VPS Linux thay cho máy tại trung tâm

```bash
git clone https://github.com/Xichlo1234/eduspace-mini && cd eduspace-mini && npm install --omit=dev
```

Chạy nền bằng systemd hoặc `docker run` (xem README), rồi làm Bước 2 với lệnh cài connector dành cho Linux mà Cloudflare hiển thị. Service URL vẫn là `localhost:3000`.
