const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const PAGE_SIZE = 100;
const LOOKBACK_DAYS = 180;
const REPORT_LOOKBACK_DAYS = 4;
const REPORT_SEARCH_DAYS = 2;
const REPORT_STALE_MS = 4 * 60 * 1000;
const REPORT_REQUEST_GUARD_MS = 2 * 60 * 1000;
const AUTO_SYNC_MS = 60 * 1000;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let lastReportRequestAt = 0;
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
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = /^-?\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function analyzeReport(text, separator, report) {
  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");
  const headers = rows[0].map(v => String(v || "").trim().toUpperCase());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  for (const key of ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"]) {
    if (idx[key] == null) throw new Error(`Relatório sem ${key}.`);
  }

  let initial = 0, initialRows = 0, totalDelta = 0, totalRows = 0, opsDelta = 0;
  const releasedIds = new Set();
  const releasedRefs = new Set();
  const types = {};

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const type = String(values[idx.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;
    types[type] = (types[type] || 0) + 1;
    const delta = csvAmount(values[idx.NET_CREDIT_AMOUNT]) - csvAmount(values[idx.NET_DEBIT_AMOUNT]);
    if (type === "initial_available_balance") { initial += delta; initialRows++; continue; }
    if (type === "total") { totalDelta += delta; totalRows++; continue; }
    if (type === "available_balance" || type === "subtotal") continue;
    opsDelta += delta;
    if (type === "release") {
      if (idx.SOURCE_ID != null) {
        const id = String(values[idx.SOURCE_ID] || "").trim();
        if (id) releasedIds.add(id);
      }
      if (idx.EXTERNAL_REFERENCE != null) {
        const ref = String(values[idx.EXTERNAL_REFERENCE] || "").trim();
        if (ref) releasedRefs.add(ref);
      }
    }
  }
  if (!initialRows) throw new Error("Relatório sem saldo inicial.");
  const movement = totalRows ? totalDelta : opsDelta;
  return {
    available_balance: money(initial + movement),
    initial_available_balance: money(initial),
    movement_delta: money(movement),
    rows: rows.length - 1,
    headers, types, releasedIds, releasedRefs,
    begin_at: report.begin_date || null,
    end_at: report.end_date || null
  };
}

function usableReport(report) {
  if (!report?.file_name) return false;
  if (report?.is_reserve === true || String(report?.is_reserve).toLowerCase() === "true") return false;
  if (/^reserve-/i.test(String(report.file_name))) return false;
  const subtype = String(report?.sub_type || report?.model || "release").toLowerCase();
  return subtype === "release";
}

function reportEnd(report) { return new Date(report?.end_date || 0).getTime(); }
function reportCreated(report) { return new Date(report?.date_created || report?.generation_date || 0).getTime(); }

async function searchReports(account) {
  const now = new Date();
  const begin = new Date(now.getTime() - REPORT_SEARCH_DAYS * 86400000);
  const q = new URLSearchParams({
    range: "date_created",
    range_begin_date: isoSeconds(begin),
    range_end_date: isoSeconds(new Date(now.getTime() + 5 * 60 * 1000)),
    format: "CSV",
    limit: "100",
    offset: "0"
  });
  const data = await json(`/v1/account/release_report/search?${q}`, account);
  return (Array.isArray(data?.results) ? data.results : [])
    .filter(usableReport)
    .sort((a, b) => Math.max(reportEnd(b), reportCreated(b)) - Math.max(reportEnd(a), reportCreated(a)));
}

async function reportSeparator(account) {
  try {
    const config = await json("/v1/account/release_report/config", account);
    return typeof config?.separator === "string" && config.separator.length ? config.separator : ",";
  } catch (_) { return ","; }
}

async function downloadReport(account, report, separator) {
  const result = await request(`/v1/account/release_report/${encodeURIComponent(report.file_name)}`, account, {}, false);
  return analyzeReport(result.text, separator, report);
}

async function requestNewReport(account) {
  if (Date.now() - lastReportRequestAt < REPORT_REQUEST_GUARD_MS) return null;
  lastReportRequestAt = Date.now();
  const end = new Date();
  const begin = new Date(end.getTime() - REPORT_LOOKBACK_DAYS * 86400000);
  const result = await json("/v1/account/release_report", account, {
    method: "POST",
    body: JSON.stringify({ begin_date: isoSeconds(begin), end_date: isoSeconds(end) })
  });
  console.log("[Financeiro MP V4] novo relatório solicitado:", JSON.stringify({ task: result?.id || null, begin: isoSeconds(begin), end: isoSeconds(end) }));
  return result;
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
  return [payment?.external_reference, payment?.order?.id, payment?.order_id]
    .filter(v => v != null).map(String).find(v => /^200\d{10,}$/.test(v)) || null;
}

async function pendingPayments(account, now) {
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
  const held = rows.filter(p => String(p?.money_release_status || "").toLowerCase() === "released" && Boolean(orderReference(p)));
  const excluded = rows.filter(p => String(p?.money_release_status || "").toLowerCase() === "released" && !orderReference(p));
  return { held, excluded };
}

function reconcilePending(pending, analysis, now) {
  const begin = new Date(analysis.begin_at || 0).getTime();
  const releasedIds = analysis.releasedIds;
  const releasedRefs = analysis.releasedRefs;
  const included = [], future = [], overdueIncluded = [], excludedReleased = [], excludedOld = [];
  for (const p of pending) {
    const id = String(p?.id || "");
    const ref = String(p?.external_reference || p?.order?.id || p?.order_id || "");
    const release = new Date(p?.money_release_date || 0).getTime();
    if (Number.isFinite(release) && release > now.getTime()) { included.push(p); future.push(p); continue; }
    if (releasedIds.has(id) || (ref && releasedRefs.has(ref))) { excludedReleased.push(p); continue; }
    if (Number.isFinite(begin) && begin > 0 && Number.isFinite(release) && release > 0 && release < begin) { excludedOld.push(p); continue; }
    included.push(p); overdueIncluded.push(p);
  }
  return {
    included,
    totals: {
      all_pending: sumNet(pending), included: sumNet(included), future: sumNet(future),
      overdue_included: sumNet(overdueIncluded), excluded_released: sumNet(excludedReleased), excluded_old: sumNet(excludedOld)
    },
    counts: {
      all_pending: pending.length, included: included.length, future: future.length,
      overdue_included: overdueIncluded.length, excluded_released: excludedReleased.length, excluded_old: excludedOld.length
    }
  };
}

async function saveAccount(key, name, source, category, balance, metadata) {
  let query = supabase.from("financial_accounts").select("id,metadata");
  if (source === "mercadolivre") query = query.eq("source", "mercadolivre").contains("metadata", { matrix_key: key });
  else query = query.contains("metadata", { matrix_key: key });
  const { data: existing, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const record = {
    name, account_type: "asset", category, source, current_balance: money(balance), include_in_total: true, active: true,
    metadata: { ...(existing?.metadata || {}), matrix_key: key, ...metadata }, updated_at: new Date().toISOString()
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
  const reports = await searchReports(account);
  const report = reports[0] || null;
  const reportAge = report ? now.getTime() - reportEnd(report) : Infinity;

  if (!report || reportAge > REPORT_STALE_MS) {
    requestNewReport(account).catch(e => console.warn("[Financeiro MP V4] pedido de relatório:", e.message));
  }

  let analysis = null;
  if (report) {
    try { analysis = await downloadReport(account, report, separator); }
    catch (e) { console.warn("[Financeiro MP V4] download/análise do relatório:", e.message); }
  }

  const [pending, heldResult] = await Promise.all([pendingPayments(account, now), heldPayments(account, now)]);
  const heldTotal = sumNet(heldResult.held);
  let receivable, reconciliation = null, definition;

  if (analysis) {
    reconciliation = reconcilePending(pending, analysis, now);
    receivable = reconciliation.totals.included;
    definition = "pending_reconciled_with_release_report_v4";
    await saveAccount("mp_available_balance", "Mercado Pago Empresas", "mercadopago", "Banco", analysis.available_balance, {
      institution: "Mercado Pago Empresas", balance_source: "mercadopago_release_report_v4", balance_provider: "mercadopago_api",
      available_balance: analysis.available_balance, initial_available_balance: analysis.initial_available_balance,
      movement_delta: analysis.movement_delta, report_file_name: report.file_name, report_begin_at: report.begin_date || null,
      report_end_at: report.end_date || null, report_created_at: report.date_created || null, report_rows: analysis.rows,
      pluggy_disabled_for_balance: true, last_synced_at: new Date().toISOString()
    });
  } else {
    const future = pending.filter(p => {
      const ts = new Date(p?.money_release_date || 0).getTime();
      return Number.isFinite(ts) && ts > now.getTime();
    });
    receivable = sumNet(future);
    definition = "future_release_fallback_no_report";
  }

  const syncedAt = new Date().toISOString();
  const excludedHeld = heldResult.excluded.map(p => ({ id: p?.id, ref: p?.external_reference || p?.order?.id || p?.order_id || null, net: netValue(p) }));
  const common = { synced_at: syncedAt, mp_user_id: String(account.user_id || account.account_id || ""), report_file_name: report?.file_name || null };

  await saveAccount("ml_receivable", "Mercado Livre — A receber", "mercadolivre", "Mercado Livre a receber", receivable, {
    ...common, component: "receivable", definition, all_pending_total: sumNet(pending), all_pending_payments: pending.length,
    reconciliation: reconciliation?.totals || null, reconciliation_counts: reconciliation?.counts || null
  });
  await saveAccount("ml_claims_held", "Mercado Livre — Retido em reclamações", "mercadolivre", "Mercado Livre retido em reclamações", heldTotal, {
    ...common, component: "claims_held", definition: "in_mediation+released+marketplace_order", held_payments: heldResult.held.length,
    excluded_non_sale_held: excludedHeld
  });

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable,
    retido_reclamacoes: heldTotal,
    saldo_disponivel: analysis?.available_balance ?? null,
    relatorio: report?.file_name || null,
    idade_relatorio_seg: Number.isFinite(reportAge) ? Math.round(reportAge / 1000) : null,
    definicao_a_receber: definition,
    reconciliacao: reconciliation?.totals || null,
    contagens: reconciliation?.counts || null,
    excluidos_retido_nao_venda: excludedHeld,
    atualizado_em: syncedAt
  };
  console.log("[Financeiro MP V4] sincronizado:", JSON.stringify(lastResult));
  if (analysis) console.log("[Financeiro MP V4] relatório:", JSON.stringify({ arquivo: report.file_name, begin: report.begin_date, end: report.end_date, saldo: analysis.available_balance, initial: analysis.initial_available_balance, movement: analysis.movement_delta, released_ids: analysis.releasedIds.size, rows: analysis.rows, types: analysis.types }));
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
    console.error("[Financeiro MP V4] sync:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message });
  }
});
router.get("/api/finance/mercadolivre/status", (req, res) => res.json({ sucesso: true, ultima_sincronizacao: lastResult }));

const startup = setTimeout(() => sync(true).catch(e => console.warn("[Financeiro MP V4] inicial:", e.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(e => console.warn("[Financeiro MP V4] periódico:", e.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;