const router = require("express").Router();
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const BEGIN = "2026-08-25T00:00:00Z";
const END = "2026-09-11T00:29:00Z";
const TARGETS = new Set([
  "175963503433",
  "175480687905",
  "175481616175",
  "178328526116",
  "2000018250502448",
  "2000018197785500",
  "2000018392726278"
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(Number(String(v ?? "").replace(",", "."))) ? Number(String(v ?? "").replace(",", ".")) : 0;
const money = v => Number(n(v).toFixed(2));

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

function parseLine(line, delimiter = ";") {
  const out = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(current); current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const headers = parseLine(lines[0], delimiter).map(x => x.trim());
  const rows = lines.slice(1).map(line => {
    const values = parseLine(line, delimiter);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
  return { headers, rows };
}

function summarize(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = String(r[key] || "missing").toUpperCase();
    if (!out[k]) out[k] = { count: 0, settlement_net: 0, real: 0, transaction: 0 };
    out[k].count++;
    out[k].settlement_net += n(r.SETTLEMENT_NET_AMOUNT);
    out[k].real += n(r.REAL_AMOUNT);
    out[k].transaction += n(r.TRANSACTION_AMOUNT);
  }
  for (const x of Object.values(out)) {
    x.settlement_net = money(x.settlement_net);
    x.real = money(x.real);
    x.transaction = money(x.transaction);
  }
  return out;
}

function rowMatchesTargets(r) {
  const hay = [r.SOURCE_ID, r.EXTERNAL_REFERENCE, r.ORDER_ID, r.SHIPPING_ID, r.METADATA]
    .map(v => String(v || ""));
  return hay.some(value => [...TARGETS].some(target => value.includes(target)));
}

async function ensureConfig(account) {
  const existing = await call(account, "/v1/account/settlement_report/config");
  if (existing.ok) return { action: "existing", config: existing.data };
  if (existing.http !== 404) throw new Error(`Config GET HTTP ${existing.http}: ${JSON.stringify(existing.data).slice(0,300)}`);

  const body = {
    file_name_prefix: "matrix-settlement-report",
    show_fee_prevision: true,
    show_chargeback_cancel: true,
    coupon_detailed: true,
    include_withdraw: true,
    shipping_detail: true,
    refund_detailed: true,
    display_timezone: "GMT-03",
    header_language: "pt",
    frequency: { hour: 0, type: "monthly", value: 1 },
    columns: [
      "EXTERNAL_REFERENCE","SOURCE_ID","USER_ID","PAYMENT_METHOD_TYPE","PAYMENT_METHOD","SITE",
      "TRANSACTION_TYPE","TRANSACTION_AMOUNT","TRANSACTION_CURRENCY","TRANSACTION_DATE","FEE_AMOUNT",
      "SETTLEMENT_NET_AMOUNT","SETTLEMENT_CURRENCY","SETTLEMENT_DATE","REAL_AMOUNT","COUPON_AMOUNT",
      "METADATA","MKP_FEE_AMOUNT","FINANCING_FEE_AMOUNT","SHIPPING_FEE_AMOUNT","TAXES_AMOUNT",
      "INSTALLMENTS","ORDER_ID","SHIPPING_ID","SHIPMENT_MODE","PACK_ID"
    ].map(key => ({ key }))
  };

  const created = await call(account, "/v1/account/settlement_report/config", {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (!created.ok) throw new Error(`Config POST HTTP ${created.http}: ${JSON.stringify(created.data).slice(0,500)}`);
  return { action: "created", config: created.data };
}

function matchingReport(list) {
  const rows = Array.isArray(list) ? list : Array.isArray(list?.results) ? list.results : [];
  return rows.find(r => String(r?.begin_date || "").slice(0,10) === BEGIN.slice(0,10) && String(r?.end_date || "").slice(0,10) === END.slice(0,10)) || null;
}

async function ensureReport(account) {
  let listed = await call(account, "/v1/account/settlement_report/list");
  if (!listed.ok) throw new Error(`List HTTP ${listed.http}: ${JSON.stringify(listed.data).slice(0,300)}`);
  let report = matchingReport(listed.data);

  if (!report) {
    const created = await call(account, "/v1/account/settlement_report", {
      method: "POST",
      body: JSON.stringify({ begin_date: BEGIN, end_date: END })
    });
    if (!created.ok) throw new Error(`Create report HTTP ${created.http}: ${JSON.stringify(created.data).slice(0,500)}`);
    report = created.data;
  }

  for (let attempt = 0; attempt < 36; attempt++) {
    listed = await call(account, "/v1/account/settlement_report/list");
    if (!listed.ok) throw new Error(`Poll list HTTP ${listed.http}`);
    const candidate = matchingReport(listed.data);
    if (candidate) report = candidate;
    if (String(report?.status || "").toLowerCase() === "processed" && report?.file_name) return report;
    await sleep(5000);
  }
  return report;
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");

  const config = await ensureConfig(account);
  console.log("[Financeiro MP SETTLEMENT CONFIG]", JSON.stringify({ action: config.action, scheduled: config.config?.scheduled, columns: config.config?.columns?.length || 0 }));

  const report = await ensureReport(account);
  console.log("[Financeiro MP SETTLEMENT TASK]", JSON.stringify(report));
  if (String(report?.status || "").toLowerCase() !== "processed" || !report?.file_name) {
    return { config: config.action, report, processed: false };
  }

  const csv = await rawGet(account, `/v1/account/settlement_report/${encodeURIComponent(report.file_name)}`);
  const { headers, rows } = parseCsv(csv);
  const targetRows = rows.filter(rowMatchesTargets);
  const nonSettlement = rows.filter(r => String(r.TRANSACTION_TYPE || "").toUpperCase() !== "SETTLEMENT");

  const result = {
    config: config.action,
    scheduled: Boolean(config.config?.scheduled),
    report: { id: report.id, status: report.status, file_name: report.file_name, begin_date: report.begin_date, end_date: report.end_date },
    headers,
    total_rows: rows.length,
    by_transaction_type: summarize(rows, "TRANSACTION_TYPE"),
    target_rows: targetRows,
    non_settlement_rows: nonSettlement.slice(-200)
  };
  console.log("[Financeiro MP SETTLEMENT RESULT]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro MP SETTLEMENT RESULT] falhou:", error.message)), 18000);
startup.unref?.();

module.exports = router;
