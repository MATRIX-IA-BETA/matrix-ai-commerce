const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const money = v => Number((Number(v) || 0).toFixed(2));

async function getMpAccount(){
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("account_id,user_id,access_token")
    .eq("marketplace","mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) throw new Error("Mercado Pago não conectado");
  return data;
}

async function mpJson(path, account){
  const response = await fetch(`${MP_API}${path}`, {
    headers:{Accept:"application/json",Authorization:`Bearer ${account.access_token}`},
    signal:AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let data={}; try{data=text?JSON.parse(text):{};}catch{}
  if(!response.ok) throw new Error(`MP HTTP ${response.status}: ${data?.message||data?.error||"erro"}`);
  return data;
}

async function pendingPayments(account){
  const begin = new Date(Date.now()-180*86400000).toISOString();
  const end = new Date().toISOString();
  const rows=[]; let offset=0;
  while(offset<5000){
    const q = new URLSearchParams({sort:"date_created",criteria:"desc",range:"date_created",begin_date:begin,end_date:end,status:"approved",limit:"100",offset:String(offset)});
    const data = await mpJson(`/v1/payments/search?${q}`,account);
    const page = Array.isArray(data?.results)?data.results:[];
    rows.push(...page); offset += page.length;
    if(!page.length || page.length<100 || offset>=Number(data?.paging?.total||Infinity)) break;
  }
  return rows.filter(p=>String(p?.money_release_status||"").toLowerCase()==="pending");
}

function net(p){
  const exact=Number(p?.transaction_details?.net_received_amount);
  if(Number.isFinite(exact)) return money(Math.max(0,exact));
  const gross=Math.max(0,Number(p?.transaction_amount)||0);
  const refunded=Math.max(0,Number(p?.transaction_amount_refunded)||0);
  const fees=(Array.isArray(p?.fee_details)?p.fee_details:[]).reduce((s,f)=>s+Math.abs(Number(f?.amount)||0),0);
  return money(Math.max(0,gross-refunded-fees));
}
function ref(p){
  return [p?.external_reference,p?.order?.id,p?.order_id].filter(v=>v!=null).map(String).find(v=>/^200\d{10,}$/.test(v))||null;
}
function sum(rows){return money(rows.reduce((s,p)=>s+net(p),0));}
function bucket(rows){return {count:rows.length,net:sum(rows)};}

async function audit(){
  const account=await getMpAccount();
  const pending=await pendingPayments(account);
  const withRef=pending.filter(p=>ref(p));
  const withoutRef=pending.filter(p=>!ref(p));
  const refs=[...new Set(withRef.map(ref))];
  const orderMap=new Map();
  for(let i=0;i<refs.length;i+=100){
    const batch=refs.slice(i,i+100);
    const {data,error}=await supabase.from("marketplace_orders")
      .select("marketplace_order_id,status,date_created,date_closed")
      .eq("marketplace","mercadolivre")
      .in("marketplace_order_id",batch);
    if(error) throw new Error(error.message);
    for(const o of data||[]) orderMap.set(String(o.marketplace_order_id),o);
  }
  const now=Date.now();
  const future=[], overdue=[], foundPaid=[], foundCancelled=[], foundOther=[], missing=[];
  for(const p of withRef){
    const o=orderMap.get(ref(p));
    if(!o){missing.push(p);continue;}
    const st=String(o.status||"").toLowerCase();
    if(st==="paid") foundPaid.push(p);
    else if(st==="cancelled" || st==="canceled") foundCancelled.push(p);
    else foundOther.push(p);
    const release=new Date(p?.money_release_date||0).getTime();
    if(Number.isFinite(release)&&release>now) future.push(p); else overdue.push(p);
  }
  const paidFuture=foundPaid.filter(p=>new Date(p?.money_release_date||0).getTime()>now);
  const paidOverdue=foundPaid.filter(p=>!(new Date(p?.money_release_date||0).getTime()>now));
  const byOp={};
  for(const p of pending){
    const k=String(p?.operation_type||"missing");
    byOp[k]=byOp[k]||[]; byOp[k].push(p);
  }
  const summary={
    all_pending:bucket(pending),
    with_ml_order_ref:bucket(withRef),
    without_ml_order_ref:bucket(withoutRef),
    order_found_paid:bucket(foundPaid),
    order_found_cancelled:bucket(foundCancelled),
    order_found_other:bucket(foundOther),
    order_missing:bucket(missing),
    future_all_found:bucket(future),
    overdue_all_found:bucket(overdue),
    paid_future:bucket(paidFuture),
    paid_overdue:bucket(paidOverdue),
    by_operation:Object.fromEntries(Object.entries(byOp).map(([k,v])=>[k,bucket(v)])),
    overdue_paid_examples:paidOverdue.slice(0,30).map(p=>({id:p.id,order:ref(p),net:net(p),release:p.money_release_date,created:p.date_created,payment_type:p.payment_type_id,detail:p.status_detail}))
  };
  console.log("[Financeiro MP PENDING DIAG V5]",JSON.stringify(summary));
  return summary;
}

router.get("/api/finance/mercadopago/pending-diagnostic-v5", async (req,res)=>{
  try{res.json({sucesso:true,...await audit()});}
  catch(error){res.status(502).json({sucesso:false,mensagem:error.message});}
});

const startup=setTimeout(()=>audit().catch(e=>console.warn("[Financeiro MP PENDING DIAG V5] falhou:",e.message)),7000);
startup.unref?.();
module.exports=router;
