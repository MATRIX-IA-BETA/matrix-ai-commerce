const router = require("express").Router();

const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const AUTO_SYNC_MS = 5 * 60 * 1000;
const CLAIM_PAGE_SIZE = 50;
const MAX_OPEN_CLAIMS = 500;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => Number(num(value).toFixed(2));

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function amountFrom(value) {
  if (Number.isFinite(Number(value))) return Math.abs(Number(value));
  if (!value || typeof value !== "object") return null;
  for (const key of ["amount", "balance", "value", "total_amount", "unavailable_balance"]) {
    if (Number.isFinite(Number(value[key]))) return Math.abs(Number(value[key]));
  }
  return null;
}

function getPath(object, path) {
  let current = object;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = current[key];
  }
  return current;
}

function directHeldFromBalance(balance) {
  const paths = [
    ["retained_balance"],
    ["retention_balance"],
    ["held_balance"],
    ["blocked_balance"],
    ["claims_balance"],
    ["claim_balance"],
    ["disputes_balance"],
    ["dispute_balance"],
    ["chargebacks_balance"],
    ["chargeback_balance"],
    ["unavailable_balance_by_reason", "claims"],
    ["unavailable_balance_by_reason", "claim"],
    ["unavailable_balance_by_reason", "disputes"],
    ["unavailable_balance_by_reason", "dispute"],
    ["unavailable_balance_by_reason", "chargebacks"],
    ["unavailable_balance_by_reason", "chargeback"],
    ["unavailable", "claims"],
    ["unavailable", "disputes"],
    ["unavailable", "chargebacks"]
  ];

  for (const path of paths) {
    const value = amountFrom(getPath(balance, path));
    if (value != null) {
      return { amount: money(value), source: `balance:${path.join(".")}` };
    }
  }
  return null;
}

async function fetchBalance(account) {
  const sellerId = String(account.user_id || account.account_id || "").trim();
  if (!sellerId) throw new Error("Conta Mercado Livre sem seller/user id.");

  const paths = [
    `/users/${encodeURIComponent(sellerId)}/mercadopago_account/balance`,
    `https://api.mercadopago.com/users/${encodeURIComponent(sellerId)}/mercadopago_account/balance`
  ];

  let lastError = null;
  for (const path of paths) {
    try {
      const { response } = await mercadoLivreFetch(path, account);
      const data = await readJson(response);
      if (response.ok) return data;
      lastError = new Error(`saldo Mercado Pago HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Não foi possível consultar o saldo Mercado Livre/Mercado Pago.");
}

async function fetchOpenClaims(account) {
  const sellerId = String(account.user_id || account.account_id || "").trim();
  const claims = [];
  let offset = 0;
  let reportedTotal = null;

  while (claims.length < MAX_OPEN_CLAIMS) {
    const limit = Math.min(CLAIM_PAGE_SIZE, MAX_OPEN_CLAIMS - claims.length);
    const params = new URLSearchParams({
      "players.user_id": sellerId,
      "players.role": "respondent",
      status: "opened",
      limit: String(limit),
      offset: String(offset),
      sort: "last_updated:desc"
    });
    const { response } = await mercadoLivreFetch(
      `/post-purchase/v1/claims/search?${params.toString()}`,
      account
    );
    const data = await readJson(response);
    if (!response.ok) throw new Error(`Reclamações ML HTTP ${response.status}`);

    const page = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.results)
        ? data.results
        : [];

    if (reportedTotal == null && Number.isFinite(Number(data?.paging?.total))) {
      reportedTotal = Number(data.paging.total);
    }

    claims.push(...page);
    offset += page.length;
    if (!page.length || page.length < limit) break;
    if (reportedTotal != null && offset >= reportedTotal) break;
  }

  return {
    claims,
    reportedTotal: reportedTotal == null ? claims.length : reportedTotal,
    truncated: reportedTotal != null && claims.length < reportedTotal
  };
}

async function mapLimit(values, limit, worker) {
  const result = new Array(values.length);
  let cursor = 0;
  async function runner() {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        result[index] = await worker(values[index], index);
      } catch {
        result[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length || 1) }, runner));
  return result;
}

async function resolveClaimOrderId(claim, account) {
  if (claim?.order_id != null) return String(claim.order_id);
  const resource = String(claim?.resource || "").toLowerCase();
  const resourceId = claim?.resource_id;
  if (resource === "order" && resourceId != null) return String(resourceId);
  if (resource === "shipment" && resourceId != null) {
    const { response } = await mercadoLivreFetch(`/shipments/${encodeURIComponent(String(resourceId))}`, account);
    const data = await readJson(response);
    if (!response.ok) return null;
    return data?.order_id != null
      ? String(data.order_id)
      : data?.order?.id != null
        ? String(data.order.id)
        : null;
  }
  if (resource === "payment" && resourceId != null) {
    const { response } = await mercadoLivreFetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(resourceId))}`,
      account
    );
    const data = await readJson(response);
    if (!response.ok) return null;
    return data?.order?.id != null ? String(data.order.id) : null;
  }
  return null;
}

async function loadOrders(orderIds) {
  const map = new Map();
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,paid_amount,total_amount,raw_data")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", chunk);
    if (error) throw new Error(`Pedidos ML: ${error.message}`);
    for (const order of data || []) map.set(String(order.marketplace_order_id), order);
  }
  return map;
}

function estimatedOrderNet(order) {
  const raw = order?.raw_data || {};
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  let total = 0;
  let found = false;

  for (const payment of payments) {
    const status = String(payment?.status || "").toLowerCase();
    if (status && status !== "approved") continue;
    const direct = [
      payment?.transaction_details?.net_received_amount,
      payment?.net_received_amount
    ].find(value => Number.isFinite(Number(value)));
    if (direct != null) {
      total += Math.max(0, Number(direct));
      found = true;
      continue;
    }
    const gross = Number(payment?.transaction_amount ?? payment?.total_paid_amount);
    if (!Number.isFinite(gross)) continue;
    const fee = Math.abs(num(payment?.marketplace_fee));
    const refunded = Math.abs(num(payment?.transaction_amount_refunded));
    total += Math.max(0, gross - fee - refunded);
    found = true;
  }

  if (found) return money(total);
  const fallback = Number(order?.paid_amount ?? order?.total_amount);
  return Number.isFinite(fallback) ? money(Math.max(0, fallback)) : 0;
}

async function estimateHeldFromClaims(account) {
  const live = await fetchOpenClaims(account);
  const resolved = await mapLimit(live.claims, 6, claim => resolveClaimOrderId(claim, account));
  const orderIds = [...new Set(resolved.filter(Boolean))];
  const orders = await loadOrders(orderIds);
  let amount = 0;
  let ordersFound = 0;
  for (const orderId of orderIds) {
    const order = orders.get(orderId);
    if (!order) continue;
    amount += estimatedOrderNet(order);
    ordersFound += 1;
  }
  return {
    amount: money(amount),
    open_claims: live.reportedTotal,
    claims_loaded: live.claims.length,
    orders_resolved: orderIds.length,
    orders_found: ordersFound,
    truncated: live.truncated
  };
}

async function saveAccount(matrixKey, name, category, balance, metadata) {
  const { data: existing, error: findError } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: matrixKey })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`Conta financeira ML: ${findError.message}`);

  const record = {
    name,
    account_type: "asset",
    category,
    source: "mercadolivre",
    current_balance: money(balance),
    include_in_total: true,
    active: true,
    metadata: { matrix_key: matrixKey, ...metadata },
    updated_at: new Date().toISOString()
  };

  if (existing?.id) {
    const { error } = await supabase.from("financial_accounts").update(record).eq("id", existing.id);
    if (error) throw new Error(`Atualizando ${name}: ${error.message}`);
    return existing.id;
  }

  const { data, error } = await supabase.from("financial_accounts").insert(record).select("id").single();
  if (error) throw new Error(`Criando ${name}: ${error.message}`);
  return data.id;
}

async function performSync() {
  const account = await getMercadoLivreAccount();
  if (!account) throw new Error("Conta Mercado Livre não conectada.");

  const balance = await fetchBalance(account);
  const unavailable = money(Math.max(0, num(balance?.unavailable_balance)));
  const available = money(Math.max(0, num(balance?.available_balance)));
  const total = money(Math.max(0, num(balance?.total_amount)));

  let heldInfo = directHeldFromBalance(balance);
  let claimInfo = null;
  if (!heldInfo) {
    try {
      claimInfo = await estimateHeldFromClaims(account);
      heldInfo = { amount: claimInfo.amount, source: "open_claim_orders_estimate" };
    } catch (error) {
      console.warn("[Financeiro ML] Não foi possível estimar retenções por reclamação:", error.message);
      heldInfo = { amount: 0, source: "unavailable_only" };
    }
  }

  const held = money(Math.min(unavailable, Math.max(0, num(heldInfo.amount))));
  const receivable = money(Math.max(0, unavailable - held));
  const syncedAt = new Date().toISOString();
  const common = {
    seller_id: String(account.user_id || account.account_id || ""),
    synced_at: syncedAt,
    ml_total_amount: total,
    ml_available_balance: available,
    ml_unavailable_balance: unavailable,
    balance_keys: Object.keys(balance || {}).sort()
  };

  await saveAccount(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    receivable,
    { ...common, component: "receivable", held_source: heldInfo.source }
  );
  await saveAccount(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Valores retidos",
    held,
    { ...common, component: "claims_held", held_source: heldInfo.source, claims: claimInfo }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable,
    retido_reclamacoes: held,
    indisponivel_total: unavailable,
    saldo_disponivel: available,
    saldo_total_mp: total,
    criterio_retido: heldInfo.source,
    reclamacoes: claimInfo,
    atualizado_em: syncedAt
  };
  return lastResult;
}

async function syncMercadoLivreFunds(force = false) {
  if (syncInFlight) return syncInFlight;
  if (!force && lastResult && Date.now() - lastSyncAt < AUTO_SYNC_MS) return lastResult;
  syncInFlight = performSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

router.post("/api/finance/mercadolivre/sync", async (req, res) => {
  try {
    const result = await syncMercadoLivreFunds(true);
    res.json({ sucesso: true, ...result });
  } catch (error) {
    console.error("[Financeiro ML] sincronização:", error.message);
    res.status(502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,metadata,updated_at")
      .eq("source", "mercadolivre")
      .eq("active", true);
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, contas: data || [], ultima_sincronizacao: lastResult });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.post("/api/finance/liabilities/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Obrigação inválida." });
    }

    const { data: account, error: accountError } = await supabase
      .from("financial_accounts")
      .select("id,name,category,account_type,current_balance,active")
      .eq("id", id)
      .single();
    if (accountError) throw new Error(accountError.message);
    if (account.account_type !== "liability") {
      return res.status(400).json({ sucesso: false, mensagem: "A conta selecionada não é um passivo." });
    }

    const current = money(Math.max(0, num(account.current_balance)));
    if (current <= 0) {
      return res.json({ sucesso: true, mensagem: "Obrigação já está quitada.", novo_saldo: 0, valor_pago: 0 });
    }

    const payFull = req.body?.pay_full === true;
    const requested = payFull ? current : money(Math.abs(num(req.body?.amount)));
    if (requested <= 0) {
      return res.status(400).json({ sucesso: false, mensagem: "Informe um valor de pagamento maior que zero." });
    }

    const paid = money(Math.min(current, requested));
    const newBalance = money(current - paid);
    const occurredAt = req.body?.occurred_at || new Date().toISOString();

    const { error: updateError } = await supabase
      .from("financial_accounts")
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("current_balance", account.current_balance);
    if (updateError) throw new Error(updateError.message);

    const { error: entryError } = await supabase.from("financial_entries").insert({
      account_id: id,
      entry_type: "adjustment",
      amount: paid,
      description: payFull ? `Quitação: ${account.name}` : `Pagamento parcial: ${account.name}`,
      source: "liability_payment",
      reference_type: "liability_payment",
      reference_id: String(id),
      occurred_at: occurredAt,
      metadata: {
        signed_delta: -paid,
        previous_balance: current,
        new_balance: newBalance,
        payment_mode: payFull ? "full" : "partial",
        bank_balance_managed_by_open_finance: true
      }
    });
    if (entryError) {
      console.error("[Financeiro] obrigação baixada, mas falhou log:", entryError.message);
    }

    res.json({
      sucesso: true,
      mensagem: newBalance === 0 ? "Obrigação quitada." : "Pagamento parcial registrado.",
      valor_pago: paid,
      novo_saldo: newBalance
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

// Mantém os recebíveis atualizados mesmo sem a tela Financeiro aberta.
const startupTimer = setTimeout(() => {
  syncMercadoLivreFunds(false).catch(error =>
    console.warn("[Financeiro ML] sync inicial:", error.message)
  );
}, 5000);
startupTimer.unref?.();

const interval = setInterval(() => {
  syncMercadoLivreFunds(false).catch(error =>
    console.warn("[Financeiro ML] sync periódico:", error.message)
  );
}, AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
