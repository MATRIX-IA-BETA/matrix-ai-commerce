const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const MATRIX_KEY = "mp_available_balance";
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const REPORT_FRESH_MS = 60 * 1000;
const FORCE_GUARD_MS = 20 * 1000;
const BACKGROUND_SYNC_MS = 2 * 60 * 1000;
const POLL_MS = 1200;
const POLL_TIMEOUT_MS = 35 * 1000;

let syncInFlight = null;
let lastResult = null;
let lastSyncAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isoSeconds = date => new Date(date).toISOString().replace(/\.\d{3}Z$/, "Z");

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  if (!data?.access_token) {
    const err = new Error("Mercado Pago OAuth não conectado.");
    err.code = "MP_AUTH_REQUIRED";
    throw err;
  }
  return data;
}

async function mpRequest(path, account, options = {}, expectJson = true) {
  const response = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      Accept: expectJson ? "application/json" : "text/csv",
      ...(options.body != null ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
      Authorization: `Bearer ${account.access_token}`
    },
    signal: AbortSignal.timeout(25000)
  });
  const text = await response.text();
  let data = null;
  if (expectJson) {
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  }
  return { response, data, text };
}

async function mpJson(path, account, options = {}, label = "Mercado Pago") {
  const result = await mpRequest(path, account, options, true);
  if (!result.response.ok) {
    const detail = result.data?.message || result.data?.error || result.data?.cause?.[0]?.description || "erro";
    const err = new Error(`${label} HTTP ${result.response.status}: ${detail}`);
    err.httpStatus = result.response.status;
    throw err;
  }
  return result.data;
}

function parseCsv(text, separator = ",") {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      row.push(cell); cell = ""; continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some(value => String(value).length)) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(value => String(value).length)) rows.push(row);
  }
  return rows;
}

function amount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = /^-?\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function analyzeCsv(text, separator) {
  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");
  const headers = rows[0].map(value => String(value || "").trim().toUpperCase());
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  for (const key of ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"]) {
    if (index[key] == null) throw new Error(`Relatório de Liberações sem ${key}.`);
  }

  let initial = 0;
  let totalDelta = 0;
  let operationalDelta = 0;
  let totalRows = 0;
  let initialRows = 0;
  const types = {};

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const type = String(values[index.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;
    const credit = amount(values[index.NET_CREDIT_AMOUNT]);
    const debit = amount(values[index.NET_DEBIT_AMOUNT]);
    const delta = credit - debit;
    types[type] = (types[type] || 0) + 1;

    if (type === "initial_available_balance") {
      initial += delta;
      initialRows += 1;
      continue;
    }
    if (type === "total") {
      totalDelta += delta;
      totalRows += 1;
      continue;
    }
    if (type === "available_balance" || type === "subtotal") continue;
    operationalDelta += delta;
  }

  if (!initialRows) throw new Error("Relatório sem saldo inicial.");
  const movementDelta = totalRows ? totalDelta : operationalDelta;
  return {
    available_balance: Number((initial + movementDelta).toFixed(2)),
    initial_available_balance: Number(initial.toFixed(2)),
    movement_delta: Number(movementDelta.toFixed(2)),
    calculation: totalRows ? "initial_plus_total" : "initial_plus_operations",
    rows: rows.length - 1,
    types
  };
}

async function getConfig(account) {
  const config = await mpJson("/v1/account/release_report/config", account, {}, "Configuração do relatório");
  return {
    separator: typeof config?.separator === "string" && config.separator.length ? config.separator : ","
  };
}

async function listReports(account) {
  const rows = await mpJson("/v1/account/release_report/list", account, {}, "Lista de relatórios");
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row?.file_name && String(row?.format || "CSV").toUpperCase() === "CSV")
    .sort((a, b) => new Date(b?.end_date || b?.generation_date || 0) - new Date(a?.end_date || a?.generation_date || 0));
}

function reportFresh(report) {
  const end = new Date(report?.end_date || 0).getTime();
  return Number.isFinite(end) && end > 0 && Date.now() - end <= REPORT_FRESH_MS;
}

async function createReport(account) {
  const endDate = isoSeconds(new Date());
  const beginDate = isoSeconds(Date.now() - LOOKBACK_MS);
  const payload = { begin_date: beginDate, end_date: endDate };
  const query = `?begin_date=${encodeURIComponent(beginDate)}&end_date=${encodeURIComponent(endDate)}`;

  // O MP já respondeu 400 dizendo que não recebeu begin_date mesmo com JSON.
  // Enviamos nos dois formatos para tolerar a variação do backend sem perder precisão.
  const result = await mpRequest(`/v1/account/release_report${query}`, account, {
    method: "POST",
    body: JSON.stringify(payload)
  }, true);

  if (!result.response.ok && result.response.status !== 202) {
    const detail = result.data?.message || result.data?.error || "erro";
    throw new Error(`Criação do relatório HTTP ${result.response.status}: ${detail}`);
  }

  const task = result.data || {};
  const taskId = task.id;
  if (!taskId) throw new Error("Mercado Pago não retornou o id da tarefa do relatório.");
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let status = null;
    try {
      status = await mpJson(`/v1/account/release_report/task/${encodeURIComponent(taskId)}`, account, {}, "Tarefa do relatório");
    } catch (error) {
      if (error.httpStatus !== 404) throw error;
    }

    if (status?.file_name) return { ...status, task_id: taskId };
    const state = String(status?.status || "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(state)) {
      throw new Error(`Relatório falhou com status ${state}.`);
    }

    const reports = await listReports(account);
    const exact = reports.find(row => String(row?.id) === String(taskId) || String(row?.report_id) === String(taskId));
    if (exact?.file_name) return { ...exact, task_id: taskId };

    const near = reports.find(row => {
      const end = new Date(row?.end_date || 0).getTime();
      return Number.isFinite(end) && Math.abs(end - new Date(endDate).getTime()) <= 2 * 60 * 1000;
    });
    if (near?.file_name) return { ...near, task_id: taskId };
  }

  const err = new Error(`Relatório ainda está processando (task ${taskId}).`);
  err.code = "MP_REPORT_PENDING";
  throw err;
}

async function resolveReport(account) {
  const reports = await listReports(account);
  if (reports[0] && reportFresh(reports[0])) return { ...reports[0], reused: true };
  return { ...(await createReport(account)), reused: false };
}

async function downloadAndAnalyze(account, report, separator) {
  if (!report?.file_name) throw new Error("Relatório sem file_name.");
  const result = await mpRequest(`/v1/account/release_report/${encodeURIComponent(report.file_name)}`, account, {}, false);
  if (!result.response.ok) throw new Error(`Download do relatório HTTP ${result.response.status}.`);
  return analyzeCsv(result.text, separator);
}

async function saveBalance(account, report, analysis) {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from("financial_accounts")
    .select("id,name,source,metadata")
    .eq("account_type", "asset");
  if (error) throw new Error(error.message);

  const isMp = row => row?.metadata?.matrix_key === MATRIX_KEY || /mercado pago/i.test(String(row?.metadata?.institution || row?.name || ""));
  const existing = (rows || []).find(isMp) || null;
  const metadata = {
    ...(existing?.metadata || {}),
    matrix_key: MATRIX_KEY,
    institution: "Mercado Pago Empresas",
    balance_source: "mercadopago_release_report",
    balance_provider: "mercadopago_api",
    available_balance: analysis.available_balance,
    initial_available_balance: analysis.initial_available_balance,
    movement_delta: analysis.movement_delta,
    calculation: analysis.calculation,
    report_file_name: report.file_name || null,
    report_begin_at: report.begin_date || null,
    report_end_at: report.end_date || null,
    report_rows: analysis.rows,
    mp_user_id: String(account.user_id || account.account_id || ""),
    pluggy_disabled_for_balance: true,
    last_synced_at: now
  };

  const record = {
    name: "Mercado Pago Empresas",
    account_type: "asset",
    category: "Banco",
    source: "mercadopago",
    current_balance: analysis.available_balance,
    include_in_total: true,
    active: true,
    metadata,
    updated_at: now
  };

  let accountId = existing?.id || null;
  if (accountId) {
    const { error: updateError } = await supabase.from("financial_accounts").update(record).eq("id", accountId);
    if (updateError) throw new Error(updateError.message);
  } else {
    const { data: inserted, error: insertError } = await supabase.from("financial_accounts").insert(record).select("id").single();
    if (insertError) throw new Error(insertError.message);
    accountId = inserted?.id || null;
  }

  for (const row of rows || []) {
    if (!row?.id || row.id === accountId || !isMp(row)) continue;
    await supabase.from("financial_accounts").update({ include_in_total: false, active: false, updated_at: now }).eq("id", row.id);
  }

  return now;
}

async function runSync() {
  const account = await getAccount();
  const [config, report] = await Promise.all([getConfig(account), resolveReport(account)]);
  const analysis = await downloadAndAnalyze(account, report, config.separator);
  const syncedAt = await saveBalance(account, report, analysis);
  lastSyncAt = Date.now();
  lastResult = {
    saldo_disponivel: analysis.available_balance,
    saldo_inicial: analysis.initial_available_balance,
    variacao: analysis.movement_delta,
    calculo: analysis.calculation,
    fonte: "mercadopago_release_report",
    relatorio: report.file_name || null,
    fim_relatorio: report.end_date || null,
    atualizado_em: syncedAt
  };
  console.log("[Mercado Pago Saldo Direto] sincronizado:", lastResult);
  return lastResult;
}

async function sync(force = false) {
  if (syncInFlight) return syncInFlight;
  const guard = force ? FORCE_GUARD_MS : REPORT_FRESH_MS;
  if (lastResult && Date.now() - lastSyncAt < guard) return lastResult;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res, next) => {
  try { await sync(true); }
  catch (error) { console.warn("[Mercado Pago Saldo Direto] pré-sync:", error.message); }
  next();
});

router.post("/api/finance/mercadopago/balance/sync", async (req, res) => {
  try { res.json({ sucesso: true, ...(await sync(true)) }); }
  catch (error) {
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message, saldo_anterior_preservado: true });
  }
});

router.get("/api/finance/mercadopago/balance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,source,metadata,updated_at")
      .contains("metadata", { matrix_key: MATRIX_KEY })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, conta: data || null, ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync(true).catch(error => console.warn("[Mercado Pago Saldo Direto] inicial:", error.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Mercado Pago Saldo Direto] periódico:", error.message)), BACKGROUND_SYNC_MS);
interval.unref?.();

module.exports = router;
