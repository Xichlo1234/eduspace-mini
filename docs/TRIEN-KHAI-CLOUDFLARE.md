# Đưa Eduspace Mini lên Cloudflare

Ứng dụng chạy **trực tiếp trên Cloudflare Workers**, không cần máy tính bật tại trung tâm, không cần VPS.

```
Trình duyệt (máy tính, điện thoại)
        │ https://eduspace-mini.<ten-ban>.workers.dev  (hoặc tên miền riêng)
        ▼
Cloudflare Worker ──► Durable Object "main"
                       ├─ ứng dụng Eduspace Mini (Express)
                       └─ CSDL SQLite của Cloudflare (lưu lâu dài, Cloudflare tự sao lưu 30 ngày)
File tĩnh (CSS, JS) do Cloudflare phục vụ trực tiếp.
```

**Chi phí:** gói **Workers Free** là đủ cho trung tâm dưới 200 học sinh (100.000 lượt truy cập/ngày, Durable Object SQLite có trong gói miễn phí, dung lượng 5GB).

## Cách 1 – Bấm chuột trên trang Cloudflare (khuyên dùng)

Cloudflare tự lấy mã từ GitHub, tự build và tự cập nhật mỗi khi repo có bản mới.

1. Đăng nhập https://dash.cloudflare.com → menu trái **Compute (Workers) → Workers & Pages** → nút **Create**.
2. Chọn tab **Workers** → **Import a repository** (Nhập từ Git).
3. Bấm **Connect GitHub** (nếu được hỏi) → cho phép ứng dụng Cloudflare truy cập repo **`Xichlo1234/eduspace-mini`** (chọn *Only select repositories* → chọn repo này).
4. Chọn repo `eduspace-mini` → màn hình cấu hình:
   - **Project name:** `eduspace-mini` (phải trùng tên trong `wrangler.jsonc`)
   - **Build command:** để trống
   - **Deploy command:** `npx wrangler deploy` (mặc định)
   - Bấm **Create and deploy**.
5. Chờ 1–3 phút. Khi báo **Success**, bấm vào địa chỉ dạng `https://eduspace-mini.<ten-ban>.workers.dev`.
6. **Mở ngay và tạo tài khoản chủ trung tâm** (trang “Chào mừng!”). Lần đầu ai mở trang này trước sẽ tạo được tài khoản chủ, nên hãy làm ngay sau khi triển khai.

Từ đó, mỗi lần có bản cập nhật trên GitHub (nhánh `main`), Cloudflare tự triển khai lại; **dữ liệu giữ nguyên**.

## Cách 2 – Dùng dòng lệnh (trên máy đã cài Node.js)

Trong thư mục mã nguồn:

```bash
npm install
```
```bash
npx wrangler login
```
```bash
npx wrangler deploy
```

Lệnh cuối in ra địa chỉ `https://eduspace-mini.<ten-ban>.workers.dev`.

## Sau khi triển khai

- **Tên miền riêng (tuỳ chọn):** Worker `eduspace-mini` → **Settings → Domains & Routes → Add → Custom domain** → nhập ví dụ `quanly.tentrungtam.vn` (tên miền phải đang dùng Cloudflare DNS).
- **Thêm lớp bảo vệ (khuyên dùng):** Zero Trust → **Access → Applications → Add → Self-hosted**, nhập địa chỉ trên, chính sách *Allow* theo email của chủ, nhân viên, giáo viên (đăng nhập bằng mã gửi qua email; miễn phí đến 50 người).
- **Chuyển dữ liệu đang dùng trên máy lên Cloudflare:** trên bản đang chạy ở máy → *Cài đặt → Sao lưu → Tải bản sao lưu (.json)*; trên bản Cloudflare → tạo tài khoản chủ tạm → *Cài đặt → Sao lưu → Khôi phục từ file JSON* → đăng nhập lại bằng tài khoản cũ.
- **Sao lưu:** Cloudflare tự lưu lịch sử 30 ngày cho Durable Object. Ngoài ra nên vào *Cài đặt → Sao lưu → Tải bản sao lưu (.json)* **mỗi tuần** và cất lên Google Drive.
- **Xem lỗi khi cần:** Worker → **Observability / Logs**.

## Khác biệt nhỏ khi chạy trên Cloudflare

| Chức năng | Trên máy (Node) | Trên Cloudflare |
|---|---|---|
| Sao lưu | File `.db` + file JSON, tự sao lưu hằng ngày vào ổ đĩa | File JSON (tải về) + Cloudflare tự lưu 30 ngày |
| Logo | Lưu trong CSDL | Lưu trong CSDL |
| Mọi chức năng nghiệp vụ | Đầy đủ | Đầy đủ (cùng một mã nguồn) |

## Kiểm tra bản mới triển khai (tuỳ chọn, cho người kỹ thuật)

Trên một bản **mới, CSDL còn trống** (ví dụ chạy thử `npx wrangler dev`):

```bash
node scripts/smoke.js http://127.0.0.1:8787
```

Script chạy toàn bộ quy trình (tạo lớp, học sinh, đặt cọc, xếp lớp, điểm danh, lập học phí cuối kỳ, thu tiền, in phiếu, Excel, logo, sao lưu/khôi phục) và duyệt mọi trang. Không chạy script này vào hệ thống đang có dữ liệu thật.

## Phương án khác: chạy trên máy tại trung tâm + Cloudflare Tunnel

Nếu muốn dữ liệu nằm trên máy của trung tâm: chạy `scripts\chay-trung-tam.bat`, cài `cloudflared`, tạo Tunnel trong Zero Trust → *Networks → Tunnels*, trỏ Public hostname tới `http://localhost:3000`. Máy phải luôn bật.
