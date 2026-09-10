const router = require("express").Router();

const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  ensureValidMercadoLivreToken,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const AUTO_SYNC_MS = 30 * 60 * 1000;
const FIRST_SYNC_LOOKBACK_DAYS = 60;
const RECONCILE_LOOKBACK_DAYS = 2;
const BILLING_BATCH = 60;
const CLAIM_PAGE_SIZE = 50;
const MAX_OPEN_CLAIMS = 500;
const REQUEST_GAP_MS = 260;
const BILLING_GAP_MS = 1100;
const MAX_RETRIES = 5;

let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let requestGate = Promise.resolve();
let lastRequestStartedAt = 0;

const num = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => Number(num(value).toFixed(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function scheduleRequestStart(minGap = REQUEST_GAP_MS) {
  const next = requestGate.then(async () => {
    const wait = Math.max(0, minGap - (Date.now() - lastRequestStartedAt));
    if (wait) await sleep(wait);
    lastRequestStartedAt = Date.now();
  });
  requestGate = next.catch(() => {});
  return next;
}

function retryDelay(response, attempt) {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(30000, header * 1000 + 250);
  return Math.min(15000, 900 * (2 ** attempt) + Math.floor(Math.random() * 350));
}

async function mlJson(path, account, label, options = {}) {
  let lastError = null;
  const gap = options.billing ? BILLING_GAP_MS : REQUEST_GAP_MS;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await scheduleRequestStart(gap);
    let response;
    let data;

    try {
      const result = await mercadoLivreFetch(path, account, options.fetchOptions || {});
      response = result.response;
      data = await readJson(response);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(Math.min(8000, 700 * (2 ** attempt)));
      continue;
    }

    if (response.ok) return data;

    const retryable = response.status === 429 || response.status >= 500;
    const error = new Error(`${label} HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.details = data;
    lastError = error;

    if (!retryable || attempt === MAX_RETRIES - 1) throw error;
    await sleep(retryDelay(response, attempt));
  }

  throw lastError || new Error(`${label}: falha desconhecida.`);
}

async function mapLimit(values, limit, worker) {
  const result = new Array(values.length);
  let cursor = 0;
  async function runner() {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        result[index] = await worker(values[index], index);
      } catch (error) {
        result[index] = { __error: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length || 1) }, runner));
  return result;
}

async function getPreviousSyncState() {
  const { data, error } = await supabase
    .from("financial_accounts")
    .select("metadata")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: "ml_receivable" })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Estado financeiro ML: ${error.message}`);
  const metadata = data?.metadata || {};
  return {
    syncedAt: metadata.synced_at || null,
    pendingOrderIds: Array.isArray(metadata.pending_order_ids)
      ? metadata.pending_order_ids.map(String)
      : []
  };
}

async function loadPaidOrdersSince(sinceIso) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,status,date_created,paid_amount,total_amount,raw_data")
      .eq("marketplace", "mercadolivre")
      .eq("status", "paid")
      .gte("date_created", sinceIso)
      .order("date_created", { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Pedidos recentes ML: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function loadOrdersByIds(orderIds) {
  const map = new Map();
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id,status,date_created,paid_amount,total_amount,raw_data")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", chunk);
    if (error) throw new Error(`Pedidos por ID ML: ${error.message}`);
    for (const row of data || []) map.set(String(row.marketplace_order_id), row);
  }
  return map;
}

function orderTotalQuantity(order) {
  const items = Array.isArray(order?.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];
  const total = items.reduce((sum, item) => sum + Math.max(0, num(item?.quantity)), 0);
  return total > 0 ? total : 1;
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

    const data = await mlJson(
      `/post-purchase/v1/claims/search?${params.toString()}`,
      account,
      "Reclamações ML"
    );

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

async function resolveClaimOrderId(claim, account) {
  if (claim?.order_id != null) return String(claim.order_id);
  const resource = String(claim?.resource || "").toLowerCase();
  const resourceId = claim?.resource_id;

  if (resource === "order" && resourceId != null) return String(resourceId);

  if (resource === "shipment" && resourceId != null) {
    const data = await mlJson(
      `/shipments/${encodeURIComponent(String(resourceId))}`,
      account,
      `Shipment da reclamação ${claim?.id || ""}`
    );
    return data?.order_id != null
      ? String(data.order_id)
      : data?.order?.id != null
        ? String(data.order.id)
        : null;
  }

  if (resource === "payment" && resourceId != null) {
    const data = await mlJson(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(resourceId))}`,
      account,
      `Pagamento da reclamação ${claim?.id || ""}`
    );
    if (data?.order?.id != null) return String(data.order.id);
    if (data?.external_reference && /^\d{10,}$/.test(String(data.external_reference))) {
      return String(data.external_reference);
    }
  }

  return null;
}

async function resolveClaims(account, claims) {
  const results = await mapLimit(claims, 3, async claim => ({
    claim,
    orderId: await resolveClaimOrderId(claim, account)
  }));

  const rows = [];
  const failures = [];
  for (const result of results) {
    if (result?.__error) failures.push(result.__error.message);
    else if (result) rows.push(result);
  }

  if (failures.length) {
    throw new Error(`Falha ao relacionar ${failures.length} reclamação(ões) com pedidos: ${failures[0]}`);
  }

  return rows;
}

async function fetchReturnForClaim(claim, account) {
  const claimId = claim?.id ?? claim?.claim_id;
  if (claimId == null) return null;

  const related = Array.isArray(claim?.related_entities)
    ? claim.related_entities.map(value => String(value).toLowerCase())
    : [];
  const type = String(claim?.type || "").toLowerCase();
  if (!related.includes("return") && type !== "return" && type !== "change") return null;

  try {
    return await mlJson(
      `/post-purchase/v2/claims/${encodeURIComponent(String(claimId))}/returns`,
      account,
      `Devolução da reclamação ${claimId}`
    );
  } catch (error) {
    if (error.httpStatus === 404) return null;
    throw error;
  }
}

async function buildRetentionFractions(account, resolvedClaims, orderMap) {
  const fallbackFractions = new Map();
  const explicitFractions = new Map();
  const explicitAvailable = new Set();
  const returnStatuses = new Set();

  const claimOrderIds = resolvedClaims
    .filter(row => row?.orderId)
    .map(row => String(row.orderId));

  const missing = claimOrderIds.filter(id => !orderMap.has(id));
  if (missing.length) {
    const extra = await loadOrdersByIds(missing);
    for (const [id, row] of extra) orderMap.set(id, row);
  }

  for (const row of resolvedClaims) {
    if (!row?.orderId) continue;
    const order = orderMap.get(String(row.orderId));
    const totalQty = orderTotalQuantity(order);
    const claimedQty = Math.max(0, num(row.claim?.claimed_quantity));
    fallbackFractions.set(
      String(row.orderId),
      Math.max(0, Math.min(1, claimedQty > 0 ? claimedQty / totalQty : 1))
    );
  }

  const returnResults = await mapLimit(
    resolvedClaims,
    2,
    row => fetchReturnForClaim(row.claim, account)
  );

  for (const result of returnResults) {
    if (result?.__error) throw result.__error;
    const ret = result;
    if (!ret) continue;

    const statusMoney = String(ret?.status_money || "").toLowerCase();
    if (statusMoney) returnStatuses.add(statusMoney);
    const orders = Array.isArray(ret?.orders) ? ret.orders : [];

    for (const item of orders) {
      const orderId = item?.order_id == null ? null : String(item.order_id);
      if (!orderId) continue;

      if (statusMoney === "available" || statusMoney === "refunded") {
        explicitAvailable.add(orderId);
        explicitFractions.set(orderId, 0);
        continue;
      }
      if (statusMoney !== "retained") continue;

      const totalQty = Math.max(0, num(item?.total_quantity));
      const returnQty = Math.max(0, num(item?.return_quantity));
      const context = String(item?.context_type || "").toLowerCase();
      const fraction = context === "total" || totalQty <= 0 || returnQty <= 0
        ? 1
        : Math.max(0, Math.min(1, returnQty / totalQty));

      explicitFractions.set(
        orderId,
        Math.max(explicitFractions.get(orderId) || 0, fraction)
      );
    }
  }

  const fractionForOrder = orderId => {
    const id = String(orderId);
    if (explicitFractions.has(id)) return explicitFractions.get(id);
    if (explicitAvailable.has(id)) return 0;
    return fallbackFractions.get(id) || 0;
  };

  return {
    claimOrderIds,
    fractionForOrder,
    returnStatuses: [...returnStatuses].sort(),
    unresolvedClaims: resolvedClaims.filter(row => !row?.orderId).length
  };
}

async function fetchBillingOrderDetails(account, orderIds) {
  const rows = [];
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];

  for (let i = 0; i < ids.length; i += BILLING_BATCH) {
    const chunk = ids.slice(i, i + BILLING_BATCH);
    const params = new URLSearchParams({ order_ids: chunk.join(",") });
    const data = await mlJson(
      `/billing/integration/group/ML/order/details?${params.toString()}`,
      account,
      "Financeiro por vendas ML",
      { billing: true }
    );

    const page = Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : [];
    rows.push(...page);
  }

  return rows;
}

function normalizePaymentInfo(row) {
  if (Array.isArray(row?.payment_info)) return row.payment_info;
  if (row?.payment_info && typeof row.payment_info === "object") return [row.payment_info];
  return [];
}

function isPaymentUnreleased(payment) {
  const status = String(payment?.status || payment?.payment_status || "").toLowerCase();
  if (status && status !== "approved") return false;

  const releaseStatus = String(payment?.money_release_status || "").toLowerCase();
  if (["released", "available"].includes(releaseStatus)) return false;
  if (releaseStatus) return true;

  const releaseDate = new Date(payment?.money_release_date || 0).getTime();
  return Number.isFinite(releaseDate) && releaseDate > Date.now();
}

async function fetchPaymentDetail(account, paymentId) {
  const data = await mlJson(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(paymentId))}`,
    account,
    `Pagamento ${paymentId}`
  );

  const exactNet = Number(data?.transaction_details?.net_received_amount);
  if (Number.isFinite(exactNet)) {
    return {
      id: String(paymentId),
      net: money(Math.max(0, exactNet)),
      source: "transaction_details.net_received_amount",
      status: data?.status || null,
      status_detail: data?.status_detail || null,
      money_release_date: data?.money_release_date || null
    };
  }

  const gross = Number(data?.transaction_amount);
  if (!Number.isFinite(gross)) {
    throw new Error(`Pagamento ${paymentId} sem valor líquido disponível.`);
  }

  const refunded = Math.max(0, num(data?.transaction_amount_refunded));
  const collectorFees = (Array.isArray(data?.fee_details) ? data.fee_details : [])
    .filter(fee => !fee?.fee_payer || String(fee.fee_payer).toLowerCase() === "collector")
    .reduce((sum, fee) => sum + Math.abs(num(fee?.amount)), 0);

  return {
    id: String(paymentId),
    net: money(Math.max(0, gross - refunded - collectorFees)),
    source: "transaction_amount-fees-refunds",
    status: data?.status || null,
    status_detail: data?.status_detail || null,
    money_release_date: data?.money_release_date || null
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

  const { data, error } = await supabase
    .from("financial_accounts")
    .insert(record)
    .select("id")
    .single();
  if (error) throw new Error(`Criando ${name}: ${error.message}`);
  return data.id;
}

async function performSync() {
  const rawAccount = await getMercadoLivreAccount();
  if (!rawAccount) {
    const error = new Error("Conta Mercado Livre não conectada.");
    error.code = "ML_AUTH_REQUIRED";
    throw error;
  }

  // Renova no máximo uma vez antes de disparar a bateria de consultas.
  const account = await ensureValidMercadoLivreToken(rawAccount);
  const previous = await getPreviousSyncState();
  const lookbackDays = previous.syncedAt
    ? RECONCILE_LOOKBACK_DAYS
    : FIRST_SYNC_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  const recentOrders = await loadPaidOrdersSince(since);
  const claimsLive = await fetchOpenClaims(account);
  const resolvedClaims = await resolveClaims(account, claimsLive.claims);

  const orderMap = new Map(
    recentOrders.map(row => [String(row.marketplace_order_id), row])
  );

  const claimOrderIds = resolvedClaims
    .filter(row => row?.orderId)
    .map(row => String(row.orderId));

  const candidateOrderIds = [...new Set([
    ...previous.pendingOrderIds,
    ...recentOrders.map(row => String(row.marketplace_order_id)),
    ...claimOrderIds
  ])];

  const missingCandidateOrders = candidateOrderIds.filter(id => !orderMap.has(id));
  if (missingCandidateOrders.length) {
    const extras = await loadOrdersByIds(missingCandidateOrders);
    for (const [id, row] of extras) orderMap.set(id, row);
  }

  // Billing é propositalmente sequencial e espaçado; a documentação do ML
  // recomenda evitar batch paralelo e reaproveitar cache local.
  const billingRows = await fetchBillingOrderDetails(account, candidateOrderIds);
  const paymentMap = new Map();
  const releaseStatuses = new Set();

  for (const row of billingRows) {
    const orderId = String(row?.order_id ?? row?.id ?? "").trim();
    if (!orderId) continue;

    for (const payment of normalizePaymentInfo(row)) {
      const paymentId = payment?.payment_id ?? payment?.id;
      if (paymentId == null) continue;
      const releaseStatus = String(payment?.money_release_status || "").toLowerCase();
      if (releaseStatus) releaseStatuses.add(releaseStatus);
      if (!isPaymentUnreleased(payment)) continue;

      const key = String(paymentId);
      if (!paymentMap.has(key)) {
        paymentMap.set(key, { payment_id: key, orders: new Map() });
      }
      paymentMap.get(key).orders.set(orderId, {
        order_id: orderId,
        money_release_status: payment?.money_release_status || null,
        money_release_date: payment?.money_release_date || null
      });
    }
  }

  const retention = await buildRetentionFractions(account, resolvedClaims, orderMap);
  const paymentIds = [...paymentMap.keys()];
  const paymentResults = await mapLimit(
    paymentIds,
    3,
    paymentId => fetchPaymentDetail(account, paymentId)
  );

  const paymentDetails = new Map();
  const paymentErrors = [];
  let derivedNetCount = 0;

  for (let i = 0; i < paymentIds.length; i++) {
    const result = paymentResults[i];
    if (!result || result.__error) {
      paymentErrors.push({
        payment_id: paymentIds[i],
        error: result?.__error?.message || "falha desconhecida"
      });
      continue;
    }
    if (result.source !== "transaction_details.net_received_amount") derivedNetCount += 1;
    paymentDetails.set(paymentIds[i], result);
  }

  if (paymentErrors.length) {
    const preview = paymentErrors.slice(0, 3)
      .map(item => `${item.payment_id}: ${item.error}`)
      .join("; ");
    throw new Error(`Não foi possível validar ${paymentErrors.length} pagamento(s) pendente(s). ${preview}`);
  }

  let pendingTotal = 0;
  let heldTotal = 0;
  let allocatedRows = 0;
  const pendingOrderIds = new Set();

  for (const [paymentId, group] of paymentMap) {
    const detail = paymentDetails.get(paymentId);
    if (!detail) continue;

    const entries = [...group.orders.values()];
    const weighted = entries.map(entry => {
      const order = orderMap.get(String(entry.order_id));
      const gross = Math.max(0, num(order?.paid_amount ?? order?.total_amount));
      return { ...entry, gross };
    });

    let weightTotal = weighted.reduce((sum, row) => sum + row.gross, 0);
    if (weightTotal <= 0) {
      weightTotal = weighted.length || 1;
      for (const row of weighted) row.gross = 1;
    }

    for (const row of weighted) {
      const share = detail.net * (row.gross / weightTotal);
      const retainedFraction = retention.fractionForOrder(row.order_id);
      pendingTotal += share;
      heldTotal += share * retainedFraction;
      pendingOrderIds.add(String(row.order_id));
      allocatedRows += 1;
    }
  }

  pendingTotal = money(Math.max(0, pendingTotal));
  heldTotal = money(Math.max(0, Math.min(pendingTotal, heldTotal)));
  const receivable = money(Math.max(0, pendingTotal - heldTotal));
  const syncedAt = new Date().toISOString();
  const pendingIds = [...pendingOrderIds];

  const common = {
    seller_id: String(account.user_id || account.account_id || ""),
    synced_at: syncedAt,
    source_precision: derivedNetCount === 0
      ? "mercadolivre_billing+payment_net+claims_returns"
      : "mercadolivre_billing+payment_net_derived+claims_returns",
    first_sync_lookback_days: FIRST_SYNC_LOOKBACK_DAYS,
    reconciliation_lookback_days: RECONCILE_LOOKBACK_DAYS,
    candidate_orders: candidateOrderIds.length,
    billing_orders_loaded: billingRows.length,
    unreleased_payments: paymentIds.length,
    allocated_order_payment_rows: allocatedRows,
    exact_net_payments: paymentIds.length - derivedNetCount,
    derived_net_payments: derivedNetCount,
    open_claims: claimsLive.reportedTotal,
    claims_loaded: claimsLive.claims.length,
    claims_truncated: claimsLive.truncated,
    unresolved_claims: retention.unresolvedClaims,
    release_statuses_seen: [...releaseStatuses].sort(),
    return_money_statuses_seen: retention.returnStatuses,
    pending_order_ids: pendingIds
  };

  // Só grava depois que toda a reconciliação terminou: nunca publica meia conta.
  await saveAccount(
    "ml_receivable",
    "Mercado Livre — A receber",
    "Mercado Livre a receber",
    receivable,
    { ...common, component: "receivable" }
  );
  await saveAccount(
    "ml_claims_held",
    "Mercado Livre — Retido em reclamações",
    "Mercado Livre retido em reclamações",
    heldTotal,
    { ...common, component: "claims_held" }
  );

  lastSyncAt = Date.now();
  lastResult = {
    a_receber: receivable,
    retido_reclamacoes: heldTotal,
    indisponivel_total: pendingTotal,
    fonte: common.source_precision,
    pedidos_analisados: candidateOrderIds.length,
    pagamentos_nao_liberados: paymentIds.length,
    reclamacoes_abertas: claimsLive.reportedTotal,
    release_statuses: common.release_statuses_seen,
    return_money_statuses: common.return_money_statuses_seen,
    atualizado_em: syncedAt
  };

  console.log("[Financeiro ML] sincronizado:", lastResult);
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
    const status = error.code === "ML_AUTH_REQUIRED" ? 428 : 502;
    res.status(status).json({
      sucesso: false,
      authorization_required: error.code === "ML_AUTH_REQUIRED",
      mensagem: error.message
    });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  try {
    const account = await getMercadoLivreAccount();
    const { data, error } = await supabase
      .from("financial_accounts")
      .select("id,name,current_balance,metadata,updated_at")
      .eq("source", "mercadolivre")
      .eq("active", true);
    if (error) throw new Error(error.message);

    res.json({
      sucesso: true,
      mercadolivre_connected: Boolean(account),
      mercadolivre_user_id: account?.user_id || null,
      contas: data || [],
      ultima_sincronizacao: lastResult
    });
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

    const { data: updatedRows, error: updateError } = await supabase
      .from("financial_accounts")
      .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("current_balance", account.current_balance)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    if (!updatedRows?.length) {
      return res.status(409).json({ sucesso: false, mensagem: "O saldo dessa obrigação mudou. Atualize a tela e tente novamente." });
    }

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

const startupTimer = setTimeout(async () => {
  try {
    if (await getMercadoLivreAccount()) await syncMercadoLivreFunds(false);
  } catch (error) {
    console.warn("[Financeiro ML] sync inicial:", error.message);
  }
}, 7000);
startupTimer.unref?.();

const interval = setInterval(async () => {
  try {
    if (await getMercadoLivreAccount()) await syncMercadoLivreFunds(false);
  } catch (error) {
    console.warn("[Financeiro ML] sync periódico:", error.message);
  }
}, AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
