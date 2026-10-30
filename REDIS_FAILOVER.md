# Redis chính và dự phòng

MangaHub dùng **Aiven Valkey làm chính**, **Upstash làm dự phòng cho cache công khai**.
Không đổi lịch cron Vercel và không cần một dịch vụ ping bên ngoài.

## Thiết lập trên Vercel backend

1. Tạo Aiven **Valkey / Free**, chờ trạng thái Running.
2. Giữ lại URL Redis TLS của Upstash hiện tại (không dùng REST URL/token).
3. Vercel → dự án backend → Settings → Environment Variables:

   | Biến | Giá trị |
   | --- | --- |
   | `REDIS_URL` | Service URI Aiven, bắt đầu bằng `valkeys://` hoặc `rediss://` |
   | `REDIS_FALLBACK_URL` | URL Redis Upstash cũ, bắt đầu bằng `rediss://` |
   | `REDIS_SECURITY_URL` | Để không thiết lập; mặc định dùng `REDIS_URL` |
   | `SECURITY_REQUIRE_REDIS` | `true` |

4. Redeploy bản mới nhất của `main` với env Production mới. Nếu deployment chỉ
   có nhãn Ready/Staged/Preview, dùng Promote hoặc Promote to Production để có
   nhãn **Current**. Không redeploy lại commit rollback `398d15a` vì bản đó chưa
   có dự phòng. Header `X-MangaHub-Revision` của `/health` và `/auth/health` phải
   là commit mới đang chọn. Hai URL phải trỏ tới hai Redis khác nhau. Đặt cùng cấu hình
   cho tất cả backend phục vụ API và auth. Dùng database khác cho preview/test.
5. Đăng nhập lại một lần sau khi chuyển. Backend khởi tạo mốc chuyển đổi chung
   trong Aiven; phiên đăng nhập trước mốc này không được dùng lại, kể cả refresh.

Chỉ lưu URL có mật khẩu trong env backend. Không thêm vào biến `VITE_*`, mã JS
frontend, Cloudflare Worker hoặc Git. Không tắt kiểm tra chứng chỉ TLS.

## Tốc độ và quota

- Bình thường: một lượt đọc Redis cho `get`, một lượt MGET cho cả nhóm; Upstash
  không nhận lệnh nào, kể cả lúc một Vercel function khởi động lần đầu.
- Các pool được dùng lại giữa cache, xác thực và chống spam. Không PING trước
  mỗi lệnh. Bộ đếm API tăng và đặt hạn trong cùng một lệnh Lua.
- Mặc định thời gian chờ kết nối là 0,35 giây, đọc socket là 0,5 giây. Không có
  retry/backoff tự động. DNS, TLS và các bước kết nối vẫn cần thời gian thực;
  đây không phải cam kết toàn bộ request luôn hoàn tất trong 0,5 giây.
- Khi phát hiện lỗi kết nối/timeout/quota: thử cache dự phòng trong cùng lần
  xử lý. Các request sau của function đó bỏ qua Redis chính đang lỗi.
- Upstash chỉ tốn quota lúc phục vụ dự phòng và kiểm tra phục hồi. Không ghi
  hai bản sao cache liên tục. Lần đầu chuyển có thể thiếu cache và cần tải nguồn.
- Nếu cả hai cache lỗi, cache công khai có thể dùng bộ nhớ cục bộ có giới hạn.
  Đây không phải bộ nhớ dự phòng cho phiên đăng nhập hoặc bảo mật.

## Kiểm tra phục hồi

Sau khi gửi xong response, backend có thể chạy một kiểm tra hữu hạn; Vercel
giữ tác vụ này tới khi xong trong invocation hiện tại. Không tạo vòng lặp chạy
liên tục. Mặc định tối đa một lần mỗi 60 giây, dùng lease trên Upstash để nhiều
function không đồng loạt kiểm tra. Không có truy cập thì không có probe; lần
truy cập tiếp theo vẫn đọc từ dự phòng và kiểm tra sau response.

Probe phải SET + GET thành công, không chỉ PING. Khi phục hồi, xóa riêng
namespace cache công khai cũ, làm ấm tối đa 400 mục chưa hết hạn từ dự phòng,
rồi mới chuyển function đó về Redis chính. Function khác nhận trạng thái chung
ở lần kiểm tra tiếp theo; cache công khai có thể nhất quán dần theo TTL, không
phải một giao dịch chuyển đổi toàn hệ thống. Namespace mới cho mỗi đợt lỗi tránh
lấy lại cache của đợt lỗi trước. Không xóa khóa xác thực hoặc chạy FLUSHDB.
Nếu Upstash cũng hết quota, probe vẫn có thể khôi phục Aiven rồi sửa lại trạng
thái chung khi Upstash hoạt động lại; lượt sửa trạng thái không xóa cache Aiven.

Có thể chỉnh `REDIS_RECOVERY_CHECK_SECONDS` (tối thiểu 30),
`REDIS_CONNECT_TIMEOUT_SECONDS`, `REDIS_SOCKET_TIMEOUT_SECONDS` (0,05–2 giây).
Thời gian quá ngắn so với vùng Aiven thực tế có thể gây chuyển nhầm dự phòng;
hãy đo độ trễ trước khi giảm mặc định.

## Ranh giới xác thực

Nonce dùng một lần, thu hồi phiên, khóa refresh và bộ đếm chống spam luôn dùng
**Aiven làm nơi lưu thống nhất**. Nếu Aiven lỗi thì xác thực báo không khả dụng;
không chuyển sang một Redis trống và không bỏ kiểm tra quyền. Người đọc nội dung
công khai có thể dùng cache dự phòng; trang cần đăng nhập/whitelist vẫn phụ thuộc
Redis xác thực. Dự phòng cache không bảo đảm đăng nhập hoạt động khi Aiven lỗi.

Không thay đổi hoặc xóa env chỉ để chuyển qua lại nơi lưu xác thực; chuyển
security store là một lần di chuyển cần đăng nhập lại. Hệ thống này không sao chép
dữ liệu ứng dụng, phiên, queue Celery hay toàn bộ Redis giữa hai nhà cung cấp.

## Kiểm thử

Từ thư mục `backend`, cài `requirements-test.txt` để có fakeredis hỗ trợ Lua,
rồi chạy `python -m pytest tests/test_redis_failover.py tests/test_security_redis.py
tests/test_auth_security_store_outage.py tests/test_runtime_cache.py -q`.

Bộ kiểm thử có Redis giả chạy Lua, Flask-Limiter thật, server TCP cục bộ cố ý
không trả lời, chuyển qua lại, giữ TTL, kiểm tra quota, lease nhiều worker,
không phát lại nonce, và xác minh probe bắt đầu sau response. Chưa có URL Aiven
thì chưa thể kiểm chứng độ trễ vùng mạng hay failover trên deployment thực tế.
