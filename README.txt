E39 - BAN GITHUB + VERCEL / CLOUDFLARE TURNSTILE

1. Giai nen ZIP, upload TAT CA file vao thu muc goc GitHub: index.html, background.jpg, config.js, thu muc api/verify.js.
2. Mo config.js, thay DAN_SITE_KEY_CUA_BAN_VAO_DAY bang SITE KEY cong khai cua widget Turnstile (khong co https://, khong phai Secret Key). Sau do Commit changes.
3. Cloudflare Turnstile > Widget > Hostnames: cho phep pagecode-beta.vercel.app (khong co https:// hay /).
4. Vi Secret Key cu da lo trong anh, Rotate Secret Key trong Cloudflare. KHONG dan Secret Key vao GitHub/chat.
5. Vercel > Project > Settings > Environment Variables > Add: ten TURNSTILE_SECRET_KEY; value la Secret Key MOI; chon Production. Save, sau do Redeploy.
6. Mo https://pagecode-beta.vercel.app/ de kiem tra. Neu thay 'Sitekey khong hop le', kiem tra lai config.js va hostname cua deployment hien tai.

CHUC NANG:
- Hien Turnstile that tren trang E39; API /api/verify xac minh token o may chu qua Cloudflare Siteverify.
- Khong xac nhan code hay thuong khi chua co API/database ma code.
- Khong nhung Secret Key vao HTML, config.js hay GitHub.

LUU Y: Ban ZIP nay KHONG the duoc cau hinh hoan toan cho widget cua ban neu ban chua dien Site Key chinh xac. Chi can thay mot dong trong config.js.
