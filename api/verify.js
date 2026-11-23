// User-side code verification backed by Firebase Realtime Database.
// Firebase service-account credentials and Turnstile secret remain server-side.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma','no-cache');
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
    // Record each Turnstile-verified attempt, including unsuccessful code checks.
    // Logging runs server-side and is not exposed to the public USER page.
    const clean = (v, max=180) => String(v || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0,max);
    const ipHeader = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '';
    const ip = clean((Array.isArray(ipHeader)?ipHeader[0]:ipHeader).split(',')[0].trim() || req.socket?.remoteAddress, 64);
    const ua = clean(req.headers['user-agent'], 320);
    const device = /ipad|tablet|android(?!.*mobile)/i.test(ua) ? 'Tablet' : /mobile|iphone|ipod|android/i.test(ua) ? 'Điện thoại' : 'PC / Khác';
    const os = /windows nt/i.test(ua)?'Windows':/iphone|ipad|ipod/i.test(ua)?'iOS / iPadOS':/android/i.test(ua)?'Android':/mac os x/i.test(ua)?'macOS':/linux/i.test(ua)?'Linux':'Không rõ';
    const browser = /edg\//i.test(ua)?'Edge':/firefox\//i.test(ua)?'Firefox':/chrome\//i.test(ua)?'Chrome':/safari\//i.test(ua)?'Safari':'Không rõ';
    const crypto = require('crypto');
    const originalJson = res.json.bind(res);
    res.json = function(payload) {
      // Do not allow logging failures to change the actual CODE verification result.
      const record = {at:Date.now(),account:clean(account.trim(),100),code:clean(code.trim().toUpperCase(),150),
        valid:payload?.valid===true,reason:clean(payload?.reason || (payload?.valid?'success':'unknown'),80),
        amount:payload?.valid===true?Number(payload.amount)||0:null,
        ip,device,os,browser,userAgent:ua};
      const counterKey=crypto.createHash('sha256').update(record.account+'\0'+record.code).digest('hex');
      // Run independent audit writes concurrently instead of serially.
      // The log is committed before responding so serverless shutdown cannot drop it.
      Promise.allSettled([
        db.ref('codeCheckCounts/'+counterKey).transaction(v=>(Number(v)||0)+1,undefined,false),
        db.ref('codeCheckLogs').push(record)
      ]).then(results=>{
        for (const result of results) if(result.status==='rejected')
          console.error('CODE AUDIT:',result.reason?.message || result.reason);
      }).finally(()=>originalJson(payload));
      return res;
    };
    const normalized = code.trim().toUpperCase();
    // A CODE can be submitted only once globally, regardless of account or type.
    // RTDB transaction prevents two simultaneous requests from claiming the same CODE.
    const claimCode=async(type)=>{
      const ref=db.ref('usedCodes/'+normalized);
      const tx=await ref.transaction(current=>current===null?{
        code:normalized,type,account:String(account).trim(),firstAt:Date.now()
      }:undefined,undefined,false);
      return tx.committed;
    };
    if (!/^[A-Z]{6}$/.test(normalized)) return res.status(200).json({valid:false,reason:'invalid_code'});
    // A tombstone survives deletion from ADMIN and blocks reuse.
    // Independent lookups run in parallel to avoid 3-5 sequential RTDB round trips.
    const [usedSnap,bonusSnap,depositSnap,topupPoolSnap,bonusPoolSnap]=await Promise.all([
      db.ref('usedCodes/'+normalized).once('value'),
      db.ref('bonusCodes/'+normalized).once('value'),
      db.ref('depositCodes/'+normalized).once('value'),
      db.ref('topupPool/'+normalized).once('value'),
      db.ref('bonusPool/'+normalized).once('value')
    ]);
    if(usedSnap.exists()) return res.status(200).json({valid:false,reason:'code_expired'});
    if(bonusSnap.exists()){
      const bonus=bonusSnap.val();
      if(bonus && typeof bonus==='object' && bonus.status==='used')return res.status(200).json({valid:false,reason:'code_expired'});
      if(bonus && typeof bonus==='object' && bonus.status==='expired')return res.status(200).json({valid:false,reason:'code_expired'});
      const amount=Number(bonus&&typeof bonus==='object'?bonus.amount:bonus);
      if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)return res.status(200).json({valid:false,reason:'code_not_configured'});
      const poolBefore=bonusPoolSnap;
      if(poolBefore.exists() && ['used','expired'].includes(poolBefore.val()?.status))
        return res.status(200).json({valid:false,reason:'code_expired'});
      // usedCodes/<code> is the per-code concurrency lock, shared across types.
      // Never transact on the database root (large, unrelated and null-cache prone).
      if(!(await claimCode('bonus')))
        return res.status(200).json({valid:false,reason:'code_expired'});
      const now=Date.now();
      const claimant=String(account).trim();
      const poolSnap=bonusPoolSnap;
      const updates={};
      updates['bonusCodes/'+normalized]={amount,status:'used',usedAt:now,account:claimant};
      if(poolSnap.exists())updates['bonusPool/'+normalized+'/status']='used';
      // Multi-path update is atomic for the state paths. Retry transient errors;
      // a tombstone must never be deleted or a consumed code reissued.
      let saved=false;
      for(let attempt=0;attempt<3;attempt++){
        try { await db.ref('/').update(updates); saved=true; break; }
        catch(e){console.error('BONUS: state update attempt failed',normalized,attempt+1,e?.message);}
      }
      if(!saved){
        console.error('BONUS: claim recorded but state update failed',normalized);
        return res.status(503).json({valid:false,reason:'service_unavailable'});
      }
      return res.status(200).json({valid:true,type:'bonus',amount,currency:'VND'});
    }
    if(depositSnap.exists()){
      const entry=depositSnap.val();
      if(entry&&typeof entry==='object'&&['used','expired'].includes(entry.status))return res.status(200).json({valid:false,reason:'code_expired'});
      const amount=Number(entry&&typeof entry==='object'?entry.amount:entry);
      if(!Number.isFinite(amount)||amount<0)return res.status(200).json({valid:false,reason:'invalid_code'});
      if(!(await claimCode('deposit'))) return res.status(200).json({valid:false,reason:'code_expired'});
      await db.ref('depositCodes/'+normalized).update({status:'used',usedAt:Date.now()});
      // First valid submission consumes the CODE even when the account has no deposit.
      return res.status(200).json({valid:false,reason:'deposit_required',amount,currency:'VND'});
    }
    // Generated pools are not valid until ADMIN assigns an amount.
    const topupPool=topupPoolSnap,bonusPool=bonusPoolSnap;
    if(topupPool.exists()||bonusPool.exists()){
      const pool=topupPool.exists()?topupPool.val():bonusPool.val();
      if(pool?.status==='expired'||pool?.status==='used')return res.status(200).json({valid:false,reason:'code_expired'});
      // An unconfigured pool code is not redeemed: ADMIN may assign an amount later.
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
    if(!(await claimCode('generated'))) return res.status(200).json({valid:false,reason:'code_expired'});
    await db.ref('codes/'+matched[0]).update({status:'used',usedAt:Date.now()});
    return res.status(200).json({valid:false,reason:'generated_code_requires_deposit'});
  } catch (err) {
    console.error('USER VERIFY:', err && err.message);
    return res.status(503).json({valid:false,reason:'service_unavailable'});
  }
};
