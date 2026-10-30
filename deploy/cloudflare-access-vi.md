# Khóa MangaHub bằng Cloudflare Access

Trạng thái: mã hỗ trợ đã được chuẩn bị; chưa đủ bằng chứng website đã cách ly.
Chỉ bật khóa khi cấu hình dashboard và kiểm tra đăng nhập hợp lệ đã hoàn tất.
Access chặn nội dung đang phục vụ, không xóa dữ liệu từng được tải hoặc lưu bên ngoài.

## A. Tạo cửa đăng nhập trên Cloudflare

1. Vào Cloudflare → chọn tài khoản quản lý `mangahub.art`.
2. Chọn domain → DNS → Records. Giữ nguyên đích IP/CNAME, bật đám mây cam
   **Proxied** cho `@`, `www` nếu dùng, `api`, `auth`.
3. Vào Zero Trust. Nếu dashboard yêu cầu chọn gói, chọn gói phù hợp; kiểm tra
   tổng thanh toán trước khi xác nhận.
4. Đi thẳng **Access controls → Applications → Add an application**.
   Chọn **Self-hosted / Self-hosted and private**, rồi **Add public hostname**.
   Không dùng trình hướng dẫn yêu cầu Assign a Tunnel/Deploy your Tunnel cho
   website hiện đang chạy trên Vercel.
5. Điền:

   | Ô | Giá trị |
   |---|---|
   | Application name | `Private Portal` |
   | Session duration | `8 hours` |
   | Subdomain | Để trống |
   | Domain | `mangahub.art` |
   | Path | Để trống |

   Nếu dùng www, thêm hostname với Subdomain `www`, Domain `mangahub.art`,
   Path để trống. Chưa thêm API/auth trong lượt đầu vì Worker cần cấu hình bên dưới.
6. Tạo policy: Name `Private members`, Action **Allow**, Include **Emails**,
   nhập từng email đầy đủ được phép truy cập. Không dùng Everyone, Bypass hoặc
   cho phép toàn bộ `@gmail.com`.
7. Nếu chưa có OTP: vào **Integrations → Identity providers → Add new identity
   provider → One-time PIN → Save**. Sau đó chọn One-time PIN trong Login methods
   của ứng dụng, rồi lưu ứng dụng.
8. Dùng profile chưa đăng nhập để kiểm tra `/`, `/manga`, `/login` đều bị giữ
   trước nội dung website. Dùng trình duyệt thông thường nhập email đã cho phép,
   lấy OTP qua email và thử vào website. Giữ tab dashboard Cloudflare mở.
9. Ghi lại **Team domain** trong Settings, dạng `ten-nhom.cloudflareaccess.com`;
   và **Application Audience (AUD) Tag** trong chi tiết/cấu hình ứng dụng.
   Có thể cung cấp hai giá trị này để cấu hình mã. Không gửi OTP/token/cookie.

## B. Chuẩn bị các kết nối nội bộ

Phần này bắt buộc trước khi khóa API và Worker. Chỉ khóa frontend thì vẫn còn
đường vào trực tiếp tới API/hosting.

1. Tạo **Service Token** trong Access → Service credentials → Service tokens.
   Tên menu có thể khác tùy giao diện. Lưu Client ID và Client Secret riêng tư.
2. Thêm policy **Service Auth** cho đúng token này trong ứng dụng Access.
3. Đặt hai giá trị dưới đây ở backend và **Worker Secrets**, không ở frontend:

   ```dotenv
   CF_ACCESS_CLIENT_ID=<Client ID thực tế>
   CF_ACCESS_CLIENT_SECRET=<Client Secret thực tế>
   ```

4. Deploy Worker bằng Wrangler từ thư mục `cloudflare/`:

   ```text
   npx wrangler login
   npx wrangler deploy --config wrangler.toml
   ```

   Bản mới có module `access-gate.js`; không chỉ dán riêng file Worker cũ.
5. Trong frontend Vercel, đặt rồi build/deploy lại:

   ```dotenv
   VITE_TRUYENQQ_EDGE_URL=https://mangahub.art/api/truyenqq-edge
   VITE_MANGADEX_EDGE_URL=https://mangahub.art/api/mangadex-edge
   ```

   Trong backend đặt `TRUYENQQ_EDGE_URL=https://mangahub.art/api/truyenqq-edge`.
   Kiểm tra route Worker cho cả hai prefix đã được cài và QQ/MDX vẫn hoạt động.

## C. Khóa API, auth và đường vào hosting

1. Thêm `api.mangahub.art`, `auth.mangahub.art` vào cùng ứng dụng Access,
   Path để trống. Trong Advanced settings → Cookie settings bật
   **Eager redirect cookie** và HttpOnly.
2. Cấu hình Access tự trả lời CORS preflight với origin `https://mangahub.art`,
   allow credentials, các method/header ứng dụng dùng. Không tạo Bypass cho cả
   API. Không chọn Bypass OPTIONS to origin vì origin gate từ chối OPTIONS chưa xác thực.
3. Đặt biến **server-side** ở frontend Vercel, backend và Worker:

   ```dotenv
   CF_ACCESS_REQUIRED=true
   CF_ACCESS_TEAM_DOMAIN=<Team domain thực tế>
   CF_ACCESS_AUD=<AUD thực tế>
   ```

   Không đặt tiền tố `VITE_` cho ba biến này. Bật required mà thiếu/sai cấu hình
   sẽ đóng truy cập, không tự mở công khai.
4. Backend hosting phải chạy entrypoint **`app:app`** để bảo vệ cả API và Flask
   đăng nhập. Không chạy `fastapi_app.main:app` hoặc Flask riêng rồi cho rằng đã được khóa.
5. Cấu hình health check/job định kỳ với xác thực thích hợp trước khi bật:
   cron Vercel mặc định không tự lấy JWT Access. Lịch bảo trì phải gọi qua
   Cloudflare với Service Token và `Authorization: Bearer <CRON_SECRET>`.
6. Sau khi đổi tất cả caller sang route bảo vệ, tắt workers.dev và preview URL
   trong dashboard/config Worker. Cấu hình `workers_dev=false`, `preview_urls=false`.
7. Kiểm tra và bảo vệ các URL deployment Vercel cũ, alias, `.onrender.com`, IP
   hosting và domain cũ. Bản cập nhật không thay mã của deployment cũ bất biến.
8. Kiểm tra bucket Supabase/repository công khai riêng nếu có. Access ở domain
   MangaHub không khóa tài nguyên công khai trên nhà cung cấp khác.

## D. Kiểm tra trước khi kết luận hoàn tất

Không có cookie/JWT phải không nhận được HTML, bundle JS, ảnh riêng hay JSON
ứng dụng. Kiểm tra cả domain chính, API/auth, Worker và đường hosting trực tiếp:

- `/`, `/manga`, một `/assets/<tên-file-thực>.js`, favicon, ảnh OG, robots/sitemap.
- `/health`, `/auth/health`, `/api/site-access`, detail, image/chapter endpoint.
- Thử header email/CF-Ray/Host giả: vẫn bị từ chối.
- Thử một profile đã được cho phép: OTP, đăng nhập, danh sách, ảnh/chương phải hoạt động.
- Thử Service Token cho các job/kết nối nội bộ; không ghi secret vào log.

Không dùng file không tồn tại để chứng minh đã chặn asset thật. Lỗi mạng/503
tạm thời cũng không chứng minh website đã được bảo vệ.

Các chi tiết kỹ thuật và nguồn tài liệu chính thức: [cloudflare-access.md](cloudflare-access.md).
