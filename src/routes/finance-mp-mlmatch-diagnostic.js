const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const TARGETS = [
  "175963503433","175480687905","175481616175","178328526116",
  "2000018250502448","2000018197785500","2000018392726278"
];
const n = v => Number.isFinite(Number(String(v ?? "").replace(",", "."))) ? Number(String(v ?? "").replace(",", ".")) : 0;
const money = v => Number(n(v).toFixed(2));

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
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = parseLine(lines[0], delimiter).map(x => x.trim());
  const rows = lines.slice(1).map(line => {
    const vals = parseLine(line, delimiter);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
  return { headers, rows };
}

function summarize(rows) {
  const out = {};
  for (const r of rows) {
    const k = String(r.TRANSACTION_TYPE || "missing").toUpperCase();
    if (!out[k]) out[k] = { count: 0, settlement_net: 0, real: 0, transaction: 0 };
    out[k].count++;
    out[k].settlement_net += n(r.SETTLEMENT_NET_AMOUNT);
    out[k].real += n(r.REAL_AMOUNT);
    out[k].transaction += n(r.TRANSACTION_AMOUNT);
  }
  for (const v of Object.values(out)) {
    v.settlement_net = money(v.settlement_net);
    v.real = money(v.real);
    v.transaction = money(v.transaction);
  }
  return out;
}

function matches(r) {
  const hay = [r.SOURCE_ID,r.EXTERNAL_REFERENCE,r.ORDER_ID,r.SHIPPING_ID,r.METADATA].join(" ");
  return TARGETS.some(id => hay.includes(id));
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");

  const configReq = await mpRequest("/v1/account/settlement_report/config", account);
  const listReq = await mpRequest("/v1/account/settlement_report/list", account);
  const list = Array.isArray(listReq.data) ? listReq.data : (Array.isArray(listReq.data?.results) ? listReq.data.results : []);
  const reports = list.map(r => ({
    id:r.id,status:r.status,begin_date:r.begin_date,end_date:r.end_date,file_name:r.file_name,generation_date:r.generation_date,last_modified:r.last_modified
  }));
  console.log("[Financeiro MP SETTLEMENT CHECK]", JSON.stringify({ config_http:configReq.response.status, scheduled:configReq.data?.scheduled, reports }));

  const report = list.find(r => r.file_name && String(r.status || "").toLowerCase() === "processed" && String(r.begin_date || "").startsWith("2026-08-25"));
  if (!report) return { processed:false, reports };

  const csv = await rawGet(account, `/v1/account/settlement_report/${encodeURIComponent(report.file_name)}`);
  const { headers, rows } = parseCsv(csv);
  const targetRows = rows.filter(matches);
  const specialRows = rows.filter(r => !["SETTLEMENT","SETTLEMENT_SHIPPING"].includes(String(r.TRANSACTION_TYPE || "").toUpperCase()));
  const result = {
    processed:true,
    report:{id:report.id,status:report.status,file_name:report.file_name,begin_date:report.begin_date,end_date:report.end_date},
    headers,
    total_rows:rows.length,
    by_type:summarize(rows),
    target_rows:targetRows,
    special_rows:specialRows
  };
  console.log("[Financeiro MP SETTLEMENT DATA]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req,res)=>{
  try { res.json({sucesso:true,...(await audit())}); }
  catch(error){ res.status(502).json({sucesso:false,mensagem:error.message}); }
});

const startup=setTimeout(()=>audit().catch(error=>console.warn("[Financeiro MP SETTLEMENT CHECK] falhou:",error.message)),12000);
startup.unref?.();
module.exports=router;
