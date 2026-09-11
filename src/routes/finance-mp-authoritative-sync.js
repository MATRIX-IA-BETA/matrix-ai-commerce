const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const AUTO_SYNC_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let gate = Promise.resolve();
let lastRequestAt = 0;

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => Number(n(value).toFixed(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getMercadoPagoAccount() {
  const { data, error } = await supabase
    .from("marketplace_accounts")
    .select("id,account_id,user_id,access_token,expires_at")
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

async function mpJson(path, account, label) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await waitSlot();
    try {
      const response = await fetch(path.startsWith("http") ? path : `${MP_API}${path}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${account.access_token}` },
        signal: AbortSignal.timeout(20000)
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      if (response.ok) return data;
      const err = new Error(`${label} HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
      err.httpStatus = response.status;
      lastError = err;
      if (response.status !== 429 && response.status < 500) throw err;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 250 : 900 * (2 ** attempt));
    } catch (error) {
      lastError = error;
      if (error.httpStatus && error.httpStatus !== 429 && error.httpStatus < 500) throw error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(800 * (2 ** attempt));
    }
  }
  throw lastError || new Error(label);
}

function netValue(payment) {
  const exact = Number(payment?.transaction_details?.net_received_amount);
  if (Number.isFinite(exact)) return { value: money(Math.max(0, exact)), exact: true };

  const gross = Math.max(0, n(payment?.transaction_amount));
  const refunded = Math.max(0, n(payment?.transaction_amount_refunded));
  const fees = (Array.isArray(payment?.fee_details) ? payment.fee_details : [])
    .filter(fee => !fee?.fee_payer || String(fee.fee_payer).toLowerCase() === "collector")
    .reduce((sum, fee) => sum + Math.abs(n(fee?.amount)), 0);
  return { value: money(Math.max(0, gross - refunded - fees)), exact: false };
}

async function pagedSearch(account, params, label, maxRows = 5000) {
  const rows = [];
  let offset = 0;
  let reportedTotal = null;

  while (offset < maxRows) {
    const q = new URLSearchParams({ ...params, limit: String(PAGE_SIZE), offset: String(offset) });
    const data = await mpJson(`/v1/payments/search?${q}`, account, label);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    reportedTotal = Number(data?.paging?.total ?? reportedTotal);
    offset += page.length;
    if (!page.length || page.length < PAGE_SIZE || (Number.isFinite(reportedTotal) && offset >= reportedTotal)) break;
  }

  if (offset >= maxRows && Number.isFinite(reportedTotal) && reportedTotal > maxRows) {
    throw new Error(`${label}: resultado excedeu o limite seguro de ${maxRows} pagamentos.`);
  }
  return rows;
}

async function searchReceivable(account, now) {
  // O painel do Mercado Pago chama de “A receber” o dinheiro de pagamentos
  // aprovados cuja data de liberação ainda está no futuro.
  const end = new Date(now.getTime() + 180 * 86400000);
  try {
    const rows = await pagedSearch(account, {
      sort: "money_release_date",
      criteria: "asc",
      range: "money_release_date",
      begin_date: now.toISOString(),
      end_date: end.toISOString(),
      status: "approved"
    }, "A receber Mercado Pago");
    return rows.filter(p => {
      const release = String(p?.money_release_status || "").toLowerCase();
      const ts = new Date(p?.money_release_date || 0).getTime();
      return release === "pending" && Number.isFinite(ts) && ts > now.getTime();
    });
  } catch (error) {
    console.warn("[Financeiro MP] busca por money_release_date falhou; usando fallback:", error.message);
    const begin = new Date(now.getTime() - 120 * 86400000);
    const rows = await pagedSearch(account, {
      sort: "date_created",
      criteria: "desc",
      range: "date_created",
      begin_date: begin.toISOString(),
      end_date: now.toISOString(),
      status: "approved"
    }, "A receber Mercado Pago fallback");
    return rows.filter(p => {
      const release = String(p?.money_release_status || "").toLowerCase();
      const ts = new Date(p?.money_release_date || 0).getTime();
      return release === "pending" && Number.isFinite(ts) && ts > now.getTime();
    });
  }
}

async function searchHeld(account, now) {
  // Pagamentos em mediação são os valores que o Mercado Pago efetivamente
  // retirou da disponibilidade enquanto uma reclamação/disputa está aberta.
  const begin = new Date(now.getTime() - 365 * 86400000);
  return pagedSearch(account, {
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: begin.toISOString(),
    end_date: now.toISOString(),
    status: "in_mediation"
  }, "Retidos em mediação Mercado Pago");
}

function sumNet(rows) {
  let total = 0;
  let derived = 0;
  for (const payment of rows) {
    const net = netValue(payment);
    total += net.value;
    if (!net.exact) derived++;
  }
  return { total: money(total), derived };
}

async function saveAsset(key, name, category, balance, metadata) {
  const { data: existing, error } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: key })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const record = {
    name,
    account_type: "asset",
    category,
    source: "mercadolivre",
    current_balance: money(balance),
    include_in_total: true,
    active: true,
    metadata: { matrix_key: key, ...metadata },
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
  const account = await getMercadoPagoAccount();
  const now = new Date();
  const [receivableRows, heldRows] = await Promise.all([
    searchReceivable(account, now),
    searchHeld(account, now)
  ]);

  const receivable = sumNet(receivableRows);
  const held = sumNet(heldRows);
  const syncedAt = new Date().toISOString();
  const precision = receivable.derived || held.derived
    ? "mercadopago_payment_search_net_mixed"
    : "mercadopago_payment_search_net_exact";

  const common = {
    synced_at: syncedAt,
    mp_user_id: String(account.user_id || account.account_id || ""),
    source_precision: precision,
    receivable_payments: receivableRows.length,
    held_payments: heldRows.length,
    receivable_derived_values: receivable.derived,
    held_derived_values: held.derived
  };

  await saveAsset(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    receivable.total,
    { ...common, component: "receivable", definition: "approved+release_pending+future_release_date" }
  );
  await saveAsset(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Mercado Livre retido em reclamações",
    held.total,
    { ...common, component: "claims_held", definition: "payment_status_in_mediation" }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable.total,
    retido_reclamacoes: held.total,
    indisponivel_total: money(receivable.total + held.total),
    pagamentos_a_receber: receivableRows.length,
    pagamentos_retidos: heldRows.length,
    valores_derivados: receivable.derived + held.derived,
    atualizado_em: syncedAt
  };
  console.log("[Financeiro MP Autoritativo] sincronizado:", lastResult);
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
    console.error("[Financeiro MP Autoritativo] sincronização:", error.message);
    res.status(error.code === "MP_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  try {
    const account = await getMercadoPagoAccount().catch(() => null);
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,metadata,updated_at")
      .eq("source", "mercadolivre")
      .eq("active", true);
    if (error) throw new Error(error.message);
    res.json({
      sucesso: true,
      mercadolivre_connected: Boolean(account),
      mercadopago_connected: Boolean(account),
      contas: data || [],
      ultima_sincronizacao: lastResult
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

const startup = setTimeout(() => sync(false).catch(error => console.warn("[Financeiro MP Autoritativo] sync inicial:", error.message)), 7000);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Financeiro MP Autoritativo] sync periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
