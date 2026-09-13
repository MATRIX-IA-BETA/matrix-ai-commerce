const router = require("express").Router();
const { supabase } = require("../db/supabase");

const MP_API = "https://api.mercadopago.com";
const AUTO_SYNC_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const REQUEST_GAP_MS = 180;
const MAX_RETRIES = 4;
const RECEIVABLE_LOOKBACK_DAYS = 180;

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
  const gross = Math.max(0, n(payment?.transaction_amount));
  const refunded = Math.max(0, n(payment?.transaction_amount_refunded));
  const fees = (Array.isArray(payment?.fee_details) ? payment.fee_details : [])
    .filter(fee => !fee?.fee_payer || String(fee.fee_payer).toLowerCase() === "collector")
    .reduce((sum, fee) => sum + Math.abs(n(fee?.amount)), 0);
  const exact = Number(payment?.transaction_details?.net_received_amount);

  // O net_received_amount pode permanecer com o valor original enquanto um
  // reembolso parcial já reduziu o dinheiro efetivamente retido/a liberar.
  // Nessa situação usamos o valor líquido corrente reconstruído.
  if (refunded > 0 && gross > 0) {
    const current = money(Math.max(0, gross - refunded - fees));
    return { value: current, exact: false, refund_adjusted: true };
  }
  if (Number.isFinite(exact)) return { value: money(Math.max(0, exact)), exact: true, refund_adjusted: false };
  return { value: money(Math.max(0, gross - refunded - fees)), exact: false, refund_adjusted: refunded > 0 };
}

function breakdown(rows, selector) {
  const out = {};
  for (const p of rows) {
    const key = String(selector(p) ?? "missing").toLowerCase();
    if (!out[key]) out[key] = { count: 0, net: 0 };
    out[key].count++;
    out[key].net += netValue(p).value;
  }
  for (const value of Object.values(out)) value.net = money(value.net);
  return out;
}

function compactReceivableAudit(rows, now = new Date()) {
  const sumWhere = predicate => money(rows.filter(predicate).reduce((sum, p) => sum + netValue(p).value, 0));
  const countWhere = predicate => rows.filter(predicate).length;
  const hasOrder = p => Boolean(p?.order?.id || p?.order_id);
  const hasItems = p => Array.isArray(p?.additional_info?.items) && p.additional_info.items.length > 0;
  const isRegular = p => String(p?.operation_type || "").toLowerCase() === "regular_payment";
  const isTransfer = p => String(p?.operation_type || "").toLowerCase() === "money_transfer";
  const marketplace = p => p?.marketplace ?? p?.metadata?.marketplace ?? p?.additional_info?.marketplace ?? "missing";
  const poi = p => p?.point_of_interaction?.type ?? p?.point_of_interaction?.business_info?.sub_unit ?? "missing";
  const overdue = p => {
    const release = String(p?.money_release_status || "").toLowerCase();
    const ts = new Date(p?.money_release_date || 0).getTime();
    return release === "pending" && Number.isFinite(ts) && ts > 0 && ts <= now.getTime();
  };

  const suspicious = rows
    .filter(p => !isRegular(p) || !hasOrder(p) || !hasItems(p))
    .map(p => ({
      id: p?.id,
      net: netValue(p).value,
      gross: money(p?.transaction_amount),
      refunded: money(p?.transaction_amount_refunded),
      operation: p?.operation_type || null,
      order: p?.order?.id || p?.order_id || null,
      items: Array.isArray(p?.additional_info?.items) ? p.additional_info.items.length : 0,
      marketplace: marketplace(p),
      poi: poi(p),
      payment_type: p?.payment_type_id || p?.payment_type || null,
      method: p?.payment_method_id || null,
      description: String(p?.description || "").slice(0, 90),
      external_reference: p?.external_reference || null,
      release_date: p?.money_release_date || null
    }))
    .slice(0, 120);

  return {
    total: { count: rows.length, net: sumWhere(() => true) },
    overdue_pending: { count: countWhere(overdue), net: sumWhere(overdue) },
    operation: breakdown(rows, p => p?.operation_type),
    payment_type: breakdown(rows, p => p?.payment_type_id || p?.payment_type),
    marketplace: breakdown(rows, marketplace),
    order_presence: {
      with_order: { count: countWhere(hasOrder), net: sumWhere(hasOrder) },
      without_order: { count: countWhere(p => !hasOrder(p)), net: sumWhere(p => !hasOrder(p)) }
    },
    items_presence: {
      with_items: { count: countWhere(hasItems), net: sumWhere(hasItems) },
      without_items: { count: countWhere(p => !hasItems(p)), net: sumWhere(p => !hasItems(p)) }
    },
    regular_vs_other: {
      regular: { count: countWhere(isRegular), net: sumWhere(isRegular) },
      money_transfer: { count: countWhere(isTransfer), net: sumWhere(isTransfer) },
      other: { count: countWhere(p => !isRegular(p) && !isTransfer(p)), net: sumWhere(p => !isRegular(p) && !isTransfer(p)) }
    },
    point_of_interaction: breakdown(rows, poi),
    suspicious
  };
}

function compactHeldAudit(rows) {
  return rows.map(p => {
    const net = netValue(p);
    return {
      id: p?.id,
      gross: money(p?.transaction_amount),
      refunded: money(p?.transaction_amount_refunded),
      net: net.value,
      refund_adjusted: Boolean(net.refund_adjusted),
      release_status: p?.money_release_status || null,
      status: p?.status || null,
      order: p?.order?.id || p?.order_id || p?.external_reference || null
    };
  });
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

function receivablePayment(payment, now) {
  const release = String(payment?.money_release_status || "").toLowerCase();
  if (release === "pending") return true;
  if (release) return false;
  const ts = new Date(payment?.money_release_date || 0).getTime();
  return Number.isFinite(ts) && ts > now.getTime();
}

async function searchReceivable(account, now) {
  const begin = new Date(now.getTime() - RECEIVABLE_LOOKBACK_DAYS * 86400000);
  const rows = await pagedSearch(account, {
    sort: "date_created",
    criteria: "desc",
    range: "date_created",
    begin_date: begin.toISOString(),
    end_date: now.toISOString(),
    status: "approved"
  }, "A receber Mercado Pago");
  return rows.filter(p => receivablePayment(p, now));
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
  }, "Retidos em mediação Mercado Pago");

  console.log("[Financeiro MP] mediações por liberação:", breakdown(rows, p => p?.money_release_status));

  return rows.filter(p =>
    String(p?.status || "").toLowerCase() === "in_mediation" &&
    String(p?.money_release_status || "").toLowerCase() === "released"
  );
}

async function directBalance(account) {
  const userId = String(account.user_id || account.account_id || "").trim();
  if (!userId) return null;
  try {
    const data = await mpJson(
      `/users/${encodeURIComponent(userId)}/mercadopago_account/balance`,
      account,
      "Saldo consolidado Mercado Pago"
    );
    return {
      available_balance: finiteOrNull(data?.available_balance ?? data?.available_amount),
      unavailable_balance: finiteOrNull(data?.unavailable_balance),
      total_amount: finiteOrNull(data?.total_amount)
    };
  } catch (error) {
    console.warn("[Financeiro MP] saldo consolidado direto indisponível:", error.message);
    return null;
  }
}

function sumNet(rows) {
  let total = 0;
  let derived = 0;
  let refundAdjusted = 0;
  for (const payment of rows) {
    const net = netValue(payment);
    total += net.value;
    if (!net.exact) derived++;
    if (net.refund_adjusted) refundAdjusted++;
  }
  return { total: money(total), derived, refundAdjusted };
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
  const [receivableRows, heldRows, balance] = await Promise.all([
    searchReceivable(account, now),
    searchHeld(account, now),
    directBalance(account)
  ]);

  const audit = compactReceivableAudit(receivableRows, now);
  console.log("[Financeiro MP] RECEIVABLE AUDIT:", JSON.stringify(audit));
  console.log("[Financeiro MP] HELD AUDIT:", JSON.stringify(compactHeldAudit(heldRows)));
  if (balance) console.log("[Financeiro MP] BALANCE SNAPSHOT:", balance);

  const searchedReceivable = sumNet(receivableRows);
  const held = sumNet(heldRows);
  let receivableTotal = searchedReceivable.total;
  let receivableDefinition = "approved+release_pending";

  // O endpoint de saldo da própria conta traz o indisponível consolidado.
  // A interface do Mercado Pago separa esse total entre A receber e Retido.
  // Portanto, quando disponível, usamos o total oficial menos o retido já
  // identificado pelas mediações, evitando perder liberações atrasadas.
  if (
    balance?.unavailable_balance != null &&
    balance.unavailable_balance >= 0 &&
    balance.unavailable_balance + 0.01 >= held.total
  ) {
    receivableTotal = money(Math.max(0, balance.unavailable_balance - held.total));
    receivableDefinition = "direct_unavailable_balance-minus-held";
  }

  const syncedAt = new Date().toISOString();
  const precision = searchedReceivable.derived || held.derived
    ? "mercadopago_balance_plus_payment_search_mixed"
    : "mercadopago_balance_plus_payment_search_exact";

  const common = {
    synced_at: syncedAt,
    mp_user_id: String(account.user_id || account.account_id || ""),
    source_precision: precision,
    receivable_payments: receivableRows.length,
    held_payments: heldRows.length,
    receivable_derived_values: searchedReceivable.derived,
    held_derived_values: held.derived,
    receivable_refund_adjusted: searchedReceivable.refundAdjusted,
    held_refund_adjusted: held.refundAdjusted,
    direct_available_balance: balance?.available_balance ?? null,
    direct_unavailable_balance: balance?.unavailable_balance ?? null,
    direct_total_amount: balance?.total_amount ?? null,
    receivable_search_total: searchedReceivable.total,
    overdue_pending_count: audit.overdue_pending.count,
    overdue_pending_total: audit.overdue_pending.net
  };

  await saveAsset(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    receivableTotal,
    { ...common, component: "receivable", definition: receivableDefinition }
  );
  await saveAsset(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Mercado Livre retido em reclamações",
    held.total,
    { ...common, component: "claims_held", definition: "in_mediation+release_released+refund_adjusted" }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivableTotal,
    a_receber_busca: searchedReceivable.total,
    retido_reclamacoes: held.total,
    indisponivel_total: money(receivableTotal + held.total),
    saldo_disponivel: balance?.available_balance ?? null,
    saldo_indisponivel_api: balance?.unavailable_balance ?? null,
    saldo_total_api: balance?.total_amount ?? null,
    pagamentos_a_receber: receivableRows.length,
    pagamentos_retidos: heldRows.length,
    valores_derivados: searchedReceivable.derived + held.derived,
    reembolsos_ajustados: searchedReceivable.refundAdjusted + held.refundAdjusted,
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