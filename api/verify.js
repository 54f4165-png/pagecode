// User-side code verification backed by Firebase Realtime Database.
// Firebase service-account credentials and Turnstile secret remain server-side.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({valid:false,reason:'method_not_allowed'});
  const {account, code, turnstileToken} = req.body || {};
  if (typeof account !== 'string' || !account.trim() || account.length > 100 ||
      typeof code !== 'string' || !code.trim() || code.length > 150 ||
      typeof turnstileToken !== 'string' || !turnstileToken || turnstileToken.length > 4096)
    return res.status(400).json({valid:false,reason:'invalid_request'});
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) { console.error('USER VERIFY: missing TURNSTILE_SECRET_KEY'); return res.status(503).json({valid:false,reason:'turnstile_not_configured'}); }
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({secret,response:turnstileToken}).toString(),
      signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw Error('turnstile_upstream');
    const verified = await response.json();
    if (verified.success !== true) return res.status(200).json({valid:false,reason:'verification_failed'});
    const {db} = require('./_firebase');
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z]{6}$/.test(normalized)) return res.status(200).json({valid:false,reason:'invalid_code'});
    // Bonus codes are separate from deposit requirements and regular generated codes.
    const bonusSnap = await db.ref('bonusCodes').child(normalized).once('value');
    if (bonusSnap.exists()) {
      const bonus = bonusSnap.val();
      const amount = Number(bonus && typeof bonus === 'object' ? bonus.amount : bonus);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000)
        return res.status(200).json({valid:false,reason:'invalid_code'});
      return res.status(200).json({valid:true,type:'bonus',amount,currency:'VND'});
    }
    const depositSnap = await db.ref('depositCodes').child(normalized).once('value');
    if (depositSnap.exists()) {
      const entry = depositSnap.val();
      const amount = Number(entry && typeof entry === 'object' ? entry.amount : entry);
      if (!Number.isFinite(amount) || amount < 0) return res.status(200).json({valid:false,reason:'invalid_code'});
      // This database holds requirements only, not actual user balances.
      return res.status(200).json({valid:false,reason:'deposit_required',amount,currency:'VND'});
    }
    const snap = await db.ref('codes').once('value');
    const entries = snap.val() || {};
    const matched = Object.entries(entries).find(([id,item]) => {
      const value = item && typeof item === 'object' ? item.value : item;
      const stored = String(value || id).trim().toUpperCase();
      return stored === normalized;
    });
    if (!matched) return res.status(200).json({valid:false,reason:'invalid_code'});
    // Any code displayed in ADMIN's 100 CODE list belongs to this category,
    // including previously generated entries marked expired/used.
    // This does not verify a real deposit or issue a reward.
    return res.status(200).json({valid:false,reason:'generated_code_requires_deposit'});
  } catch (err) {
    console.error('USER VERIFY:', err && err.message);
    return res.status(503).json({valid:false,reason:'service_unavailable'});
  }
};
