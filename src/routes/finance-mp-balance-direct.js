const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const MATRIX_KEY = "mp_available_balance";
const REPORT_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const REPORT_FRESH_MS = 3 * 60 * 1000;
const FORCE_GUARD_MS = 45 * 1000;
const BACKGROUND_SYNC_MS = 5 * 60 * 1000;
const TASK_POLL_MS = 1500;
const TASK_TIMEOUT_MS = 45 * 1000;

let lastResult = null;
let lastSyncAt = 0;
let syncInFlight = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const money = value => {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
};

async function getAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token,expires_at")
    .eq("marketplace", "mercadopago")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Conta Mercado Pago: ${error.message}`);
  if (!data?.access_token) {
    const err = new Error("Conta Mercado Pago não conectada.");
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
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === separator && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some(value => String(value).length > 0)) rows.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  if (cell.length || row.length) {
    row.push(cell);
    if (row.some(value => String(value).length > 0)) rows.push(row);
  }

  return rows;
}

function parseAmount(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const normalized = /^-?\d+,\d+$/.test(raw) ? raw.replace(",", ".") : raw.replace(/\s/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function analyzeReleaseCsv(text, separator = ",") {
  const rows = parseCsv(text, separator);
  if (rows.length < 2) throw new Error("Relatório de Liberações vazio.");

  const headers = rows[0].map(value => String(value || "").trim().toUpperCase());
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const required = ["RECORD_TYPE", "NET_CREDIT_AMOUNT", "NET_DEBIT_AMOUNT"];
  const missing = required.filter(key => index[key] == null);
  if (missing.length) throw new Error(`Relatório de Liberações sem as colunas: ${missing.join(", ")}.`);

  let initial = 0;
  let releaseDelta = 0;
  let initialRows = 0;
  let releaseRows = 0;
  const types = {};

  for (let line = 1; line < rows.length; line++) {
    const values = rows[line];
    const type = String(values[index.RECORD_TYPE] || "").trim().toLowerCase();
    if (!type) continue;

    const credit = parseAmount(values[index.NET_CREDIT_AMOUNT]);
    const debit = parseAmount(values[index.NET_DEBIT_AMOUNT]);
    const delta = credit - debit;
    types[type] = (types[type] || 0) + 1;

    if (type === "initial_available_balance") {
      initial += delta;
      initialRows += 1;
    } else if (type === "release") {
      releaseDelta += delta;
      releaseRows += 1;
    }
  }

  if (!initialRows) throw new Error("Relatório de Liberações não trouxe initial_available_balance.");

  return {
    available_balance: Number((initial + releaseDelta).toFixed(2)),
    initial_available_balance: Number(initial.toFixed(2)),
    release_delta: Number(releaseDelta.toFixed(2)),
    rows: rows.length - 1,
    initial_rows: initialRows,
    release_rows: releaseRows,
    types
  };
}

async function getConfig(account) {
  const config = await mpJson("/v1/account/release_report/config", account, {}, "Configuração do Relatório de Liberações");
  return {
    separator: typeof config?.separator === "string" && config.separator.length ? config.separator : ",",
    timezone: config?.display_timezone || null,
    format: String(config?.frequency?.format || "CSV").toUpperCase()
  };
}

async function listReports(account) {
  const rows = await mpJson("/v1/account/release_report/list", account, {}, "Lista do Relatório de Liberações");
  return Array.isArray(rows) ? rows : [];
}

function downloadableReports(rows) {
  return (rows || [])
    .filter(row => row?.file_name && String(row?.format || "CSV").toUpperCase() === "CSV")
    .sort((a, b) => {
      const ta = new Date(a?.end_date || a?.generation_date || 0).getTime();
      const tb = new Date(b?.end_date || b?.generation_date || 0).getTime();
      return tb - ta;
    });
}

function isFreshReport(report) {
  const end = new Date(report?.end_date || 0).getTime();
  return Number.isFinite(end) && end > 0 && Date.now() - end <= REPORT_FRESH_MS;
}

async function createCurrentReport(account) {
  const end = new Date();
  const begin = new Date(end.getTime() - REPORT_LOOKBACK_MS);
  const payload = {
    begin_date: begin.toISOString(),
    end_date: end.toISOString()
  };

  const createdResult = await mpRequest("/v1/account/release_report", account, {
    method: "POST",
    body: JSON.stringify(payload)
  }, true);

  if (!createdResult.response.ok && createdResult.response.status !== 202) {
    const detail = createdResult.data?.message || createdResult.data?.error || "erro";
    throw new Error(`Criação do Relatório de Liberações HTTP ${createdResult.response.status}: ${detail}`);
  }

  const task = createdResult.data || {};
  const taskId = task.id;
  if (!taskId) throw new Error("Mercado Pago aceitou o relatório, mas não devolveu o task id.");

  const deadline = Date.now() + TASK_TIMEOUT_MS;
  let lastTask = task;

  while (Date.now() < deadline) {
    await sleep(TASK_POLL_MS);
    const current = await mpJson(
      `/v1/account/release_report/task/${encodeURIComponent(taskId)}`,
      account,
      {},
      "Tarefa do Relatório de Liberações"
    );
    lastTask = current || lastTask;

    if (current?.file_name) return { ...current, task_id: taskId };

    const status = String(current?.status || "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Relatório de Liberações falhou com status ${status}.`);
    }
  }

  const reports = downloadableReports(await listReports(account));
  const exact = reports.find(row => String(row?.id) === String(taskId));
  if (exact) return { ...exact, task_id: taskId };

  const targetEnd = new Date(lastTask?.end_date || task.end_date || payload.end_date).getTime();
  const nearby = reports.find(row => {
    const rowEnd = new Date(row?.end_date || 0).getTime();
    return Number.isFinite(rowEnd) && Number.isFinite(targetEnd) && Math.abs(rowEnd - targetEnd) < 2 * 60 * 1000;
  });
  if (nearby) return { ...nearby, task_id: taskId };

  const err = new Error(`Relatório de Liberações ainda está processando (task ${taskId}).`);
  err.code = "MP_RELEASE_REPORT_PENDING";
  throw err;
}

async function resolveReport(account) {
  const reports = downloadableReports(await listReports(account));
  const latest = reports[0] || null;
  if (latest && isFreshReport(latest)) return { ...latest, reused: true, task_id: latest.id || null };
  return { ...(await createCurrentReport(account)), reused: false };
}

async function readReportBalance(account, report, separator) {
  if (!report?.file_name) throw new Error("Relatório de Liberações sem file_name.");
  const result = await mpRequest(
    `/v1/account/release_report/${encodeURIComponent(report.file_name)}`,
    account,
    {},
    false
  );
  if (!result.response.ok) {
    throw new Error(`Download do Relatório de Liberações HTTP ${result.response.status}.`);
  }
  return analyzeReleaseCsv(result.text, separator);
}

async function saveDirectBalance(account, report, analysis) {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from("financial_accounts")
    .select("id,name,source,metadata,active")
    .eq("account_type", "asset");
  if (error) throw new Error(error.message);

  const existing = (rows || []).find(row => row?.metadata?.matrix_key === MATRIX_KEY) ||
    (rows || []).find(row =>
      String(row?.source || "").toLowerCase() === "pluggy" &&
      /mercado pago/i.test(String(row?.metadata?.institution || row?.name || ""))
    );

  const metadata = {
    ...(existing?.metadata || {}),
    matrix_key: MATRIX_KEY,
    institution: "Mercado Pago Empresas",
    balance_source: "mercadopago_release_report",
    available_balance: analysis.available_balance,
    initial_available_balance: analysis.initial_available_balance,
    release_delta: analysis.release_delta,
    report_file_name: report.file_name || null,
    report_task_id: report.task_id || report.id || null,
    report_begin_at: report.begin_date || null,
    report_end_at: report.end_date || null,
    report_rows: analysis.rows,
    mp_user_id: String(account.user_id || account.account_id || ""),
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
    const { data: inserted, error: insertError } = await supabase
      .from("financial_accounts")
      .insert(record)
      .select("id")
      .single();
    if (insertError) throw new Error(insertError.message);
    accountId = inserted?.id || null;
  }

  for (const row of rows || []) {
    if (!row?.id || row.id === accountId) continue;
    const isDuplicate = row?.metadata?.matrix_key === MATRIX_KEY ||
      (String(row?.source || "").toLowerCase() === "pluggy" && /mercado pago/i.test(String(row?.metadata?.institution || row?.name || "")));
    if (!isDuplicate) continue;
    await supabase.from("financial_accounts").update({ include_in_total: false, active: false, updated_at: now }).eq("id", row.id);
  }

  return now;
}

async function runSync() {
  const account = await getAccount();
  const [config, report] = await Promise.all([
    getConfig(account),
    resolveReport(account)
  ]);
  const analysis = await readReportBalance(account, report, config.separator);
  const syncedAt = await saveDirectBalance(account, report, analysis);

  lastSyncAt = Date.now();
  lastResult = {
    saldo_disponivel: analysis.available_balance,
    saldo_inicial_relatorio: analysis.initial_available_balance,
    variacao_liberacoes: analysis.release_delta,
    fonte: "mercadopago_release_report",
    relatorio: report.file_name || null,
    fim_relatorio: report.end_date || null,
    reutilizado: Boolean(report.reused),
    atualizado_em: syncedAt
  };
  console.log("[Mercado Pago Saldo Relatório] sincronizado:", lastResult);
  return lastResult;
}

async function sync(force = false) {
  if (syncInFlight) return syncInFlight;
  const guard = force ? FORCE_GUARD_MS : REPORT_FRESH_MS;
  if (lastResult && Date.now() - lastSyncAt < guard) return lastResult;
  syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

// O botão Atualizar do Financeiro passa por esta rota. O middleware atualiza
// primeiro o saldo disponível do Mercado Pago e depois deixa o sincronismo de
// valores a receber/retidos seguir normalmente.
router.post("/api/finance/mercadolivre/sync", async (req, res, next) => {
  try { await sync(true); }
  catch (error) { console.warn("[Mercado Pago Saldo Relatório] pré-sync ML:", error.message); }
  next();
});

router.post("/api/finance/mercadopago/balance/sync", async (req, res) => {
  try {
    res.json({ sucesso: true, ...(await sync(true)) });
  } catch (error) {
    console.warn("[Mercado Pago Saldo Relatório] falha:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({
      sucesso: false,
      mensagem: error.message,
      saldo_anterior_preservado: true
    });
  }
});

router.get("/api/finance/mercadopago/balance/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,include_in_total,source,metadata,updated_at")
      .contains("metadata", { matrix_key: MATRIX_KEY })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, conta: data || null, ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync(true).catch(error => console.warn("[Mercado Pago Saldo Relatório] sync inicial:", error.message)), 4000);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Mercado Pago Saldo Relatório] sync periódico:", error.message)), BACKGROUND_SYNC_MS);
interval.unref?.();

module.exports = router;
