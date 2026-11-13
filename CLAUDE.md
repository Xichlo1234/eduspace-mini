# Eduspace Mini – hướng dẫn cho Claude

**Đọc `docs/HO-SO-DU-AN.md` trước tiên** – chứa yêu cầu, quyết định, kiến trúc, quy tắc tính tiền, bản đồ mã, lịch sử và cách chạy/kiểm thử/triển khai. Chỉ mở mã nguồn khi cần sửa chỗ cụ thể.

Tóm tắt nhanh:
- Ứng dụng quản lý trung tâm **tiếng Anh** nhỏ (1 cơ sở, < 200 HS), tiếng Việt, VND, dd/mm/yyyy, giờ Việt Nam. Người dùng là chủ trung tâm dùng Windows, không rành kỹ thuật – trả lời bằng tiếng Việt, hướng dẫn từng bước.
- Node ≥ 22.13 + Express 5 + EJS + SQLite. Cùng mã chạy trên máy (`node:sqlite`, `src/server.js`) và trên **Cloudflare Workers + Durable Object SQLite** (`cf/worker.js`, `wrangler.jsonc`) – đích triển khai chính là Cloudflare.
- Nghiệp vụ & kiểm tra quyền nằm trong `src/services/`; routes mỏng trong `src/routes/`.
- Lớp mới mặc định **thu học phí cuối kỳ**; mọi thao tác tiền có xem trước, chống bấm trùng (idempotency key), không xóa giao dịch (chỉ hủy có lý do).

Quy tắc khi sửa:
- Chạy `npm test` (phải đạt hết; hiện 28). Nếu đụng tới giao diện hoặc phần Cloudflare: `npx wrangler dev` rồi `node scripts/smoke.js http://127.0.0.1:8787` trên CSDL trống.
- Không dùng `__dirname`, `new Function`, ghi file đĩa, hay thư viện native trong đường chạy chung (Cloudflare không hỗ trợ).
- Thay đổi CSDL: sửa `src/schema.sql` **và** thêm bước nâng cấp an toàn trong `migrate()` (`src/db.js`); thêm bảng mới vào `TABLES` trong `src/services/backup.js`.
- Không đổi tên class Durable Object `EduspaceApp` hay migration `v1` trong `wrangler.jsonc`.
- Sau mỗi thay đổi: cập nhật `docs/HO-SO-DU-AN.md` (mục liên quan + nhật ký), commit và `git push origin main`.
