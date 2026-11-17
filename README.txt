E39 - CLOUDFLARE TURNSTILE THẬT (GitHub + Vercel)

1. Giải nén và upload toàn bộ file/folder vào thư mục gốc GitHub (bao gồm api/verify.js và config.js).
2. Mở config.js, thay DAN_SITE_KEY_CUA_BAN_VAO_DAY bằng Site Key công khai của widget Turnstile đã tạo cho pagecode-beta.vercel.app.
3. Trên Vercel > Project > Settings > Environment Variables: tạo TURNSTILE_SECRET_KEY với Secret Key MỚI sau khi Rotate khóa bị lộ trong ảnh. Chọn Production (và Preview nếu hostname preview được phép).
4. Redeploy website để biến môi trường có hiệu lực.
5. Cloudflare > Turnstile: xác nhận hostname pagecode-beta.vercel.app đã được thêm.
6. Test: mở trang, widget phải hiện; hoàn thành xác minh rồi nhấn KIỂM TRA NGAY. Máy chủ sẽ gọi Cloudflare Siteverify thực tế.

CHÚ Ý: Website chưa có API/cơ sở dữ liệu kiểm tra tài khoản, code và thưởng. Sau khi xác minh Cloudflare thành công, trang sẽ báo chưa kết nối cơ sở dữ liệu code; KHÔNG tự tuyên bố đã nhận thưởng.
KHÔNG đưa Secret Key vào GitHub hoặc gửi ảnh chứa khóa.
