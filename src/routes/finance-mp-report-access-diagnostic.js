const router = require("express").Router();
const { supabase } = require("../db/supabase");

const BASE = "https://api.mercadopago.com";

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("access_token,user_id,account_id")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) throw new Error("Mercado Pago OAuth não conectado");
  return data;
}

async function raw(path, account, accept = "application/json") {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: accept, Authorization: `Bearer ${account.access_token}` },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let data = null;
  if (accept.includes("json")) {
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  }
  return { response, data, text };
}

function parseCsvLine(line, separator = ",") {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function parseMoney(value) {
  const n = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function analyzeReleaseCsv(text, separator = ",") {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rows: 0, error: "CSV vazio" };
  const headers = parseCsvLine(lines[0], separator).map(v => v.trim());
  const index = Object.fromEntries(headers.map((h, i) => [h, i]));
  const required = ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"];
  if (required.some(k => index[k] == null)) return { rows: 0, error: `Colunas ausentes: ${required.filter(k => index[k] == null).join(", ")}` };

  const types = {};
  let initial = 0;
  let releaseDelta = 0;
  let allOperationalDelta = 0;
  let lastAvailable = null;

  for (let lineNo = 1; lineNo < lines.length; lineNo++) {
    const values = parseCsvLine(lines[lineNo], separator);
    const type = String(values[index.RECORD_TYPE] || "").trim().toLowerCase();
    const credit = parseMoney(values[index.NET_CREDIT_AMOUNT]);
    const debit = parseMoney(values[index.NET_DEBIT_AMOUNT]);
    const delta = credit - debit;
    types[type || "empty"] = (types[type || "empty"] || 0) + 1;

    if (type === "initial_available_balance") initial += delta;
    if (type === "release") releaseDelta += delta;
    if (!["total", "available_balance", "initial_available_balance"].includes(type)) allOperationalDelta += delta;

    if (type === "available_balance") {
      lastAvailable = {
        date: index.DATE != null ? values[index.DATE] || null : null,
        description: index.DESCRIPTION != null ? values[index.DESCRIPTION] || null : null,
        credit: Number(credit.toFixed(2)),
        debit: Number(debit.toFixed(2)),
        delta: Number(delta.toFixed(2))
      };
    }
  }

  return {
    rows: lines.length - 1,
    types,
    initial_available_balance: Number(initial.toFixed(2)),
    release_delta: Number(releaseDelta.toFixed(2)),
    candidate_initial_plus_release: Number((initial + releaseDelta).toFixed(2)),
    operational_delta: Number(allOperationalDelta.toFixed(2)),
    candidate_initial_plus_operational: Number((initial + allOperationalDelta).toFixed(2)),
    last_available_balance_row: lastAvailable
  };
}

async function runProbe() {
  const account = await getAccount();
  const configResult = await raw("/v1/account/release_report/config", account);
  const listResult = await raw("/v1/account/release_report/list", account);

  const config = configResult.response.ok && configResult.data && typeof configResult.data === "object"
    ? {
        file_name_prefix: configResult.data.file_name_prefix || null,
        display_timezone: configResult.data.display_timezone || null,
        separator: configResult.data.separator || null,
        frequency: configResult.data.frequency || null,
        scheduled: configResult.data.scheduled ?? null,
        columns: Array.isArray(configResult.data.columns) ? configResult.data.columns : []
      }
    : null;

  const reports = Array.isArray(listResult.data)
    ? listResult.data.slice(0, 10).map(row => ({
        id: row?.id || null,
        report_id: row?.report_id || null,
        status: row?.status || null,
        file_name: row?.file_name || null,
        begin_date: row?.begin_date || null,
        end_date: row?.end_date || null,
        generation_date: row?.generation_date || null,
        last_modified: row?.last_modified || null,
        format: row?.format || null,
        created_from: row?.created_from || null
      }))
    : [];

  let csvAnalysis = null;
  const downloadable = reports.find(r => r.file_name && String(r.format || "CSV").toUpperCase() === "CSV");
  if (downloadable) {
    const download = await raw(`/v1/account/release_report/${encodeURIComponent(downloadable.file_name)}`, account, "text/csv");
    csvAnalysis = {
      http: download.response.status,
      file_name: downloadable.file_name,
      begin_date: downloadable.begin_date,
      end_date: downloadable.end_date,
      ...(download.response.ok ? analyzeReleaseCsv(download.text, config?.separator || ",") : {})
    };
  }

  const result = {
    config_http: configResult.response.status,
    list_http: listResult.response.status,
    config,
    reports,
    csv_analysis: csvAnalysis
  };
  console.log("[MP Release Report Analysis]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/reports/access", async (req, res) => {
  try { res.json({ sucesso: true, ...(await runProbe()) }); }
  catch (error) { res.status(500).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => runProbe().catch(error => console.warn("[MP Release Report Analysis] probe:", error.message)), 9000);
startup.unref?.();

module.exports = router;
