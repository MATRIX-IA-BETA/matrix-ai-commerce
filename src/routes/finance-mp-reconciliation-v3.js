const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const PAGE_SIZE = 100;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;
const LOOKBACK_DAYS = 180;
const REPORT_LOOKBACK_DAYS = 4;
const REPORT_MAX_AGE_MS = 12 * 60 * 1000;
const AUTO_SYNC_MS = 2 * 60 * 1000;
const REPORT_POLL_MS = 2500;
const REPORT_POLL_TIMEOUT_MS = 3 * 60 * 1000;

let syncInFlight = null;
let reportTaskInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let requestGate = Promise.resolve();
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
  const next = requestGate.then(async () => {
    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
  });
  requestGate = next.catch(() => {});
  return next;
}

async function raw(path, account, options = {}, expectJson = true) {
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
  return (await raw(path, account, options, true)).data;
}

function parseCsv(text, separator = ",") {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) { row.push(cell); cell = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(v => String(v).length)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(v => String(v).length)) rows.push(row);
  }
  return rows;
}

function csvAmount(value) {
  const rawValue = String(value ?? "").trim();
  if (!rawValue) return 0;
  const normalized = /^-?\d+,\d+$/.test(rawValue) ? rawValue.replace(",", ".") : rawValue;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function analyzeReport(text, separator, report) {
  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");
  const headers = rows[0].map(v => String(v || "").trim().toUpperCase());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  for (const key of ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"]) {
    if (idx[key] == null) throw new Error(`Relatório sem a coluna ${key}.`);
  }

  let initial = 0, initialRows = 0, totalDelta = 0, totalRows = 0, operationalDelta = 0;
  const releasedIds = new Set();
  const releasedRefs = new Set();
  const types = {};

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const type = String(values[idx.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;
    types[type] = (types[type] || 0) + 1;
    const credit = csvAmount(values[idx.NET_CREDIT_AMOUNT]);
    const debit = csvAmount(values[idx.NET_DEBIT_AMOUNT]);
    const delta = credit - debit;

    if (type === "initial_available_balance") {
      initial += delta;
      initialRows++;
      continue;
    }
    if (type === "total") {
      totalDelta += delta;
      totalRows++;
      continue;
    }
    if (type === "available_balance" || type === "subtotal") continue;
    operationalDelta += delta;

    if (type === "release") {
      if (idx.SOURCE_ID != null) {
        const source = String(values[idx.SOURCE_ID] || "").trim();
        if (source) releasedIds.add(source);
      }
      if (idx.EXTERNAL_REFERENCE != null) {
        const ref = String(values[idx.EXTERNAL_REFERENCE] || "").trim();
        if (ref) releasedRefs.add(ref);
      }
    }
  }

  if (!initialRows) throw new Error("Relatório sem saldo inicial.");
  const movement = totalRows ? totalDelta : operationalDelta;
  return {
    available_balance: money(initial + movement),
    initial_available_balance: money(initial),
    movement_delta: money(movement),
    rows: rows.length - 1,
    headers,
    types,
    releasedIds,
    releasedRefs,
    begin_at: report?.begin_date || null,
    end_at: report?.end_date || null,
    generation_at: report?.generation_date || report?.last_modified || null
  };
}

function reportTime(report) {
  return new Date(report?.generation_date || report?.last_modified || report?.date_created || 0).getTime();
}
function reportEndTime(report) {
  return new Date(report?.end_date || 0).getTime();
}
function usableReport(report) {
  if (!report?.file_name) return false;
  if (report?.is_reserve === true || String(report?.is_reserve).toLowerCase() === "true") return false;
  if (/^reserve-/i.test(String(report.file_name))) return false;
  if (String(report?.format || "CSV").toUpperCase() !== "CSV") return false;
  const subtype = String(report?.sub_type || "release").toLowerCase();
  return !subtype || subtype === "release";
}

async function listReports(account) {
  const data = await json("/v1/account/release_report/list", account);
  return (Array.isArray(data) ? data : [])
    .filter(usableReport)
    .sort((a, b) => Math.max(reportEndTime(b), reportTime(b)) - Math.max(reportEndTime(a), reportTime(a)));
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
  const result = await raw(`/v1/account/release_report/${encodeURIComponent(report.file_name)}`, account, {}, false);
  return analyzeReport(result.text, separator, report);
}

function reportFreshEnough(report, now = Date.now()) {
  const end = reportEndTime(report);
  return Number.isFinite(end) && end > 0 && now - end >= -60 * 1000 && now - end <= REPORT_MAX_AGE_MS;
}

async function startReportTask(account) {
  if (reportTaskInFlight) return reportTaskInFlight;
  reportTaskInFlight = (async () => {
    const end = new Date();
    const begin = new Date(end.getTime() - REPORT_LOOKBACK_DAYS * 86400000);
    const payload = { begin_date: isoSeconds(begin), end_date: isoSeconds(end) };
    const created = await json("/v1/account/release_report", account, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const taskId = created?.id;
    if (!taskId) throw new Error("Mercado Pago não retornou task-id do relatório.");
    const deadline = Date.now() + REPORT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(REPORT_POLL_MS);
      let task = null;
      try { task = await json(`/v1/account/release_report/task/${encodeURIComponent(taskId)}`, account); }
      catch (error) { if (error.httpStatus !== 404) throw error; }
      if (usableReport(task)) return task;
      const state = String(task?.status || "").toLowerCase();
      if (["failed", "error", "cancelled", "canceled"].includes(state)) throw new Error(`Relatório falhou: ${state}.`);
      const reports = await listReports(account);
      const exact = reports.find(r => String(r?.id) === String(taskId) || String(r?.report_id) === String(taskId));
      if (exact?.file_name) return exact;
    }
    throw new Error(`Relatório ainda processando (task ${taskId}).`);
  })().finally(() => { reportTaskInFlight = null; });
  return reportTaskInFlight;
}

async function pagedSearch(account, params, label, maxRows = 5000) {
  const rows = [];
  let offset = 0, total = null;
  while (offset < maxRows) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE_SIZE), offset: String(offset) });
    const data = await json(`/v1/payments/search?${q}`, account);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < PAGE_SIZE || (Number.isFinite(total) && offset >= total)) break;
  }
  if (offset >= maxRows && Number.isFinite(total) && total > maxRows) throw new Error(`${label}: mais de ${maxRows} pagamentos.`);
  return rows;
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
function sumNet(rows) { return money((rows || []).reduce((sum, p) => sum + netValue(p), 0)); }
function orderReference(payment) {
  const values = [payment?.external_reference, payment?.order?.id, payment?.order_id].filter(v => v != null).map(String);
  return values.find(v => /^200\d{10,}$/.test(v)) || null;
}

async function allPending(account, now) {
  const begin = new Date(now.getTime() - LOOKBACK_DAYS * 86400000);
  const rows = await pagedSearch(account, {
    sort: "date_created", criteria: "desc", range: "date_created",
    begin_date: begin.toISOString(), end_date: now.toISOString(), status: "approved"
  }, "A receber");
  return rows.filter(p => String(p?.money_release_status || "").toLowerCase() === "pending");
}

async function heldPayments(account, now) {
  const begin = new Date(now.getTime() - 365 * 86400000);
  const rows = await pagedSearch(account, {
    sort: "date_created", criteria: "desc", range: "date_created",
    begin_date: begin.toISOString(), end_date: now.toISOString(), status: "in_mediation"
  }, "Retidos");
  const held = rows.filter(p =>
    String(p?.money_release_status || "").toLowerCase() === "released" && Boolean(orderReference(p))
  );
  const excluded = rows.filter(p =>
    String(p?.money_release_status || "").toLowerCase() === "released" && !orderReference(p)
  );
  return { held, excluded };
}

function reconcilePending(pending, reportAnalysis, now) {
  const begin = new Date(reportAnalysis?.begin_at || 0).getTime();
  const end = new Date(reportAnalysis?.end_at || now).getTime();
  const releasedIds = reportAnalysis?.releasedIds || new Set();
  const releasedRefs = reportAnalysis?.releasedRefs || new Set();
  const included = [], excludedReleased = [], excludedOld = [], future = [], overdueIncluded = [];

  for (const payment of pending) {
    const id = String(payment?.id || "");
    const ref = String(payment?.external_reference || payment?.order?.id || payment?.order_id || "");
    const releaseTs = new Date(payment?.money_release_date || 0).getTime();
    const isFuture = Number.isFinite(releaseTs) && releaseTs > now.getTime();
    if (isFuture) {
      included.push(payment); future.push(payment); continue;
    }
    if (releasedIds.has(id) || (ref && releasedRefs.has(ref))) {
      excludedReleased.push(payment); continue;
    }
    if (Number.isFinite(begin) && begin > 0 && Number.isFinite(releaseTs) && releaseTs > 0 && releaseTs < begin) {
      excludedOld.push(payment); continue;
    }
    if (Number.isFinite(end) && end > 0 && Number.isFinite(releaseTs) && releaseTs > end + 5 * 60 * 1000) {
      included.push(payment); future.push(payment); continue;
    }
    included.push(payment); overdueIncluded.push(payment);
  }

  return {
    included,
    future,
    overdueIncluded,
    excludedReleased,
    excludedOld,
    totals: {
      all_pending: sumNet(pending),
      included: sumNet(included),
      future: sumNet(future),
      overdue_included: sumNet(overdueIncluded),
      excluded_released: sumNet(excludedReleased),
      excluded_old: sumNet(excludedOld)
    }
  };
}

async function saveMpBalance(analysis, report) {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase.from("financial_accounts").select("id,name,metadata").eq("account_type", "asset");
  if (error) throw new Error(error.message);
  const isMp = row => row?.metadata?.matrix_key === "mp_available_balance" || /mercado pago/i.test(String(row?.metadata?.institution || row?.name || ""));
  const existing = (rows || []).find(isMp) || null;
  const metadata = {
    ...(existing?.metadata || {}), matrix_key: "mp_available_balance", institution: "Mercado Pago Empresas",
    balance_source: "mercadopago_release_report_v3", balance_provider: "mercadopago_api",
    available_balance: analysis.available_balance, initial_available_balance: analysis.initial_available_balance,
    movement_delta: analysis.movement_delta, report_file_name: report.file_name,
    report_begin_at: report.begin_date || null, report_end_at: report.end_date || null,
    report_generation_at: report.generation_date || report.last_modified || null, report_rows: analysis.rows,
    pluggy_disabled_for_balance: true, last_synced_at: now
  };
  const record = {
    name: "Mercado Pago Empresas", account_type: "asset", category: "Banco", source: "mercadopago",
    current_balance: analysis.available_balance, include_in_total: true, active: true, metadata, updated_at: now
  };
  if (existing?.id) {
    const { error: e } = await supabase.from("financial_accounts").update(record).eq("id", existing.id); if (e) throw new Error(e.message);
  } else {
    const { error: e } = await supabase.from("financial_accounts").insert(record); if (e) throw new Error(e.message);
  }
}

async function saveAsset(key, name, category, balance, metadata) {
  const { data: existing, error } = await supabase.from("financial_accounts").select("id").eq("source", "mercadolivre").contains("metadata", { matrix_key: key }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const record = {
    name, account_type: "asset", category, source: "mercadolivre", current_balance: money(balance),
    include_in_total: true, active: true, metadata: { matrix_key: key, ...metadata }, updated_at: new Date().toISOString()
  };
  if (existing?.id) {
    const { error: e } = await supabase.from("financial_accounts").update(record).eq("id", existing.id); if (e) throw new Error(e.message);
  } else {
    const { error: e } = await supabase.from("financial_accounts").insert(record); if (e) throw new Error(e.message);
  }
}

async function runSync(force = false) {
  const account = await getAccount();
  const now = new Date();
  const separator = await reportSeparator(account);
  let reports = await listReports(account);
  let report = reports[0] || null;

  if (!report || !reportFreshEnough(report, now.getTime())) {
    startReportTask(account)
      .then(() => setTimeout(() => sync(true).catch(e => console.warn("[Financeiro MP V3] pós-relatório:", e.message)), 1000))
      .catch(e => console.warn("[Financeiro MP V3] geração do relatório:", e.message));
  }

  let analysis = null;
  if (report?.file_name) {
    try { analysis = await downloadReport(account, report, separator); }
    catch (e) { console.warn("[Financeiro MP V3] relatório atual não pôde ser usado:", e.message); }
  }

  const [{ held, excluded }, pending] = await Promise.all([heldPayments(account, now), allPending(account, now)]);
  const heldTotal = sumNet(held);
  let receivableRows, receivableMeta;

  if (analysis) {
    const reconciled = reconcilePending(pending, analysis, now);
    receivableRows = reconciled.included;
    receivableMeta = {
      definition: "pending_reconciled_with_release_report",
      reconciliation: reconciled.totals,
      report_file_name: report.file_name,
      report_begin_at: analysis.begin_at,
      report_end_at: analysis.end_at,
      report_released_ids: analysis.releasedIds.size,
      overdue_included_count: reconciled.overdueIncluded.length,
      excluded_released_count: reconciled.excludedReleased.length,
      excluded_old_count: reconciled.excludedOld.length
    };
    await saveMpBalance(analysis, report);
  } else {
    receivableRows = pending.filter(p => {
      const ts = new Date(p?.money_release_date || 0).getTime();
      return Number.isFinite(ts) && ts > now.getTime();
    });
    receivableMeta = { definition: "future_release_fallback_no_report" };
  }

  const receivableTotal = sumNet(receivableRows);
  const syncedAt = new Date().toISOString();
  const common = {
    synced_at: syncedAt,
    mp_user_id: String(account.user_id || account.account_id || ""),
    held_payments: held.length,
    excluded_non_sale_held: excluded.map(p => ({ id: p?.id, ref: p?.external_reference || p?.order?.id || p?.order_id || null, net: netValue(p) }))
  };

  await saveAsset("ml_receivable", "Mercado Livre — A receber", "Mercado Livre a receber", receivableTotal, {
    ...common, ...receivableMeta, component: "receivable", receivable_payments: receivableRows.length, all_pending_payments: pending.length, all_pending_total: sumNet(pending)
  });
  await saveAsset("ml_claims_held", "Mercado Livre — Retido em reclamações", "Mercado Livre retido em reclamações", heldTotal, {
    ...common, component: "claims_held", definition: "in_mediation+released+marketplace_order"
  });

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivableTotal,
    retido_reclamacoes: heldTotal,
    saldo_disponivel: analysis?.available_balance ?? null,
    relatorio: report?.file_name || null,
    relatorio_fresco: Boolean(report && reportFreshEnough(report, now.getTime())),
    pagamentos_a_receber: receivableRows.length,
    pagamentos_retidos: held.length,
    excluidos_retido_nao_venda: excluded.length,
    definicao_a_receber: receivableMeta.definition,
    atualizado_em: syncedAt
  };
  console.log("[Financeiro MP V3] sincronizado:", JSON.stringify(lastResult));
  if (analysis) console.log("[Financeiro MP V3] relatório:", JSON.stringify({
    arquivo: report.file_name, begin: analysis.begin_at, end: analysis.end_at, generation: analysis.generation_at,
    saldo_disponivel: analysis.available_balance, initial: analysis.initial_available_balance, movement: analysis.movement_delta,
    released_ids: analysis.releasedIds.size, rows: analysis.rows, types: analysis.types
  }));
  console.log("[Financeiro MP V3] retido excluído:", JSON.stringify(common.excluded_non_sale_held));
  return lastResult;
}

async function sync(force = false) {
  if (syncInFlight) return syncInFlight;
  if (!force && lastResult && Date.now() - lastSyncAt < AUTO_SYNC_MS) return lastResult;
  syncInFlight = runSync(force).finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res) => {
  try { res.json({ sucesso: true, ...(await sync(true)) }); }
  catch (error) {
    console.error("[Financeiro MP V3] sync:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  res.json({ sucesso: true, ultima_sincronizacao: lastResult, relatorio_em_processamento: Boolean(reportTaskInFlight) });
});

const startup = setTimeout(() => sync(true).catch(e => console.warn("[Financeiro MP V3] inicial:", e.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(e => console.warn("[Financeiro MP V3] periódico:", e.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;