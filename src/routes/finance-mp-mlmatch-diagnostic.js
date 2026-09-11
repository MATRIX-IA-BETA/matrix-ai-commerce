const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNAPSHOT_AT = new Date("2026-09-11T00:29:00.000Z");
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));

function net(p) {
  const v = Number(p?.transaction_details?.net_received_amount);
  if (Number.isFinite(v)) return money(Math.max(0, v));
  return money(Math.max(0, n(p?.transaction_amount) - n(p?.transaction_amount_refunded)));
}

async function search(account) {
  const rows=[]; let offset=0,total=null;
  const end = new Date(SNAPSHOT_AT.getTime()+180*86400000);
  while(offset<5000){
    const q=new URLSearchParams({sort:"money_release_date",criteria:"asc",range:"money_release_date",begin_date:SNAPSHOT_AT.toISOString(),end_date:end.toISOString(),limit:"100",offset:String(offset)});
    const {response,data}=await mpRequest(`/v1/payments/search?${q}`,account);
    if(!response.ok) throw new Error(`HTTP ${response.status}: ${data?.message||data?.error||"erro"}`);
    const page=Array.isArray(data?.results)?data.results:[];
    rows.push(...page); total=Number(data?.paging?.total??total); offset+=page.length;
    if(!page.length||page.length<100||(Number.isFinite(total)&&offset>=total)) break;
    await sleep(180);
  }
  return rows.filter(p=>{
    const approved=new Date(p?.date_approved||p?.date_created||0).getTime();
    const release=new Date(p?.money_release_date||0).getTime();
    return String(p?.status||"").toLowerCase()==="approved" && String(p?.money_release_status||"").toLowerCase()==="pending" && approved<=SNAPSHOT_AT.getTime() && release>SNAPSHOT_AT.getTime();
  });
}

async function audit(){
  const account=await getMercadoPagoAccount();
  const rows=await search(account);
  const groups={};
  for(const p of rows){
    const collector=String(p?.collector?.id??p?.collector_id??"missing");
    if(!groups[collector]) groups[collector]={count:0,net:0,rows:[]};
    groups[collector].count++; groups[collector].net+=net(p);
    if(collector!==String(account.user_id||account.account_id)) groups[collector].rows.push({id:p?.id,net:net(p),gross:money(p?.transaction_amount),order_id:p?.order?.id??p?.order_id??null,description:String(p?.description||"").slice(0,100),poi:p?.point_of_interaction?.type??null,external_reference:p?.external_reference??null});
  }
  for(const g of Object.values(groups)) g.net=money(g.net);
  const result={snapshot_at:SNAPSHOT_AT.toISOString(),target_collector:String(account.user_id||account.account_id),total:{count:rows.length,net:money(rows.reduce((s,p)=>s+net(p),0))},by_collector:groups};
  console.log("[Financeiro MP COLLECTOR BREAKDOWN]",JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic",async(req,res)=>{try{res.json({sucesso:true,...await audit()})}catch(error){res.status(502).json({sucesso:false,mensagem:error.message})}});
const startup=setTimeout(()=>audit().catch(e=>console.warn("[Financeiro MP COLLECTOR BREAKDOWN] falhou:",e.message)),18000); startup.unref?.();
module.exports=router;
