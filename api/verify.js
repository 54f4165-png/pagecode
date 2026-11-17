// Vercel Serverless Function: xác minh token Cloudflare Turnstile phía máy chủ.
// Secret Key chỉ được đặt trong Vercel Environment Variables.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({valid:false,reason:'method_not_allowed'}); }
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return res.status(503).json({valid:false,reason:'service_unavailable',note:'Máy chủ chưa cấu hình Turnstile Secret Key.'});
  const { account, code, turnstileToken } = req.body || {};
  if (typeof account !== 'string' || typeof code !== 'string' || !account.trim() || !code.trim() || account.length > 100 || code.length > 150 || typeof turnstileToken !== 'string' || !turnstileToken || turnstileToken.length > 4096) {
    return res.status(400).json({valid:false,reason:'invalid_request',note:'Vui lòng nhập đầy đủ thông tin và xác minh.'});
  }
  try {
    const params = new URLSearchParams({ secret, response: turnstileToken });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString(),signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('turnstile_upstream');
    const check = await response.json();
    if (check.success !== true) return res.status(200).json({valid:false,reason:'verification_failed',note:'Xác minh Cloudflare thất bại hoặc đã hết hạn. Vui lòng thử lại.'});
    // Không có dữ liệu tài khoản/code: không thể xác nhận thưởng hoặc báo code sai.
    return res.status(200).json({valid:false,reason:'code_service_not_configured',note:'Đã xác minh Cloudflare thành công. Chưa kết nối cơ sở dữ liệu kiểm tra mã code.'});
  } catch (e) {
    return res.status(503).json({valid:false,reason:'service_unavailable',note:'Dịch vụ xác minh đang gián đoạn. Vui lòng thử lại.'});
  }
};
