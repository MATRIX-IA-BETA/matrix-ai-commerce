const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const PAGE_SIZE = 100;
const LOOKBACK_DAYS = 180;
const MEDIATION_LOOKBACK_DAYS = 365;
const REPORT_LOOKBACK_DAYS = 4;
const REPORT_STALE_MS = 4 * 60 * 1000;
const REPORT_REQUEST_GUARD_MS = 2 * 60 * 1000;
const AUTO_SYNC_MS = 60 * 1000;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let lastReportRequestAt = 0;
let lastReportTaskId = null;
let gate = Promise.resolve();
let lastRequestAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const money = value => Number((Number(value) || 0).toFixed(2));
const finiteOrNull = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const isoSeconds = value => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  if (!data?.access_token) {
    const e = new Error("Conta Mercado Pago não conectada.");
    e.code = "MP_AUTH_REQUIRED";
    throw e;
  }
  return data;
}

async function waitSlot() {
  const next = gate.then(async () => {
    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
  });
  gate = next.catch(() => {});
  return next;
}

async function request(path, account, options = {}, expectJson = true) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await waitSlot();
    try {
      const response = await fetch(`${MP_API}${path}`, {
        ...options,
        headers: {
          Accept: expectJson ? "application/json" : "text/csv",
          ...(options.body != null ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
          Authorization: `Bearer ${account.access_token}`
        },
        signal: AbortSignal.timeout(30000)
      });
      const text = await response.text();
      let data = null;
      if (expectJson) {
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      }
      if (response.ok || response.status === 202) return { response, data, text };
      const e = new Error(`Mercado Pago HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
      e.httpStatus = response.status;
      lastError = e;
      if (response.status !== 429 && response.status < 500) throw e;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 250 : 900 * (2 ** attempt));
    } catch (error) {
      lastError = error;
      if (error.httpStatus && error.httpStatus !== 429 && error.httpStatus < 500) throw error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(800 * (2 ** attempt));
    }
  }
  throw lastError || new Error("Falha no Mercado Pago.");
}

async function json(path, account, options = {}) {
  return (await request(path, account, options, true)).data;
}

async function pagedSearch(account, params, label, maxRows = 5000) {
  const rows = [];
  let offset = 0;
  let total = null;
  while (offset < maxRows) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE_SIZE), offset: String(offset) });
    const data = await json(`/v1/payments/search?${q}`, account);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < PAGE_SIZE || (Number.isFinite(total) && offset >= total)) break;
  }
  if (offset >= maxRows && Number.isFinite(total) && total > maxRows) {
    throw new Error(`${label}: mais de ${maxRows} pagamentos.`);
  }
  return rows;
}

function collectorId(payment) {
  return String(payment?.collector?.id ?? payment?.collector_id ?? payment?.collector?.user_id ?? "");
}

function netValue(payment) {
  const exact = finiteOrNull(payment?.transaction_details?.net_received_amount);
  if (exact != null) return money(Math.max(0, exact));
  const gross = Math.max(0, Number(payment?.transaction_amount) || 0);
  const refunded = Math.max(0, Number(payment?.transaction_amount_refunded) || 0);
  const fees = (Array.isArray(payment?.fee_details) ? payment.fee_details : [])
    .filter(fee => !fee?.fee_payer || String(fee.fee_payer).toLowerCase() === "collector")
    .reduce((sum, fee) => sum + Math.abs(Number(fee?.amount) || 0), 0);
  return money(Math.max(0, gross - refunded - fees));
}

function sumNet(rows) {
  return money((rows || []).reduce((sum, payment) => sum + netValue(payment), 0));
}

async function approvedPendingCollected(account, now) {
  const begin = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);
  const sellerId = String(account.user_id || account.account_id || "");
  const rows = await pagedSearch(account, {
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: begin.toISOString(),
    end_date: now.toISOString(),
    status: "approved"
  }, "A receber Mercado Pago");
  return rows.filter(payment =>
    String(payment?.money_release_status || "").toLowerCase() === "pending" &&
    collectorId(payment) === sellerId
  );
}

async function mediationCollected(account, now) {
  const begin = new Date(now.getTime() - MEDIATION_LOOKBACK_DAYS * 86400000);
  const sellerId = String(account.user_id || account.account_id || "");
  const rows = await pagedSearch(account, {
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: begin.toISOString(),
    end_date: now.toISOString(),
    status: "in_mediation"
  }, "Mediações Mercado Pago");
  const ours = rows.filter(payment => collectorId(payment) === sellerId);
  return {
    pending: ours.filter(payment => String(payment?.money_release_status || "").toLowerCase() === "pending"),
    released: ours.filter(payment => String(payment?.money_release_status || "").toLowerCase() === "released")
  };
}

function parseCsv(text, separator = ",") {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (quoted && src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) { row.push(cell); cell = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(value => String(value).length)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(value => String(value).length)) rows.push(row);
  }
  return rows;
}

function csvAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = /^-?\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function analyzeReport(text, separator, report) {
  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");
  const headers = rows[0].map(value => String(value || "").trim().toUpperCase());
  const idx = Object.fromEntries(headers.map((header, index) => [header, index]));
  for (const key of ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"]) {
    if (idx[key] == null) throw new Error(`Relatório sem ${key}.`);
  }

  let initial = 0;
  let initialRows = 0;
  let totalDelta = 0;
  let totalRows = 0;
  let operationsDelta = 0;
  let lastBalanceAmount = null;
  const types = {};

  for (let index = 1; index < rows.length; index++) {
    const values = rows[index];
    const type = String(values[idx.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;
    types[type] = (types[type] || 0) + 1;
    const delta = csvAmount(values[idx.NET_CREDIT_AMOUNT]) - csvAmount(values[idx.NET_DEBIT_AMOUNT]);
    if (idx.BALANCE_AMOUNT != null) {
      const rawBalance = String(values[idx.BALANCE_AMOUNT] ?? "").trim();
      if (rawBalance) {
        const parsedBalance = csvAmount(rawBalance);
        if (Number.isFinite(parsedBalance)) lastBalanceAmount = parsedBalance;
      }
    }
    if (type === "initial_available_balance") { initial += delta; initialRows++; continue; }
    if (type === "total") { totalDelta += delta; totalRows++; continue; }
    if (type === "available_balance" || type === "subtotal") continue;
    operationsDelta += delta;
  }

  if (!initialRows && lastBalanceAmount == null) throw new Error("Relatório sem saldo inicial nem BALANCE_AMOUNT.");
  const movement = totalRows ? totalDelta : operationsDelta;
  const calculated = money(initial + movement);
  const available = lastBalanceAmount != null ? money(lastBalanceAmount) : calculated;
  return {
    available_balance: available,
    calculated_available_balance: calculated,
    initial_available_balance: money(initial),
    movement_delta: money(movement),
    rows: rows.length - 1,
    headers,
    types,
    begin_at: report?.begin_date || null,
    end_at: report?.end_date || null
  };
}

function usableReport(report) {
  if (!report?.file_name) return false;
  if (report?.is_reserve === true || String(report?.is_reserve).toLowerCase() === "true") return false;
  if (/^reserve-/i.test(String(report.file_name))) return false;
  const subtype = String(report?.sub_type || report?.report_type || report?.model || "release").toLowerCase();
  return subtype === "release";
}

function reportEnd(report) {
  return new Date(report?.end_date || report?.generation_date || report?.last_modified || 0).getTime();
}

async function searchReports(account) {
  const data = await json("/v1/account/release_report/search?limit=100&offset=0", account);
  return (Array.isArray(data?.results) ? data.results : [])
    .filter(usableReport)
    .sort((a, b) => reportEnd(b) - reportEnd(a));
}

async function searchReportById(account, reportId) {
  if (!reportId) return null;
  const data = await json(`/v1/account/release_report/search?id=${encodeURIComponent(reportId)}&limit=10&offset=0`, account);
  return (Array.isArray(data?.results) ? data.results : []).find(usableReport) || null;
}

async function reportSeparator(account) {
  try {
    const config = await json("/v1/account/release_report/config", account);
    return typeof config?.separator === "string" && config.separator.length ? config.separator : ",";
  } catch (_) {
    return ",";
  }
}

async function downloadReport(account, report, separator) {
  const result = await request(`/v1/account/release_report/${encodeURIComponent(report.file_name)}`, account, {}, false);
  return analyzeReport(result.text, separator, report);
}

async function requestNewReport(account) {
  if (lastReportTaskId) return lastReportTaskId;
  if (Date.now() - lastReportRequestAt < REPORT_REQUEST_GUARD_MS) return null;
  lastReportRequestAt = Date.now();
  const end = new Date();
  const begin = new Date(end.getTime() - REPORT_LOOKBACK_DAYS * 86400000);
  const result = await json("/v1/account/release_report", account, {
    method: "POST",
    body: JSON.stringify({ begin_date: isoSeconds(begin), end_date: isoSeconds(end) })
  });
  lastReportTaskId = result?.id ? String(result.id) : null;
  console.log("[Financeiro MP V5] novo relatório solicitado:", JSON.stringify({ task: lastReportTaskId, begin: isoSeconds(begin), end: isoSeconds(end) }));
  return lastReportTaskId;
}

async function resolveReportTask(account) {
  if (!lastReportTaskId) return null;
  let task;
  try {
    task = await json(`/v1/account/release_report/task/${encodeURIComponent(lastReportTaskId)}`, account);
  } catch (error) {
    if (error.httpStatus === 404) lastReportTaskId = null;
    throw error;
  }
  const status = String(task?.status || "").toLowerCase();
  if (usableReport(task)) {
    lastReportTaskId = null;
    return task;
  }
  if (status === "processed" && task?.report_id) {
    const report = await searchReportById(account, task.report_id);
    if (report) {
      lastReportTaskId = null;
      return report;
    }
  }
  if (["failed", "error", "cancelled", "canceled"].includes(status)) lastReportTaskId = null;
  return null;
}

async function findBestReport(account) {
  let reports = [];
  try { reports = await searchReports(account); }
  catch (error) { console.warn("[Financeiro MP V5] busca de relatórios:", error.message); }
  let report = reports[0] || null;
  if (lastReportTaskId) {
    try {
      const taskReport = await resolveReportTask(account);
      if (taskReport && (!report || reportEnd(taskReport) >= reportEnd(report))) report = taskReport;
    } catch (error) {
      console.warn("[Financeiro MP V5] consulta da tarefa de relatório:", error.message);
    }
  }
  return report;
}

async function saveAccount(key, name, source, category, balance, metadata) {
  let query = supabase.from("financial_accounts").select("id,metadata");
  if (source === "mercadolivre") query = query.eq("source", "mercadolivre").contains("metadata", { matrix_key: key });
  else query = query.contains("metadata", { matrix_key: key });
  const { data: existing, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const record = {
    name,
    account_type: "asset",
    category,
    source,
    current_balance: money(balance),
    include_in_total: true,
    active: true,
    metadata: { ...(existing?.metadata || {}), matrix_key: key, ...metadata },
    updated_at: new Date().toISOString()
  };
  if (existing?.id) {
    const { error: updateError } = await supabase.from("financial_accounts").update(record).eq("id", existing.id);
    if (updateError) throw new Error(updateError.message);
  } else {
    const { error: insertError } = await supabase.from("financial_accounts").insert(record);
    if (insertError) throw new Error(insertError.message);
  }
}

async function runSync() {
  const account = await getAccount();
  const now = new Date();
  const sellerId = String(account.user_id || account.account_id || "");

  const [approvedPending, mediation] = await Promise.all([
    approvedPendingCollected(account, now),
    mediationCollected(account, now)
  ]);

  const approvedPendingTotal = sumNet(approvedPending);
  const mediationPendingTotal = sumNet(mediation.pending);
  const receivable = money(approvedPendingTotal + mediationPendingTotal);
  const heldTotal = sumNet(mediation.released);

  let report = await findBestReport(account);
  let analysis = null;
  const reportAge = report ? now.getTime() - reportEnd(report) : Infinity;

  if (!report || reportAge > REPORT_STALE_MS) {
    try { await requestNewReport(account); }
    catch (error) { console.warn("[Financeiro MP V5] pedido de relatório:", error.message); }
  }

  if (report) {
    try {
      const separator = await reportSeparator(account);
      analysis = await downloadReport(account, report, separator);
    } catch (error) {
      console.warn("[Financeiro MP V5] download/análise do relatório:", error.message);
    }
  }

  const syncedAt = new Date().toISOString();
  const common = {
    synced_at: syncedAt,
    mp_user_id: sellerId,
    source_api: "mercadopago_payments_api",
    report_file_name: report?.file_name || null
  };

  await saveAccount("ml_receivable", "Mercado Livre — A receber", "mercadolivre", "Mercado Livre a receber", receivable, {
    ...common,
    component: "receivable",
    definition: "approved_pending_collected_by_account+in_mediation_pending_collected_by_account",
    approved_pending_total: approvedPendingTotal,
    approved_pending_payments: approvedPending.length,
    mediation_pending_total: mediationPendingTotal,
    mediation_pending_payments: mediation.pending.length
  });

  await saveAccount("ml_claims_held", "Mercado Livre — Retido em reclamações", "mercadolivre", "Mercado Livre retido em reclamações", heldTotal, {
    ...common,
    component: "claims_held",
    definition: "in_mediation_released_collected_by_account",
    held_payments: mediation.released.length
  });

  if (analysis) {
    await saveAccount("mp_available_balance", "Mercado Pago Empresas", "mercadopago", "Banco", analysis.available_balance, {
      institution: "Mercado Pago Empresas",
      balance_source: "mercadopago_release_report_v5",
      balance_provider: "mercadopago_api",
      available_balance: analysis.available_balance,
      calculated_available_balance: analysis.calculated_available_balance,
      initial_available_balance: analysis.initial_available_balance,
      movement_delta: analysis.movement_delta,
      report_file_name: report.file_name,
      report_begin_at: report.begin_date || null,
      report_end_at: report.end_date || null,
      report_created_at: report.date_created || report.generation_date || null,
      report_rows: analysis.rows,
      pluggy_disabled_for_balance: true,
      last_synced_at: syncedAt
    });
  }

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable,
    a_receber_aprovado: approvedPendingTotal,
    a_receber_em_mediacao: mediationPendingTotal,
    retido_reclamacoes: heldTotal,
    saldo_disponivel: analysis?.available_balance ?? null,
    relatorio: report?.file_name || null,
    idade_relatorio_seg: Number.isFinite(reportAge) ? Math.round(reportAge / 1000) : null,
    fonte_a_receber: "mercadopago_payments_api_direct",
    fonte_retido: "mercadopago_payments_api_direct",
    fonte_saldo: analysis ? "mercadopago_release_report_v5" : "preservado_ate_relatorio_processar",
    contagens: {
      approved_pending: approvedPending.length,
      mediation_pending: mediation.pending.length,
      mediation_released: mediation.released.length
    },
    atualizado_em: syncedAt
  };
  console.log("[Financeiro MP V5] sincronizado:", JSON.stringify(lastResult));
  if (analysis) console.log("[Financeiro MP V5] relatório:", JSON.stringify({ arquivo: report.file_name, begin: report.begin_date, end: report.end_date, saldo: analysis.available_balance, calculado: analysis.calculated_available_balance, initial: analysis.initial_available_balance, movement: analysis.movement_delta, rows: analysis.rows, types: analysis.types }));
  return lastResult;
}

async function sync(force = false) {
  if (syncInFlight) return syncInFlight;
  if (!force && lastResult && Date.now() - lastSyncAt < AUTO_SYNC_MS) return lastResult;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res) => {
  try { res.json({ sucesso: true, ...(await sync(true)) }); }
  catch (error) {
    console.error("[Financeiro MP V5] sync:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadolivre/status", (req, res) => res.json({ sucesso: true, ultima_sincronizacao: lastResult }));

const startup = setTimeout(() => sync(true).catch(error => console.warn("[Financeiro MP V5] inicial:", error.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Financeiro MP V5] periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
