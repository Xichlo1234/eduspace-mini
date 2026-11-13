# Phân tích nghiệp vụ – Eduspace Mini

Tài liệu này mô tả quy trình đã giản lược từ “Eduspace – Quản lý đào tạo”, các màn hình, mô hình dữ liệu và **các chính sách học phí đang giả định**. Phiên bản này nhắm tới trung tâm có một cơ sở, dưới 200 học sinh, do một người vận hành phần lớn công việc.

## 1. Quy trình đã giản lược

| Eduspace (đầy đủ) | Eduspace Mini |
|---|---|
| Nhiều chi nhánh, lễ tân, bảo vệ, phân ca | Một cơ sở, ba vai trò: chủ, nhân viên vận hành, giáo viên |
| CRM tuyển sinh, tư vấn nhiều bước | Thêm hồ sơ → xếp lớp ngay **hoặc** đưa vào danh sách chờ (có thể nhận đặt cọc) |
| Kế toán, thuế, bảo hiểm, lương | Sổ thu chi đơn giản + tiền dạy theo buổi đã xác nhận |
| Tài khoản phụ huynh/học sinh, app riêng | Web chạy tốt trên điện thoại; liên lạc phụ huynh bằng mẫu tin, sao chép gửi qua Zalo |

Luồng chính hằng ngày:

```
Thiết lập (trung tâm, môn, GV, ngày nghỉ) → Tạo lớp + lịch lặp → hệ thống sinh buổi học
→ Thêm học sinh (từng em hoặc Excel) → Xếp lớp (bảng tính học phí, trừ đặt cọc) → Thu tiền (phiếu thu)
→ Điểm danh từng buổi (xác nhận đã dạy) → Tạo học phí kỳ sau hàng loạt → Thu nợ → Xem công nợ, báo cáo
```

Nghiệp vụ phát sinh: đổi lịch / hủy buổi / dạy thay, chuyển lớp, bảo lưu → quay lại, nghỉ học, miễn giảm, hủy phiếu, hoàn tiền trả trước, chi tiền dạy.

## 2. Vai trò & quyền (kiểm tra ở backend)

| Chức năng | Chủ | Nhân viên | Giáo viên |
|---|---|---|---|
| Học sinh, lớp, lịch, điểm danh, thu học phí, liên lạc | ✔ | ✔ | Chỉ lớp được phân công / buổi dạy thay: điểm danh, điểm, nhận xét |
| Chi tiền (thu chi) | ✔ | Khi được cấp quyền | ✘ |
| Miễn giảm, hủy/điều chỉnh giao dịch | ✔ | Khi được cấp quyền | ✘ |
| Báo cáo tài chính | ✔ | Khi được cấp quyền | ✘ |
| Xác nhận chi tiền dạy | ✔ | ✘ | Chỉ xem tiền dạy của mình |
| Cài đặt, tài khoản, sao lưu/khôi phục | ✔ | Phòng học, ngày nghỉ | ✘ |

Chủ trung tâm tự làm được mọi quy trình mà không cần tạo tài khoản nhân viên. Không có mật khẩu mặc định: chủ tự tạo tài khoản ở lần chạy đầu; tài khoản do chủ tạo phải đổi mật khẩu khi đăng nhập lần đầu.

## 3. Màn hình

1. **Tổng quan** – lớp hôm nay (nút điểm danh), buổi chưa hoàn tất điểm danh, học phí đến hạn/quá hạn, vắng nhiều, chờ xếp lớp, sắp hết gói, sắp hết bảo lưu, thực thu/thực chi tháng; danh sách “Bắt đầu nhanh” khi mới cài.
2. **Học sinh** – tìm kiếm/lọc, thêm (cảnh báo trùng hồ sơ), nhập Excel (file mẫu → xem trước lỗi/cảnh báo → lưu), xuất Excel, danh sách chờ.
   **Hồ sơ học sinh** – liên hệ, anh chị em chung SĐT, lớp (trạng thái theo từng đăng ký), chuyên cần + điểm + nhận xét, học phí, phiếu thu, sổ tiền trả trước, lịch sử liên lạc, lịch sử thay đổi; nút nhanh: Xếp lớp, Thu tiền, Chuyển lớp, Bảo lưu, Nhắn phụ huynh.
   Màn hình có bảng tính xác nhận: Xếp lớp, Chuyển lớp, Bảo lưu, Quay lại sau bảo lưu, Nghỉ học.
3. **Lớp học & lịch học** – danh sách lớp, tạo/sửa lớp (giải thích cách tính học phí theo hình thức), đổi lịch lặp từ ngày áp dụng, chi tiết lớp (học sinh, buổi học, thêm buổi bổ sung), lịch tuần, trang buổi học (điểm danh, đổi giờ/GV/phòng, hủy buổi).
4. **Học phí & thu chi** – công nợ (còn nợ/quá hạn/đã đủ), khoản phải thu (diễn giải cách tính, lịch sử điều chỉnh, phân bổ), thu tiền, phiếu thu (in/lưu PDF khổ A5), tạo học phí hàng loạt (xem trước + ngoại lệ), sổ thu chi.
5. **Giáo viên** – danh sách, hồ sơ (lịch dạy, buổi đã dạy), tiền dạy theo tháng + xác nhận chi.
6. **Báo cáo** – thực thu, thực chi, chênh lệch thu–chi tiền, công nợ, trả trước, bảo lưu, theo lớp, chuyên cần; xuất Excel.
7. **Cài đặt** – thông tin trung tâm & logo, chính sách, mẫu phiếu thu, mẫu tin nhắn, phòng học, ngày nghỉ, tài khoản, sao lưu/khôi phục, nhật ký thao tác.

## 4. Mô hình dữ liệu (SQLite – `src/schema.sql`)

```
students ─┬─< enrollments >── classes ──< class_schedules (lịch lặp có hiệu lực theo ngày)
          │        │               └──< class_sessions (buổi học; GV thực tế; origin = khung lịch gốc)
          │        ├──< attendance >── class_sessions
          │        ├──< enrollment_events (lịch sử trạng thái)
          │        └──< reservations (bảo lưu)
          ├──< invoices (khoản phải thu) ──< invoice_adjustments (miễn giảm/điều chỉnh có lý do)
          │        └──< allocations (phân bổ tiền vào khoản: từ phiếu thu hoặc từ trả trước; âm = rút ra)
          ├──< receipts (phiếu thu – mỗi lần nhận tiền một phiếu)
          ├──< credit_entries (sổ tiền trả trước; reservation_id ≠ NULL = tiền giữ cho bảo lưu)
          └──< contact_logs (đã liên hệ phụ huynh)
cash_transactions (thu khác, chi, tiền dạy, hoàn tiền) · teachers · subjects · rooms · holidays
users · auth_sessions · audit_logs · settings · counters (mã tự sinh) · import_batches
```

Nguyên tắc tiền: **mỗi đồng đã thu nằm đúng một chỗ** – đã phân bổ vào một khoản phải thu, hoặc trong sổ trả trước (tự do / giữ cho bảo lưu), hoặc đã hoàn. Kiểm thử tự động kiểm tra bất biến `tổng phiếu thu = tổng phân bổ + số dư trả trước + đã hoàn` sau mỗi kịch bản.

Ràng buộc chống trùng ở CSDL:
- `ux_invoice_period`: một đăng ký (học sinh + lớp) chỉ có một khoản phải thu còn hiệu lực cho mỗi kỳ.
- `receipts.idempotency_key`, `cash_transactions.idempotency_key`, `invoices.idempotency_key`: mỗi form mang một mã một lần; bấm nhiều lần chỉ ghi một giao dịch.
- `ux_teacher_payout`: mỗi giáo viên mỗi tháng một giao dịch chi tiền dạy còn hiệu lực.
- `ux_sess_origin`: không sinh lại buổi học từ cùng một khung lịch (kể cả buổi đã hủy hoặc đã dời).

Giao dịch tài chính không bị xóa: hủy phiếu/khoản/giao dịch chỉ đổi trạng thái + lưu người, thời điểm, lý do; mọi thao tác tiền, chuyển lớp, bảo lưu ghi `audit_logs`.

## 5. Chính sách học phí đang giả định (đều cấu hình được)

| Chủ đề | Mặc định | Cấu hình ở |
|---|---|---|
| Hình thức | Mỗi lớp một hình thức: tháng / khóa / gói buổi. Không đổi hình thức khi lớp đã phát sinh học phí | Lớp |
| Thời điểm thu | **Thu cuối kỳ (trả sau)** mặc định cho lớp mới; có thể chọn thu đầu kỳ. Không đổi khi lớp đã phát sinh học phí | Lớp, Cài đặt |
| Thu cuối kỳ – tháng | Xếp lớp chưa lập khoản; cuối tháng lập học phí tháng đã học (cùng công thức tỷ lệ), hạn ngày 5 tháng sau | Cài đặt |
| Thu cuối kỳ – theo buổi | Học phí tháng = số buổi thực học (đã điểm danh, tính vắng theo cấu hình) × đơn giá | Lớp |
| Thu cuối kỳ – khóa | Lập học phí khi buổi cuối khóa đã qua; hạn = sau buổi cuối + 7 ngày | Cài đặt |
| Thu cuối kỳ – chuyển/bảo lưu/nghỉ/hoàn thành | Tự lập học phí phần đã học chưa lập, trừ tiền trả trước; lớp mới chưa lập khoản | (cố định) |
| Khoản thu khác | Sách, đồng phục, khác: thu khi nhận, hạn đóng nhập khi tạo khoản | Hồ sơ học sinh |
| Theo tháng | Học đủ tháng = mức phí tháng. Nhập học/kết thúc giữa tháng: **phí × số buổi trong thời gian đăng ký ÷ tổng buổi hợp lệ của tháng** (bật mặc định) | Lớp |
| Theo khóa | Phí gắn với tổng số buổi. Nhập học muộn: phí × buổi còn lại ÷ tổng buổi. Nghỉ lễ/hủy buổi được **bù cuối khóa** để đủ số buổi | Lớp |
| Theo gói | Gói = số buổi × đơn giá. Theo dõi mua / đã dùng / còn lại; cảnh báo khi còn ≤ 2 buổi | Lớp, Cài đặt |
| Buổi trung tâm hủy | Không tính phí, không tính là buổi đã học | (cố định) |
| Học sinh vắng | Lớp tháng/khóa: vắng có phép **và** không phép vẫn tính phí. Lớp gói: vắng có phép **không trừ buổi**, vắng không phép trừ buổi. Lớp tháng nếu bỏ chọn “vắng … vẫn tính phí”: giá trị buổi vắng được trừ vào học phí tháng sau | Lớp (2 ô chọn) |
| Làm tròn | Học phí tính theo tỷ lệ làm tròn đến 1.000đ | Cài đặt |
| Hạn đóng | Học phí tháng: ngày 10 của tháng (không sớm hơn 7 ngày sau ngày tạo); khoản khác: 7 ngày sau ngày tạo | Cài đặt |
| Chuyển lớp / bảo lưu / nghỉ | Lớp cũ chỉ tính nghĩa vụ đã phát sinh đến trước ngày hiệu lực. Phần **đã đóng** vượt nghĩa vụ mới được chuyển (ưu tiên bù nợ cũ); phần chưa đóng của buổi chưa học được giảm khỏi khoản phải thu | (cố định) |
| Bảo lưu | Không phát sinh học phí mới; giá trị bảo lưu giữ riêng, chỉ dùng khi quay lại | (cố định) |
| Nghỉ học | Mặc định tính lại theo phần đã học (dư vào trả trước, hoàn khi chủ xác nhận phiếu chi); có thể chọn “giữ nguyên học phí” | Mỗi lần thao tác |
| Đặt cọc | Vào sổ trả trước, tự trừ khi xếp lớp / tạo khoản mới; mỗi đồng dùng một lần | (cố định) |
| Thu vượt | Bị chặn trừ khi chọn “phần dư thành tiền trả trước” | Mỗi lần thu |
| Tiền dạy | Chỉ buổi **đã xác nhận hoàn thành**, theo GV thực tế đứng lớp; đơn giá = đơn giá riêng của lớp hoặc của GV, chốt tại lúc xác nhận | Lớp, Giáo viên |

### Câu hỏi cần chủ trung tâm xác nhận (ảnh hưởng cách tính tiền)

Hệ thống đã có mặc định hợp lý cho từng mục và cho phép đổi, nhưng nên xác nhận:
1. Lớp tháng: học sinh vắng **có phép** có được trừ tiền tháng sau không? (mặc định: không trừ)
2. Lớp gói: vắng **không phép** có trừ buổi không? (mặc định: có trừ)
3. Nhập học giữa tháng: tính theo tỷ lệ hay thu đủ tháng? (mặc định: theo tỷ lệ)
4. Nghỉ học giữa kỳ: có hoàn phần học phí chưa dùng không? (mặc định: tính lại, phần dư giữ ở trả trước, chỉ hoàn khi chủ lập phiếu chi)
5. Làm tròn học phí lẻ: 1.000đ hay 10.000đ? (mặc định 1.000đ)

## 6. Kết quả kiểm thử nghiệm thu

Chạy `npm test` (22 kiểm thử, đều đạt – gồm 5 kiểm thử thu cuối kỳ trong `test/postpaid.test.js`). Ánh xạ với yêu cầu:

| Tình huống | Kiểm thử |
|---|---|
| Một học sinh học hai lớp không trùng hồ sơ | `acceptance` – “Một học sinh học hai lớp…” |
| Hai anh chị em chung SĐT phụ huynh | cùng kiểm thử trên (+ nhập Excel cảnh báo anh chị em nhưng vẫn tạo hồ sơ riêng) |
| 800.000đ/tháng, 8 buổi, nhập học 4 buổi cuối → 400.000đ; đóng 300.000đ còn nợ 100.000đ | “Học phí tháng tính theo tỷ lệ…” |
| Thu tiếp 100.000đ → công nợ 0, giữ đủ 2 phiếu thu, không tạo thêm học phí | cùng kiểm thử trên |
| Đặt cọc dùng một lần khi xếp lớp | “Tiền đặt cọc chỉ được dùng một lần…” (xem trước không ghi gì; lớp thứ hai chỉ dùng phần còn dư) |
| Ngày lễ không tạo buổi; lớp khóa đủ số buổi | “Ngày lễ không tạo buổi học…” (kể cả thêm ngày nghỉ sau khi đã sinh lịch, hủy buổi) |
| Chuyển lớp giữ lịch sử, không tính trùng tiền | “Chuyển lớp: giữ lịch sử…” |
| Bảo lưu giữ lịch sử, không tính trùng tiền | “Bảo lưu và quay lại…” |
| Giáo viên dạy thay tính đúng số buổi thực tế | “Giáo viên dạy thay…” (buổi chỉ lên lịch không được tính, chi tiền một lần) |
| Giáo viên không truy cập báo cáo thu chi | `http` – “Giáo viên không truy cập được báo cáo…” (11 đường dẫn trả 403) |
| Bấm xác nhận thu tiền hai lần không sinh hai giao dịch | `acceptance` + `http` (hai POST đồng thời → 1 phiếu) |
| Bổ sung | đổi lịch không sửa buổi đã hoàn thành; phát hiện trùng GV/phòng; miễn giảm có lý do; hủy phiếu giữ dấu vết; chính sách vắng; CSRF; duyệt toàn bộ trang không lỗi |

## 7. Phạm vi môn học

Trung tâm chỉ dạy **tiếng Anh**. Ứng dụng không có màn hình quản lý môn học: mọi lớp tự gắn môn "Tiếng Anh", chương trình (Starters, Movers, Flyers, giao tiếp, IELTS, kèm 1-1…) phân biệt bằng tên lớp. Khi nâng cấp từ phiên bản trước, các môn khác (nếu có) được gom về "Tiếng Anh"; lớp, học sinh và lịch sử thu tiền giữ nguyên.
