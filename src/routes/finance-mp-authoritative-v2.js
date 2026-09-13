const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const AUTO_SYNC_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;
const BALANCE_MAX_AGE_MS = 3 * 60 * 1000;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let gate = Promise.resolve();
let lastRequestAt = 0;

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => Number(n(value).toFixed(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finiteOrNull = value => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

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
      const response = await fetch(`${MP_API}${path}`, {
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
  const exact = finiteOrNull(payment?.transaction_details?.net_received_amount);
  if (exact != null) return money(Math.max(0, exact));
  const gross = Math.max(0, n(payment?.transaction_amount));
  const refunded = Math.max(0, n(payment?.transaction_amount_refunded));
  const fees = (Array.isArray(payment?.fee_details) ? payment.fee_details : [])
    .filter(fee => !fee?.fee_payer || String(fee.fee_payer).toLowerCase() === "collector")
    .reduce((sum, fee) => sum + Math.abs(n(fee?.amount)), 0);
  return money(Math.max(0, gross - refunded - fees));
}

function sumNet(rows) {
  return money((rows || []).reduce((sum, payment) => sum + netValue(payment), 0));
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

function marketplaceOrderReference(payment) {
  const candidates = [
    payment?.external_reference,
    payment?.order?.id,
    payment?.order_id
  ].filter(v => v != null).map(String);
  return candidates.find(value => /^200\d{10,}$/.test(value)) || null;
}

async function searchHeld(account, now) {
  const begin = new Date(now.getTime() - 365 * 86400000);
  const rows = await pagedSearch(account, {
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: begin.toISOString(),
    end_date: now.toISOString(),
    status: "in_mediation"
  }, "Retidos Mercado Pago");

  const held = rows.filter(payment =>
    String(payment?.status || "").toLowerCase() === "in_mediation" &&
    String(payment?.money_release_status || "").toLowerCase() === "released" &&
    Boolean(marketplaceOrderReference(payment))
  );

  const excluded = rows.filter(payment =>
    String(payment?.status || "").toLowerCase() === "in_mediation" &&
    String(payment?.money_release_status || "").toLowerCase() === "released" &&
    !marketplaceOrderReference(payment)
  );

  console.log("[Financeiro MP V2] retido:", {
    pagamentos: held.length,
    total: sumNet(held),
    excluidos_nao_venda: excluded.map(p => ({ id: p?.id, ref: p?.external_reference || p?.order?.id || p?.order_id || null, net: netValue(p) }))
  });
  return held;
}

async function searchFutureReceivableFallback(account, now) {
  const end = new Date(now.getTime() + 180 * 86400000);
  const rows = await pagedSearch(account, {
    sort: "money_release_date",
    criteria: "asc",
    range: "money_release_date",
    begin_date: now.toISOString(),
    end_date: end.toISOString(),
    status: "approved"
  }, "A receber Mercado Pago fallback");
  return rows.filter(payment => {
    const release = String(payment?.money_release_status || "").toLowerCase();
    const ts = new Date(payment?.money_release_date || 0).getTime();
    return release === "pending" && Number.isFinite(ts) && ts > now.getTime();
  });
}

async function readLiveBalance() {
  const { data, error } = await supabase
    .from("financial_accounts")
    .select("current_balance,metadata,updated_at")
    .contains("metadata", { matrix_key: "mp_available_balance" })
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const syncedAt = new Date(data?.metadata?.last_synced_at || data.updated_at || 0).getTime();
  const unavailable = finiteOrNull(data?.metadata?.unavailable_balance);
  if (!Number.isFinite(syncedAt) || Date.now() - syncedAt > BALANCE_MAX_AGE_MS || unavailable == null) return null;
  return {
    available_balance: finiteOrNull(data.current_balance),
    unavailable_balance: unavailable,
    total_amount: finiteOrNull(data?.metadata?.total_amount),
    synced_at: data?.metadata?.last_synced_at || data.updated_at
  };
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
  const [heldRows, liveBalance] = await Promise.all([
    searchHeld(account, now),
    readLiveBalance()
  ]);

  const held = sumNet(heldRows);
  let receivable;
  let receivableCount = null;
  let definition;

  if (liveBalance?.unavailable_balance != null && liveBalance.unavailable_balance + 0.01 >= held) {
    receivable = money(liveBalance.unavailable_balance - held);
    definition = "live_unavailable_balance-minus-marketplace_claims_held";
  } else {
    const fallback = await searchFutureReceivableFallback(account, now);
    receivable = sumNet(fallback);
    receivableCount = fallback.length;
    definition = "release_pending+future_release_date_fallback";
  }

  const syncedAt = new Date().toISOString();
  const common = {
    synced_at: syncedAt,
    mp_user_id: String(account.user_id || account.account_id || ""),
    balance_snapshot_synced_at: liveBalance?.synced_at || null,
    direct_available_balance: liveBalance?.available_balance ?? null,
    direct_unavailable_balance: liveBalance?.unavailable_balance ?? null,
    direct_total_amount: liveBalance?.total_amount ?? null,
    held_payments: heldRows.length
  };

  await saveAsset(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    receivable,
    { ...common, component: "receivable", definition, receivable_payments: receivableCount }
  );
  await saveAsset(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Mercado Livre retido em reclamações",
    held,
    { ...common, component: "claims_held", definition: "in_mediation+released+marketplace_order" }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable,
    retido_reclamacoes: held,
    indisponivel_total: money(receivable + held),
    saldo_disponivel: liveBalance?.available_balance ?? null,
    saldo_indisponivel_api: liveBalance?.unavailable_balance ?? null,
    saldo_total_api: liveBalance?.total_amount ?? null,
    pagamentos_a_receber: receivableCount,
    pagamentos_retidos: heldRows.length,
    fonte_a_receber: definition,
    atualizado_em: syncedAt
  };
  console.log("[Financeiro MP V2] sincronizado:", lastResult);
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
    console.error("[Financeiro MP V2] sincronização:", error.message);
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

const startup = setTimeout(() => sync(false).catch(error => console.warn("[Financeiro MP V2] sync inicial:", error.message)), 7000);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(error => console.warn("[Financeiro MP V2] sync periódico:", error.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;