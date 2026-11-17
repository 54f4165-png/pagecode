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
    // A tombstone survives deletion from ADMIN and blocks reuse.
    const usedSnap = await db.ref('usedCodes/'+normalized).once('value');
    if(usedSnap.exists()) return res.status(200).json({valid:false,reason:'code_expired'});
    const bonusRef=db.ref('bonusCodes/'+normalized);
    const bonusSnap=await bonusRef.once('value');
    if(bonusSnap.exists()){
      const bonus=bonusSnap.val();
      if(bonus && typeof bonus==='object' && bonus.status==='used')return res.status(200).json({valid:false,reason:'code_expired'});
      if(bonus && typeof bonus==='object' && bonus.status==='expired')return res.status(200).json({valid:false,reason:'code_expired'});
      const amount=Number(bonus&&typeof bonus==='object'?bonus.amount:bonus);
      if(!Number.isSafeInteger(amount)||amount<0||amount>1000000000)return res.status(200).json({valid:false,reason:'invalid_code'});
      // Atomic claim: only one request can change available -> used.
      const tx=await bonusRef.transaction(current=>{
        if(current===null||current===undefined)return;
        if(current&&typeof current==='object'&&current.status&&current.status!=='available'&&current.status!=='active')return;
        const currentAmount=Number(current&&typeof current==='object'?current.amount:current);
        if(!Number.isSafeInteger(currentAmount)||currentAmount<0||currentAmount>1000000000)return;
        return {amount:currentAmount,status:'used',usedAt:Date.now(),account:String(account).trim()};
      },undefined,false);
      if(!tx.committed)return res.status(200).json({valid:false,reason:'code_expired'});
      return res.status(200).json({valid:true,type:'bonus',amount,currency:'VND'});
    }
    const depositSnap=await db.ref('depositCodes/'+normalized).once('value');
    if(depositSnap.exists()){
      const entry=depositSnap.val();
      if(entry&&typeof entry==='object'&&['used','expired'].includes(entry.status))return res.status(200).json({valid:false,reason:'code_expired'});
      const amount=Number(entry&&typeof entry==='object'?entry.amount:entry);
      if(!Number.isFinite(amount)||amount<0)return res.status(200).json({valid:false,reason:'invalid_code'});
      // No actual deposit/account balance is connected. Do not consume this code on rejection.
      return res.status(200).json({valid:false,reason:'deposit_required',amount,currency:'VND'});
    }
    // Generated pools are not valid until ADMIN assigns an amount.
    const [topupPool,bonusPool]=await Promise.all([db.ref('topupPool/'+normalized).once('value'),db.ref('bonusPool/'+normalized).once('value')]);
    if(topupPool.exists()||bonusPool.exists()){
      const pool=topupPool.exists()?topupPool.val():bonusPool.val();
      if(pool?.status==='expired'||pool?.status==='used')return res.status(200).json({valid:false,reason:'code_expired'});
      return res.status(200).json({valid:false,reason:'code_not_configured'});
    }
    const snap=await db.ref('codes').once('value');
    const entries=snap.val()||{};
    const matched=Object.entries(entries).find(([id,item])=>{
      const value=item&&typeof item==='object'?item.value:item;
      return String(value||id).trim().toUpperCase()===normalized;
    });
    if(!matched)return res.status(200).json({valid:false,reason:'invalid_code'});
    const status=matched[1]&&typeof matched[1]==='object'?matched[1].status:'available';
    if(status==='used'||status==='expired')return res.status(200).json({valid:false,reason:'code_expired'});
    return res.status(200).json({valid:false,reason:'generated_code_requires_deposit'});
  } catch (err) {
    console.error('USER VERIFY:', err && err.message);
    return res.status(503).json({valid:false,reason:'service_unavailable'});
  }
};
