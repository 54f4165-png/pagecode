// E39: one atomic RTDB transaction commits claim and all related status changes.
// Never claim a code before confirming its category and eligibility.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({valid:false,reason:'method_not_allowed'});
  const {account,code,turnstileToken}=req.body||{};
  if(typeof account!=='string'||!account.trim()||account.length>100||typeof code!=='string'||!code.trim()||code.length>150||typeof turnstileToken!=='string'||!turnstileToken||turnstileToken.length>4096)
    return res.status(400).json({valid:false,reason:'invalid_request'});
  const normalized=code.trim().toUpperCase(), user=account.trim();
  if(!/^[A-Z]{6}$/.test(normalized)) return res.status(200).json({valid:false,reason:'invalid_code'});
  const secret=process.env.TURNSTILE_SECRET_KEY;
  if(!secret){console.error('USER VERIFY: missing TURNSTILE_SECRET_KEY');return res.status(503).json({valid:false,reason:'turnstile_not_configured'});}
  try {
    const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({secret,response:turnstileToken}).toString(),signal:AbortSignal.timeout(8000)
    });
    if(!response.ok)throw Error('turnstile_upstream');
    const verified=await response.json();
    if(verified.success!==true)return res.status(200).json({valid:false,reason:'verification_failed'});
    const {db}=require('./_firebase');
    // A root transaction is intentional: a code may be stored in multiple RTDB branches.
    // All changes commit together, including the usedCodes tombstone, or none commit.
    // This also serializes concurrent USER claims and ADMIN writes on overlapping data.
    let outcome={valid:false,reason:'invalid_code'};
    const tx=await db.ref('/').transaction(root=>{
      if(root===null||typeof root!=='object')return;
      const used=root.usedCodes||{}, bonuses=root.bonusCodes||{}, deposits=root.depositCodes||{};
      const bonusPool=root.bonusPool||{},topupPool=root.topupPool||{},codes=root.codes||{};
      if(Object.prototype.hasOwnProperty.call(used,normalized)){
        outcome={valid:false,reason:'code_expired'};return;
      }
      const stamp=Date.now();
      const mark=(type)=>{root.usedCodes={...used,[normalized]:{code:normalized,type,account:user,firstAt:stamp}};};
      const statusOf=v=>v&&typeof v==='object'?v.status:undefined;
      if(Object.prototype.hasOwnProperty.call(bonuses,normalized)){
        const v=bonuses[normalized],amount=Number(v&&typeof v==='object'?v.amount:v);
        if(['used','expired'].includes(statusOf(v))||['used','expired'].includes(statusOf(bonusPool[normalized]))){outcome={valid:false,reason:'code_expired'};return;}
        if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000){outcome={valid:false,reason:'code_not_configured'};return;}
        mark('bonus');root.bonusCodes={...bonuses,[normalized]:{amount,status:'used',usedAt:stamp,account:user}};
        if(Object.prototype.hasOwnProperty.call(bonusPool,normalized))root.bonusPool={...bonusPool,[normalized]:{...bonusPool[normalized],status:'used',usedAt:stamp}};
        outcome={valid:true,type:'bonus',amount,currency:'VND'};return root;
      }
      if(Object.prototype.hasOwnProperty.call(deposits,normalized)){
        const v=deposits[normalized],amount=Number(v&&typeof v==='object'?v.amount:v);
        if(['used','expired'].includes(statusOf(v))||['used','expired'].includes(statusOf(topupPool[normalized]))){outcome={valid:false,reason:'code_expired'};return;}
        if(!Number.isSafeInteger(amount)||amount<0||amount>1000000000){outcome={valid:false,reason:'invalid_code'};return;}
        mark('deposit');root.depositCodes={...deposits,[normalized]:{...(v&&typeof v==='object'?v:{amount}),status:'used',usedAt:stamp,account:user}};
        if(Object.prototype.hasOwnProperty.call(topupPool,normalized))root.topupPool={...topupPool,[normalized]:{...topupPool[normalized],status:'used',usedAt:stamp}};
        outcome={valid:false,reason:'deposit_required',amount,currency:'VND'};return root;
      }
      if(Object.prototype.hasOwnProperty.call(topupPool,normalized)||Object.prototype.hasOwnProperty.call(bonusPool,normalized)){
        const pool=topupPool[normalized]||bonusPool[normalized];
        outcome={valid:false,reason:['expired','used'].includes(statusOf(pool))?'code_expired':'code_not_configured'};return;
      }
      const matched=Object.entries(codes).find(([id,v])=>String(v&&typeof v==='object'?v.value||id:v||id).trim().toUpperCase()===normalized);
      if(!matched){outcome={valid:false,reason:'invalid_code'};return;}
      const [id,v]=matched;
      if(['used','expired'].includes(statusOf(v))){outcome={valid:false,reason:'code_expired'};return;}
      mark('generated');root.codes={...codes,[id]:{...(v&&typeof v==='object'?v:{value:normalized}),status:'used',usedAt:stamp,account:user}};
      outcome={valid:false,reason:'generated_code_requires_deposit'};return root;
    },undefined,false);
    // If the transaction aborts (invalid/expired), outcome describes why.
    // If Firebase rejects it, the catch below returns 503; no partial claim is committed.
    if(!tx.committed && !outcome.reason)return res.status(503).json({valid:false,reason:'service_unavailable'});
    return res.status(200).json(outcome);
  }catch(err){console.error('USER VERIFY:',err&&err.message);return res.status(503).json({valid:false,reason:'service_unavailable'});}
};
