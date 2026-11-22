"use strict";
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");
const { getCampaigns } = require("../services/mercado-ads");

const dateRx = /^\d{4}-\d{2}-\d{2}$/;
const round = n => Math.round((Number(n) || 0) * 100) / 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function period(query = {}) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const end = query.date_to || query.end || today;
  const base = new Date(end + "T12:00:00Z");
  const start = query.date_from || query.start || new Date(base.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  if (![start,end].every(d => dateRx.test(d) && !Number.isNaN(Date.parse(d + "T12:00:00Z")))) {
    const e = new Error("Datas inválidas. Use AAAA-MM-DD."); e.status = 400; throw e;
  }
  const days = Math.round((Date.parse(end + "T12:00:00Z") - Date.parse(start + "T12:00:00Z")) / 86400000) + 1;
  if (days < 1 || days > 93) { const e = new Error("Escolha de 1 a 93 dias por consulta."); e.status = 400; throw e; }
  return { start, end, days, beginUtc: start + "T03:00:00Z", endUtc: new Date(Date.parse(end + "T03:00:00Z") + 86400000).toISOString().replace(".000Z","Z") };
}
async function mpAccount() {
  const { data, error } = await supabase.from("marketplace_accounts")
    .select("access_token").eq("marketplace","mercadopago").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) { const e = new Error("Mercado Pago não conectado."); e.status = 428; throw e; }
  return data;
}
async function mp(path, acc, options = {}) {
  const resp = await fetch("https://api.mercadopago.com" + path, {
    ...options,
    headers: { "Authorization": "Bearer " + acc.access_token, "Accept": "application/json", ...(options.body ? {"Content-Type":"application/json"} : {}) },
    signal: AbortSignal.timeout(30000)
  });
  const body = await resp.text();
  if (!resp.ok) { const e = new Error("Mercado Pago HTTP " + resp.status); e.status = resp.status; throw e; }
  if (options.csv) return body;
  try { return JSON.parse(body); } catch { throw new Error("Resposta inesperada do Mercado Pago."); }
}
function parseCsv(src, separator) {
  const lines = [], row = []; let cell = "", quoted = false;
  src = String(src).replace(/^\uFEFF/,"");
  for (let i=0;i<src.length;i++) {
    const c=src[i];
    if (c === '"') { if (quoted && src[i+1] === '"') {cell+='"';i++;} else quoted=!quoted; }
    else if (c === separator && !quoted) {row.push(cell);cell="";}
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && src[i+1] === "\n") i++;
      row.push(cell);cell="";if(row.some(Boolean))lines.push(row.slice());row.length=0;
    } else cell+=c;
  }
  if (cell || row.length) {row.push(cell);if(row.some(Boolean))lines.push(row);}
  return lines;
}
function currency(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return 0;
  const v = Number(s.includes(",") && !s.includes(".") ? s.replace(",",".") : s);
  return Number.isFinite(v) ? v : 0;
}
function advanceFromCsv(csv, sep, dates) {
  const rows = parseCsv(csv,sep); if (!rows.length) throw new Error("CSV do Mercado Pago vazio.");
  const h=rows[0].map(x=>String(x).trim().toUpperCase());
  const col=name=>h.indexOf(name);
  for (const required of ["DATE","DESCRIPTION","NET_DEBIT_AMOUNT"]) if(col(required)<0) throw new Error("Coluna ausente: "+required);
  const unique=new Set(), details=[];
  for(const r of rows.slice(1)) {
    const description=String(r[col("DESCRIPTION")]||"").trim().toLowerCase().replace(/-/g,"_");
    if (!/^fee_release_in_advance$/.test(description)) continue;
    const date=String(r[col("DATE")]||"").slice(0,10);
    if(date < dates.start || date > dates.end) continue;
    const debit=Math.abs(currency(r[col("NET_DEBIT_AMOUNT")]));
    const credit=col("NET_CREDIT_AMOUNT")>=0 ? Math.abs(currency(r[col("NET_CREDIT_AMOUNT")])) : 0;
    const amount=round(debit-credit);
    const id=col("SOURCE_ID")>=0 ? String(r[col("SOURCE_ID")]||"") : "";
    const key=[date,id,amount].join("|");
    if(unique.has(key)) continue;unique.add(key);
    details.push({date, source_id:id||null, amount});
  }
  return {total:round(details.reduce((s,r)=>s+r.amount,0)), transactions:details.length, details};
}
async function findReport(acc, range) {
  const listing=await mp("/v1/account/release_report/search?limit=100&offset=0",acc);
  const reports=Array.isArray(listing.results)?listing.results:[];
  const begin=Date.parse(range.beginUtc),end=Date.parse(range.endUtc);
  return reports.find(x=>x.file_name && x.is_reserve!==true &&
    Math.abs(Date.parse(x.begin_date)-begin)<86400000 &&
    Math.abs(Date.parse(x.end_date)-end)<86400000) || null;
}
async function advances(range, generate) {
  const acc=await mpAccount();
  const report=await findReport(acc,range);
  if(report) {
    const config=await mp("/v1/account/release_report/config",acc);
    const sep=typeof config.separator==="string" && config.separator ? config.separator : ",";
    const csv=await mp("/v1/account/release_report/"+encodeURIComponent(report.file_name),acc,{csv:true});
    return {status:"ready",period:range,source:"mercadopago_release_report",file:report.file_name,...advanceFromCsv(csv,sep,range)};
  }
  if (!generate) return {status:"pending",period:range,message:"Relatório ainda não disponível. Solicite a geração."};
  const task=await mp("/v1/account/release_report",acc,{method:"POST",body:JSON.stringify({begin_date:range.beginUtc,end_date:range.endUtc})});
  return {status:"generating",period:range,task_id:task.id||null,message:"Mercado Pago está preparando o relatório. Consulte novamente em instantes."};
}
async function advertising(range) {
  const result=await getCampaigns({dateFrom:range.start,dateTo:range.end});
  const metrics=result.metrics_summary||{};
  if (metrics.cost == null && metrics.spend == null) throw new Error("Ads não retornou a métrica de custo.");
  return {status:"ready",total:round(metrics.cost??metrics.spend),source:"mercado_ads_product_ads",campaigns:(result.campaigns||[]).length,notice:"Product Ads; outras modalidades de publicidade podem não estar incluídas."};
}
async function returns(range) {
  const account=await getMercadoLivreAccount();
  if(!account) {const e=new Error("Mercado Livre não conectado.");e.status=428;throw e;}
  const resourceSet=new Set(), page=500;
  for(let offset=0;offset<5000;offset+=page) {
    const {data,error}=await supabase.from("marketplace_webhook_events").select("resource")
      .eq("topic","post_purchase").gte("received_at",range.beginUtc).lt("received_at",range.endUtc)
      .range(offset,offset+page-1);
    if(error)throw new Error(error.message);
    for(const entry of data||[]) {
      const m=String(entry.resource||"").match(/\/claims\/(\d+)/);
      if(m)resourceSet.add(m[1]);
    }
    if(!data || data.length<page)break;
    if(offset+page>=5000)throw new Error("Mais de 5.000 eventos; consulte intervalo menor.");
  }
  const ids=[...resourceSet]; const details=[], errors=[];
  for(let i=0;i<ids.length;i+=5) {
    await Promise.all(ids.slice(i,i+5).map(async id=>{
      try {
        const {response}=await mercadoLivreFetch("/post-purchase/v1/claims/"+id+"/charges/return-cost",account);
        if(response.status===404)return;
        if(!response.ok){errors.push({claim_id:id,status:response.status});return;}
        const data=await response.json();
        const amount=Number(data.amount);
        if(Number.isFinite(amount)&&amount>0&&data.currency_id==="BRL")details.push({claim_id:id,amount:round(amount)});
      }catch(e){errors.push({claim_id:id,error:e.message});}
    }));
  }
  return {status:errors.length?"partial":"ready",total:round(details.reduce((s,x)=>s+x.amount,0)),
    claim_count:details.length,claims_checked:ids.length,details:details.sort((a,b)=>b.amount-a.amount),errors,
    source:"mercadolivre_claim_return_cost",
    notice:"Custos associados às reclamações com notificação no período; o endpoint não fornece data de cobrança. Não representa necessariamente o frete debitado no caixa durante essas datas."};
}
function fail(res,e){res.status(e.status>=400 && e.status<=599?e.status:502).json({success:false,message:e.message});}
router.get("/api/finance/custos/ads",async(req,res)=>{try{res.json({success:true,period:period(req.query),...await advertising(period(req.query))});}catch(e){fail(res,e);}});
router.get("/api/finance/custos/devolucoes",async(req,res)=>{try{const p=period(req.query);res.json({success:true,period:p,...await returns(p)});}catch(e){fail(res,e);}});
router.get("/api/finance/custos/antecipacao",async(req,res)=>{try{res.json({success:true,...await advances(period(req.query),false)});}catch(e){fail(res,e);}});
router.post("/api/finance/custos/antecipacao",async(req,res)=>{try{res.json({success:true,...await advances(period(req.body),true)});}catch(e){fail(res,e);}});
module.exports=router;
