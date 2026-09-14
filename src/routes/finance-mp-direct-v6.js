const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP = "https://api.mercadopago.com";
const AUTO_MS = 60_000;
const PAGE = 100;
const money = v => Number((Number(v) || 0).toFixed(2));
const iso = d => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let inFlight = null;
let last = null;
let lastAt = 0;
let taskId = null;
let taskRequestedAt = 0;
let gate = Promise.resolve();
let lastRequestAt = 0;

async function account() {
  const { data, error } = await supabase.from("marketplace_accounts")
    .select("account_id,user_id,access_token")
    .eq("marketplace", "mercadopago").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) {
    const e = new Error("Mercado Pago não conectado.");
    e.code = "MP_AUTH_REQUIRED";
    throw e;
  }
  return data;
}

async function slot() {
  const p = gate.then(async () => {
    const wait = Math.max(0, 180 - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    lastRequestAt = Date.now();
  });
  gate = p.catch(() => {});
  return p;
}

async function raw(path, acc, options = {}, json = true) {
  let err;
  for (let attempt = 0; attempt < 4; attempt++) {
    await slot();
    try {
      const response = await fetch(`${MP}${path}`, {
        ...options,
        headers: {
          Accept: json ? "application/json" : "text/csv",
          ...(options.body != null ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
          Authorization: `Bearer ${acc.access_token}`
        },
        signal: AbortSignal.timeout(30_000)
      });
      const text = await response.text();
      let data = null;
      if (json) { try { data = text ? JSON.parse(text) : {}; } catch { data = {}; } }
      if (response.ok || response.status === 202) return { response, data, text };
      const e = new Error(`Mercado Pago HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
      e.httpStatus = response.status;
      err = e;
      if (response.status !== 429 && response.status < 500) throw e;
      await sleep(700 * (2 ** attempt));
    } catch (e) {
      err = e;
      if (e.httpStatus && e.httpStatus !== 429 && e.httpStatus < 500) throw e;
      if (attempt === 3) throw e;
      await sleep(700 * (2 ** attempt));
    }
  }
  throw err || new Error("Falha no Mercado Pago.");
}

async function get(path, acc, options = {}) {
  return (await raw(path, acc, options, true)).data;
}

async function payments(acc, params, label, max = 5000) {
  const rows = [];
  let offset = 0;
  let total = null;
  while (offset < max) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE), offset: String(offset) });
    const data = await get(`/v1/payments/search?${q}`, acc);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < PAGE || (Number.isFinite(total) && offset >= total)) break;
  }
  if (offset >= max && Number.isFinite(total) && total > max) throw new Error(`${label}: mais de ${max} pagamentos.`);
  return rows;
}

function collector(p) {
  return String(p?.collector?.id ?? p?.collector_id ?? p?.collector?.user_id ?? "");
}

function orderRef(p) {
  return [p?.external_reference, p?.order?.id, p?.order_id]
    .filter(v => v != null).map(String).find(v => /^200\d{10,}$/.test(v)) || null;
}

function net(p) {
  const exact = Number(p?.transaction_details?.net_received_amount);
  if (Number.isFinite(exact)) return money(Math.max(0, exact));
  const gross = Math.max(0, Number(p?.transaction_amount) || 0);
  const refunded = Math.max(0, Number(p?.transaction_amount_refunded) || 0);
  const fees = (Array.isArray(p?.fee_details) ? p.fee_details : [])
    .filter(f => !f?.fee_payer || String(f.fee_payer).toLowerCase() === "collector")
    .reduce((sum, f) => sum + Math.abs(Number(f?.amount) || 0), 0);
  return money(Math.max(0, gross - refunded - fees));
}

const sum = rows => money((rows || []).reduce((s, p) => s + net(p), 0));

async function directValues(acc, now) {
  const seller = String(acc.user_id || acc.account_id || "");
  const approvedBegin = new Date(now.getTime() - 180 * 86400000).toISOString();
  const mediationBegin = new Date(now.getTime() - 365 * 86400000).toISOString();
  const end = now.toISOString();

  const [approvedRows, mediationRows] = await Promise.all([
    payments(acc, {
      sort: "date_created", criteria: "desc", range: "date_created",
      begin_date: approvedBegin, end_date: end, status: "approved"
    }, "A receber"),
    payments(acc, {
      sort: "date_created", criteria: "desc", range: "date_created",
      begin_date: mediationBegin, end_date: end, status: "in_mediation"
    }, "Mediações")
  ]);

  const approvedPending = approvedRows.filter(p =>
    collector(p) === seller && String(p?.money_release_status || "").toLowerCase() === "pending"
  );

  const saleMediations = mediationRows.filter(p => collector(p) === seller && Boolean(orderRef(p)));
  const mediationPending = saleMediations.filter(p => String(p?.money_release_status || "").toLowerCase() === "pending");
  const mediationReleased = saleMediations.filter(p => String(p?.money_release_status || "").toLowerCase() === "released");
  const excludedReleased = mediationRows.filter(p =>
    collector(p) === seller && String(p?.money_release_status || "").toLowerCase() === "released" && !orderRef(p)
  );

  return {
    receivable: money(sum(approvedPending) + sum(mediationPending)),
    approvedPending: sum(approvedPending),
    mediationPending: sum(mediationPending),
    held: sum(mediationReleased),
    counts: {
      approved_pending: approvedPending.length,
      mediation_pending: mediationPending.length,
      mediation_released: mediationReleased.length
    },
    excludedReleased: excludedReleased.map(p => ({ id: p?.id, ref: p?.external_reference || p?.order?.id || null, net: net(p) }))
  };
}

function parseCsv(text, sep = ",") {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const out = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      if (quoted && src[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === sep && !quoted) {
      row.push(cell); cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(v => String(v).length)) out.push(row);
      row = [];
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(v => String(v).length)) out.push(row);
  }
  return out;
}

function amount(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const normalized = /^-?\d+,\d+$/.test(s) ? s.replace(",", ".") : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function analyze(text, sep, report) {
  const rows = parseCsv(text, sep);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");
  const headers = rows[0].map(v => String(v || "").trim().toUpperCase());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  for (const h of ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"]) {
    if (idx[h] == null) throw new Error(`Relatório sem ${h}.`);
  }

  let initial = 0, initialRows = 0, operationDelta = 0, totalDelta = 0, totalRows = 0, lastBalance = null;
  const types = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = String(r[idx.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;
    types[type] = (types[type] || 0) + 1;
    const credit = amount(r[idx.NET_CREDIT_AMOUNT]) || 0;
    const debit = amount(r[idx.NET_DEBIT_AMOUNT]) || 0;
    const delta = credit - debit;
    if (idx.BALANCE_AMOUNT != null) {
      const b = amount(r[idx.BALANCE_AMOUNT]);
      if (b != null) lastBalance = b;
    }
    if (type === "initial_available_balance") { initial += delta; initialRows++; continue; }
    if (type === "total") { totalDelta += delta; totalRows++; continue; }
    if (type === "available_balance" || type === "subtotal") continue;
    operationDelta += delta;
  }
  if (!initialRows && lastBalance == null) throw new Error("Relatório sem saldo inicial.");
  const movement = totalRows ? totalDelta : operationDelta;
  const calculated = money(initial + movement);
  return {
    balance: lastBalance != null ? money(lastBalance) : calculated,
    calculated,
    initial: money(initial),
    movement: money(movement),
    rows: rows.length - 1,
    types,
    begin: report?.begin_date || null,
    end: report?.end_date || null
  };
}

function usable(report) {
  if (!report?.file_name) return false;
  if (report?.is_reserve === true || String(report?.is_reserve).toLowerCase() === "true") return false;
  if (/^reserve-/i.test(String(report.file_name))) return false;
  return String(report?.sub_type || report?.report_type || "release").toLowerCase() === "release";
}

const reportTime = report => new Date(report?.end_date || report?.generation_date || report?.last_modified || 0).getTime();

async function reports(acc) {
  const data = await get("/v1/account/release_report/search?limit=100&offset=0", acc);
  return (Array.isArray(data?.results) ? data.results : []).filter(usable).sort((a, b) => reportTime(b) - reportTime(a));
}

async function searchReportId(acc, id) {
  if (!id) return null;
  const data = await get(`/v1/account/release_report/search?id=${encodeURIComponent(id)}&limit=10&offset=0`, acc);
  return (Array.isArray(data?.results) ? data.results : []).find(usable) || null;
}

async function taskReport(acc) {
  if (!taskId) return null;
  try {
    const task = await get(`/v1/account/release_report/task/${encodeURIComponent(taskId)}`, acc);
    const status = String(task?.status || "").toLowerCase();
    if (usable(task)) { taskId = null; return task; }
    if (status === "processed" && task?.report_id) {
      const report = await searchReportId(acc, task.report_id);
      if (report) { taskId = null; return report; }
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) taskId = null;
  } catch (e) {
    if (e.httpStatus === 404) taskId = null;
    else console.warn("[Financeiro MP V6] tarefa relatório:", e.message);
  }
  return null;
}

async function requestReport(acc) {
  if (taskId || Date.now() - taskRequestedAt < 120_000) return;
  taskRequestedAt = Date.now();
  const end = new Date();
  const begin = new Date(end.getTime() - 4 * 86400000);
  const task = await get("/v1/account/release_report", acc, {
    method: "POST",
    body: JSON.stringify({ begin_date: iso(begin), end_date: iso(end) })
  });
  taskId = task?.id ? String(task.id) : null;
  console.log("[Financeiro MP V6] relatório solicitado:", JSON.stringify({ task: taskId, begin: iso(begin), end: iso(end) }));
}

async function reportBalance(acc, now) {
  let report = null;
  try { report = (await reports(acc))[0] || null; }
  catch (e) { console.warn("[Financeiro MP V6] busca relatórios:", e.message); }

  const fromTask = await taskReport(acc);
  if (fromTask && (!report || reportTime(fromTask) >= reportTime(report))) report = fromTask;
  const age = report ? now.getTime() - reportTime(report) : Infinity;
  if (!report || age > 240_000) requestReport(acc).catch(e => console.warn("[Financeiro MP V6] gerar relatório:", e.message));
  if (!report) return { report: null, analysis: null, age: null };

  try {
    let sep = ",";
    try {
      const cfg = await get("/v1/account/release_report/config", acc);
      if (typeof cfg?.separator === "string" && cfg.separator) sep = cfg.separator;
    } catch (_) {}
    const file = await raw(`/v1/account/release_report/${encodeURIComponent(report.file_name)}`, acc, {}, false);
    return { report, analysis: analyze(file.text, sep, report), age: Number.isFinite(age) ? Math.round(age / 1000) : null };
  } catch (e) {
    console.warn("[Financeiro MP V6] baixar relatório:", e.message);
    return { report, analysis: null, age: Number.isFinite(age) ? Math.round(age / 1000) : null };
  }
}

async function save(key, name, source, category, balance, metadata) {
  let q = supabase.from("financial_accounts").select("id,metadata");
  if (source === "mercadolivre") q = q.eq("source", "mercadolivre").contains("metadata", { matrix_key: key });
  else q = q.contains("metadata", { matrix_key: key });
  const { data: existing, error } = await q.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const record = {
    name, account_type: "asset", category, source, current_balance: money(balance), include_in_total: true, active: true,
    metadata: { ...(existing?.metadata || {}), matrix_key: key, ...metadata }, updated_at: new Date().toISOString()
  };
  if (existing?.id) {
    const { error: e } = await supabase.from("financial_accounts").update(record).eq("id", existing.id);
    if (e) throw new Error(e.message);
  } else {
    const { error: e } = await supabase.from("financial_accounts").insert(record);
    if (e) throw new Error(e.message);
  }
}

async function run() {
  const acc = await account();
  const now = new Date();
  const direct = await directValues(acc, now);
  const balance = await reportBalance(acc, now);
  const synced = new Date().toISOString();
  const common = { synced_at: synced, mp_user_id: String(acc.user_id || acc.account_id || ""), source_api: "mercadopago_payments_api" };

  await save("ml_receivable", "Mercado Livre — A receber", "mercadolivre", "Mercado Livre a receber", direct.receivable, {
    ...common,
    component: "receivable",
    definition: "approved_pending_collected+sale_mediation_pending",
    approved_pending_total: direct.approvedPending,
    mediation_pending_total: direct.mediationPending,
    counts: direct.counts
  });

  await save("ml_claims_held", "Mercado Livre — Retido em reclamações", "mercadolivre", "Mercado Livre retido em reclamações", direct.held, {
    ...common,
    component: "claims_held",
    definition: "sale_mediation_released",
    held_payments: direct.counts.mediation_released,
    excluded_non_sale_held: direct.excludedReleased
  });

  if (balance.analysis) {
    await save("mp_available_balance", "Mercado Pago Empresas", "mercadopago", "Banco", balance.analysis.balance, {
      institution: "Mercado Pago Empresas",
      balance_source: "mercadopago_release_report_v6",
      balance_provider: "mercadopago_api",
      available_balance: balance.analysis.balance,
      calculated_available_balance: balance.analysis.calculated,
      initial_available_balance: balance.analysis.initial,
      movement_delta: balance.analysis.movement,
      report_file_name: balance.report?.file_name || null,
      report_begin_at: balance.analysis.begin,
      report_end_at: balance.analysis.end,
      report_rows: balance.analysis.rows,
      pluggy_disabled_for_balance: true,
      last_synced_at: synced
    });
  }

  lastAt = Date.now();
  last = {
    a_receber: direct.receivable,
    a_receber_aprovado: direct.approvedPending,
    a_receber_em_mediacao: direct.mediationPending,
    retido_reclamacoes: direct.held,
    saldo_disponivel: balance.analysis?.balance ?? null,
    relatorio: balance.report?.file_name || null,
    idade_relatorio_seg: balance.age,
    fonte_a_receber: "mercadopago_payments_api_direct",
    fonte_retido: "mercadopago_payments_api_direct",
    fonte_saldo: balance.analysis ? "mercadopago_release_report_v6" : "preservado_ate_relatorio_processar",
    contagens: direct.counts,
    excluidos_retido_nao_venda: direct.excludedReleased,
    atualizado_em: synced
  };
  console.log("[Financeiro MP V6] sincronizado:", JSON.stringify(last));
  if (balance.analysis) console.log("[Financeiro MP V6] relatório:", JSON.stringify({ arquivo: balance.report?.file_name, saldo: balance.analysis.balance, calculado: balance.analysis.calculated, initial: balance.analysis.initial, movement: balance.analysis.movement, rows: balance.analysis.rows, types: balance.analysis.types }));
  return last;
}

async function sync(force = false) {
  if (inFlight) return inFlight;
  if (!force && last && Date.now() - lastAt < AUTO_MS) return last;
  inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res) => {
  try { res.json({ sucesso: true, ...(await sync(true)) }); }
  catch (e) {
    console.error("[Financeiro MP V6] sync:", e.message);
    res.status(e.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: e.message });
  }
});
router.get("/api/finance/mercadolivre/status", (req, res) => res.json({ sucesso: true, ultima_sincronizacao: last }));

const startup = setTimeout(() => sync(true).catch(e => console.warn("[Financeiro MP V6] inicial:", e.message)), 3500);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(e => console.warn("[Financeiro MP V6] periódico:", e.message)), AUTO_MS);
interval.unref?.();

module.exports = router;
