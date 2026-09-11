const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const BEGIN = "2026-08-25T00:00:00Z";
const END = "2026-09-11T00:29:00Z";
const TARGETS = [
  "175963503433","175480687905","175481616175","178328526116",
  "2000018250502448","2000018197785500","2000018392726278"
];
const n = v => Number.isFinite(Number(String(v ?? "").replace(",", "."))) ? Number(String(v ?? "").replace(",", ".")) : 0;
const money = v => Number(n(v).toFixed(2));
let targetReportId = null;

async function call(account, path, options = undefined) {
  const { response, data } = await mpRequest(path, account, options);
  return { http: response.status, ok: response.ok, data };
}

async function rawGet(account, path) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${account.access_token}`, Accept: "text/csv,*/*" },
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${text.slice(0,300)}`);
  return text;
}

function parseLine(line, delimiter) {
  const out=[]; let cur="", quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){cur+='"';i++;} else quoted=!quoted;
    } else if(ch===delimiter && !quoted){out.push(cur);cur="";} else cur+=ch;
  }
  out.push(cur); return out;
}

function parseCsv(text){
  const lines=String(text||"").replace(/^\uFEFF/,"").split(/\r?\n/).filter(Boolean);
  if(!lines.length) return {headers:[],rows:[]};
  const delimiter=lines[0].includes(";")?";":",";
  const headers=parseLine(lines[0],delimiter).map(x=>x.trim());
  const rows=lines.slice(1).map(line=>{
    const vals=parseLine(line,delimiter);
    return Object.fromEntries(headers.map((h,i)=>[h,vals[i]??""]));
  });
  return {headers,rows};
}

function matchingRows(rows){
  return rows.filter(r=>TARGETS.some(id=>[
    r.SOURCE_ID,r.EXTERNAL_REFERENCE,r.METADATA,r.DESCRIPTION
  ].map(v=>String(v||"")).some(v=>v.includes(id))));
}

function summarize(rows){
  const out={};
  for(const r of rows){
    const key=`${String(r.RECORD_TYPE||"missing").toLowerCase()}|${String(r.DESCRIPTION||"missing").toLowerCase()}`;
    if(!out[key]) out[key]={count:0,credit:0,debit:0,gross:0};
    out[key].count++;
    out[key].credit+=n(r.NET_CREDIT_AMOUNT);
    out[key].debit+=n(r.NET_DEBIT_AMOUNT);
    out[key].gross+=n(r.GROSS_AMOUNT);
  }
  for(const x of Object.values(out)){x.credit=money(x.credit);x.debit=money(x.debit);x.gross=money(x.gross);}
  return out;
}

async function ensureConfig(account){
  const existing=await call(account,"/v1/account/release_report/config");
  if(existing.ok) return {action:"existing",config:existing.data};
  if(existing.http!==404) throw new Error(`Release config GET HTTP ${existing.http}: ${JSON.stringify(existing.data).slice(0,300)}`);
  const body={
    file_name_prefix:"matrix-release-report",
    include_withdrawal_at_end:true,
    execute_after_withdrawal:false,
    display_timezone:"GMT-03",
    frequency:{hour:0,type:"monthly",value:1},
    columns:[
      "DATE","SOURCE_ID","EXTERNAL_REFERENCE","RECORD_TYPE","DESCRIPTION",
      "NET_CREDIT_AMOUNT","NET_DEBIT_AMOUNT","SELLER_AMOUNT","GROSS_AMOUNT",
      "METADATA","MP_FEE_AMOUNT","FINANCING_FEE_AMOUNT","SHIPPING_FEE_AMOUNT",
      "TAXES_AMOUNT","COUPON_AMOUNT","INSTALLMENTS","PAYMENT_METHOD","PAYMENT_METHOD_TYPE"
    ].map(key=>({key}))
  };
  const created=await call(account,"/v1/account/release_report/config",{method:"POST",body:JSON.stringify(body)});
  if(!created.ok) throw new Error(`Release config POST HTTP ${created.http}: ${JSON.stringify(created.data).slice(0,500)}`);
  return {action:"created",config:created.data};
}

function listRows(data){return Array.isArray(data)?data:(Array.isArray(data?.results)?data.results:[]);}
function isOurPeriod(r){
  const begin=String(r?.begin_date||"");
  const end=String(r?.end_date||"");
  return (begin.startsWith("2026-08-24")||begin.startsWith("2026-08-25")) && (end.startsWith("2026-09-11")||end.startsWith("2026-09-10"));
}

async function ensureReport(account){
  const listed=await call(account,"/v1/account/release_report/list");
  if(!listed.ok) throw new Error(`Release list HTTP ${listed.http}: ${JSON.stringify(listed.data).slice(0,300)}`);
  let report=listRows(listed.data).find(isOurPeriod)||null;
  if(!report){
    const created=await call(account,"/v1/account/release_report",{method:"POST",body:JSON.stringify({begin_date:BEGIN,end_date:END})});
    if(!created.ok) throw new Error(`Release create HTTP ${created.http}: ${JSON.stringify(created.data).slice(0,500)}`);
    report=created.data;
  }
  targetReportId=String(report?.id||report?.report_id||targetReportId||"");
  return report;
}

async function audit(){
  const account=await getMercadoPagoAccount();
  if(!account?.access_token) throw new Error("Mercado Pago não conectado.");
  const config=await ensureConfig(account);
  if(!targetReportId) await ensureReport(account);

  const listed=await call(account,"/v1/account/release_report/list");
  if(!listed.ok) throw new Error(`Release list HTTP ${listed.http}`);
  const list=listRows(listed.data);
  const report=list.find(r=>String(r.id||r.report_id)===String(targetReportId)) || list.find(isOurPeriod) || null;
  if(report) targetReportId=String(report.id||report.report_id||targetReportId);

  console.log("[Financeiro MP RELEASE WATCH]",JSON.stringify({
    config:config.action,scheduled:Boolean(config.config?.scheduled),target:report?{
      id:report.id,report_id:report.report_id,status:report.status,file_name:report.file_name,
      begin_date:report.begin_date,end_date:report.end_date,last_modified:report.last_modified
    }:null
  }));

  if(!report || String(report.status||"").toLowerCase()!=="processed" || !report.file_name){
    return {processed:false,report};
  }

  const csv=await rawGet(account,`/v1/account/release_report/${encodeURIComponent(report.file_name)}`);
  const {headers,rows}=parseCsv(csv);
  const blocks=rows.filter(r=>["block","unblock"].includes(String(r.RECORD_TYPE||"").toLowerCase()));
  const result={
    processed:true,
    report:{id:report.id,report_id:report.report_id,status:report.status,file_name:report.file_name,begin_date:report.begin_date,end_date:report.end_date},
    headers,total_rows:rows.length,
    by_record_description:summarize(rows),
    target_rows:matchingRows(rows),
    block_unblock_rows:blocks
  };
  console.log("[Financeiro MP RELEASE DATA]",JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic",async(req,res)=>{
  try{res.json({sucesso:true,...(await audit())});}
  catch(error){res.status(502).json({sucesso:false,mensagem:error.message});}
});

let attempts=0,watcher=null;
async function check(){
  attempts++;
  try{
    const result=await audit();
    if(result.processed||attempts>=20){if(watcher)clearInterval(watcher);watcher=null;console.log("[Financeiro MP RELEASE WATCH] encerrado:",JSON.stringify({attempts,processed:Boolean(result.processed)}));}
  }catch(error){console.warn("[Financeiro MP RELEASE WATCH] falhou:",error.message);if(attempts>=20&&watcher){clearInterval(watcher);watcher=null;}}
}
const startup=setTimeout(check,8000); startup.unref?.();
watcher=setInterval(check,30000); watcher.unref?.();

module.exports=router;
