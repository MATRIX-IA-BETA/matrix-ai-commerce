const router = require("express").Router();
const { supabase } = require("../db/supabase");
const {
  getMercadoLivreAccount,
  ensureValidMercadoLivreToken,
  mercadoLivreFetch
} = require("../services/mercadolivre");

const AUTO_SYNC_MS = 30 * 60 * 1000;
const FIRST_LOOKBACK_DAYS = 35;
const RECONCILE_DAYS = 2;
const BILLING_BATCH = 60;
const BILLING_GAP_MS = 2500;
const REQUEST_GAP_MS = 300;
const MAX_RETRIES = 5;
let syncInFlight = null;
let lastSyncAt = 0;
let lastResult = null;
let gate = Promise.resolve();
let lastStart = 0;

const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function waitSlot(gap) {
  const next = gate.then(async () => {
    const wait = Math.max(0, gap - (Date.now() - lastStart));
    if (wait) await sleep(wait);
    lastStart = Date.now();
  });
  gate = next.catch(() => {});
  return next;
}

async function mlJson(path, account, label, gap = REQUEST_GAP_MS) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await waitSlot(gap);
    try {
      const signal = AbortSignal.timeout(20000);
      const { response } = await mercadoLivreFetch(path, account, { signal });
      const data = await readJson(response);
      if (response.ok) return data;
      const err = new Error(`${label} HTTP ${response.status}`);
      err.httpStatus = response.status;
      lastError = err;
      if (response.status !== 429 && response.status < 500) throw err;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000 + 300
        : Math.min(15000, 1200 * (2 ** attempt));
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (error.httpStatus && error.httpStatus !== 429 && error.httpStatus < 500) throw error;
      if (attempt === MAX_RETRIES - 1) throw error;
      await sleep(Math.min(10000, 1000 * (2 ** attempt)));
    }
  }
  throw lastError || new Error(label);
}

async function previousState() {
  const { data, error } = await supabase.from("financial_accounts")
    .select("metadata")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: "ml_receivable" })
    .limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const meta = data?.metadata || {};
  return {
    syncedAt: meta.synced_at || null,
    pendingIds: Array.isArray(meta.pending_order_ids) ? meta.pending_order_ids.map(String) : []
  };
}

async function loadPaidOrders(since) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from("marketplace_orders")
      .select("marketplace_order_id,paid_amount,total_amount,raw_data,date_created")
      .eq("marketplace", "mercadolivre")
      .eq("status", "paid")
      .gte("date_created", since)
      .order("date_created", { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function loadOrdersByIds(ids) {
  const map = new Map();
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.from("marketplace_orders")
      .select("marketplace_order_id,paid_amount,total_amount,raw_data,date_created")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", unique.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const row of data || []) map.set(String(row.marketplace_order_id), row);
  }
  return map;
}

async function openClaims(account) {
  const sellerId = String(account.user_id || account.account_id);
  const claims = [];
  let offset = 0;
  while (claims.length < 500) {
    const params = new URLSearchParams({
      "players.user_id": sellerId,
      "players.role": "respondent",
      status: "opened",
      limit: "50",
      offset: String(offset),
      sort: "last_updated:desc"
    });
    const data = await mlJson(`/post-purchase/v1/claims/search?${params}`, account, "Reclamações ML");
    const page = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.results) ? data.results : []);
    claims.push(...page);
    offset += page.length;
    if (!page.length || page.length < 50 || (data?.paging?.total != null && offset >= Number(data.paging.total))) break;
  }
  return claims;
}

async function claimOrderId(claim, account) {
  if (claim?.order_id != null) return String(claim.order_id);
  const resource = String(claim?.resource || "").toLowerCase();
  const id = claim?.resource_id;
  if (resource === "order" && id != null) return String(id);
  if (resource === "shipment" && id != null) {
    const data = await mlJson(`/shipments/${encodeURIComponent(String(id))}`, account, "Shipment da reclamação");
    return data?.order_id != null ? String(data.order_id) : (data?.order?.id != null ? String(data.order.id) : null);
  }
  if (resource === "payment" && id != null) {
    const data = await mlJson(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(id))}`, account, "Pagamento da reclamação");
    return data?.order?.id != null ? String(data.order.id) : null;
  }
  return null;
}

async function resolveClaims(claims, account) {
  const rows = [];
  for (const claim of claims) {
    rows.push({ claim, orderId: await claimOrderId(claim, account) });
  }
  return rows;
}

async function billingRows(account, ids) {
  const out = [];
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const batches = Math.ceil(unique.length / BILLING_BATCH);
  console.log(`[Financeiro ML] billing: ${unique.length} pedidos em ${batches} lote(s)`);
  for (let i = 0; i < unique.length; i += BILLING_BATCH) {
    const chunk = unique.slice(i, i + BILLING_BATCH);
    const params = new URLSearchParams({ order_ids: chunk.join(",") });
    const data = await mlJson(`/billing/integration/group/ML/order/details?${params}`, account, "Financeiro por vendas ML", BILLING_GAP_MS);
    const rows = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
    out.push(...rows);
    console.log(`[Financeiro ML] billing lote ${Math.floor(i / BILLING_BATCH) + 1}/${batches}: OK`);
  }
  return out;
}

function paymentInfo(row) {
  if (Array.isArray(row?.payment_info)) return row.payment_info;
  return row?.payment_info && typeof row.payment_info === "object" ? [row.payment_info] : [];
}

function unreleased(p) {
  const status = String(p?.status || p?.payment_status || "").toLowerCase();
  if (status && status !== "approved") return false;
  const release = String(p?.money_release_status || "").toLowerCase();
  if (release === "released" || release === "available") return false;
  if (release) return true;
  const date = new Date(p?.money_release_date || 0).getTime();
  return Number.isFinite(date) && date > Date.now();
}

async function paymentNet(account, paymentId) {
  const data = await mlJson(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(paymentId))}`, account, `Pagamento ${paymentId}`);
  const exact = Number(data?.transaction_details?.net_received_amount);
  if (Number.isFinite(exact)) return { net: money(Math.max(0, exact)), exact: true };
  const gross = Number(data?.transaction_amount);
  if (!Number.isFinite(gross)) throw new Error(`Pagamento ${paymentId} sem valor líquido.`);
  const refunded = Math.max(0, n(data?.transaction_amount_refunded));
  const fees = (Array.isArray(data?.fee_details) ? data.fee_details : [])
    .filter(f => !f?.fee_payer || String(f.fee_payer).toLowerCase() === "collector")
    .reduce((sum, f) => sum + Math.abs(n(f?.amount)), 0);
  return { net: money(Math.max(0, gross - refunded - fees)), exact: false };
}

function orderQty(order) {
  const items = Array.isArray(order?.raw_data?.order_items) ? order.raw_data.order_items : [];
  return Math.max(1, items.reduce((s, x) => s + Math.max(0, n(x?.quantity)), 0));
}

async function retentionFractions(resolvedClaims, account, orderMap) {
  const map = new Map();
  const explicit = new Map();
  const statuses = new Set();

  for (const row of resolvedClaims) {
    if (!row.orderId) continue;
    const order = orderMap.get(String(row.orderId));
    const qty = orderQty(order);
    const claimed = Math.max(0, n(row.claim?.claimed_quantity));
    map.set(String(row.orderId), Math.min(1, claimed > 0 ? claimed / qty : 1));

    const related = Array.isArray(row.claim?.related_entities) ? row.claim.related_entities.map(x => String(x).toLowerCase()) : [];
    const type = String(row.claim?.type || "").toLowerCase();
    if (!related.includes("return") && type !== "return" && type !== "change") continue;
    try {
      const ret = await mlJson(`/post-purchase/v2/claims/${encodeURIComponent(String(row.claim.id || row.claim.claim_id))}/returns`, account, "Status financeiro da devolução");
      const status = String(ret?.status_money || "").toLowerCase();
      if (status) statuses.add(status);
      const orders = Array.isArray(ret?.orders) ? ret.orders : [];
      for (const item of orders) {
        const oid = item?.order_id == null ? null : String(item.order_id);
        if (!oid) continue;
        if (status === "available" || status === "refunded") explicit.set(oid, 0);
        if (status === "retained") {
          const total = Math.max(0, n(item?.total_quantity));
          const returned = Math.max(0, n(item?.return_quantity));
          explicit.set(oid, String(item?.context_type).toLowerCase() === "total" || !total || !returned ? 1 : Math.min(1, returned / total));
        }
      }
    } catch (error) {
      if (error.httpStatus !== 404) throw error;
    }
  }

  return {
    fraction: id => explicit.has(String(id)) ? explicit.get(String(id)) : (map.get(String(id)) || 0),
    statuses: [...statuses].sort()
  };
}

async function saveAsset(key, name, category, balance, metadata) {
  const { data: existing, error } = await supabase.from("financial_accounts")
    .select("id")
    .eq("source", "mercadolivre")
    .contains("metadata", { matrix_key: key })
    .limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  const record = {
    name, account_type: "asset", category, source: "mercadolivre",
    current_balance: money(balance), include_in_total: true, active: true,
    metadata: { matrix_key: key, ...metadata }, updated_at: new Date().toISOString()
  };
  if (existing?.id) {
    const { error: e } = await supabase.from("financial_accounts").update(record).eq("id", existing.id);
    if (e) throw new Error(e.message);
  } else {
    const { error: e } = await supabase.from("financial_accounts").insert(record);
    if (e) throw new Error(e.message);
  }
}

async function runSync() {
  const raw = await getMercadoLivreAccount();
  if (!raw) { const e = new Error("Conta Mercado Livre não conectada."); e.code = "ML_AUTH_REQUIRED"; throw e; }
  const account = await ensureValidMercadoLivreToken(raw);
  const prev = await previousState();
  const days = prev.syncedAt ? RECONCILE_DAYS : FIRST_LOOKBACK_DAYS;
  const recent = await loadPaidOrders(new Date(Date.now() - days * 86400000).toISOString());
  const claims = await openClaims(account);
  const resolved = await resolveClaims(claims, account);
  const claimIds = resolved.filter(x => x.orderId).map(x => String(x.orderId));
  const candidateIds = [...new Set([...prev.pendingIds, ...recent.map(x => String(x.marketplace_order_id)), ...claimIds])];
  console.log(`[Financeiro ML] início: ${recent.length} vendas recentes, ${claims.length} reclamações, ${prev.pendingIds.length} pendentes anteriores`);

  const orderMap = new Map(recent.map(x => [String(x.marketplace_order_id), x]));
  const missing = candidateIds.filter(id => !orderMap.has(id));
  const extras = await loadOrdersByIds(missing);
  for (const [id, row] of extras) orderMap.set(id, row);

  const billing = await billingRows(account, candidateIds);
  const payments = new Map();
  const releaseStatuses = new Set();
  for (const row of billing) {
    const oid = String(row?.order_id ?? row?.id ?? "");
    if (!oid) continue;
    for (const p of paymentInfo(row)) {
      const pid = p?.payment_id ?? p?.id;
      if (pid == null) continue;
      if (p?.money_release_status) releaseStatuses.add(String(p.money_release_status).toLowerCase());
      if (!unreleased(p)) continue;
      const key = String(pid);
      if (!payments.has(key)) payments.set(key, new Set());
      payments.get(key).add(oid);
    }
  }

  const retention = await retentionFractions(resolved, account, orderMap);
  let totalPending = 0;
  let totalHeld = 0;
  let derived = 0;
  const pendingOrderIds = new Set();
  let checked = 0;

  for (const [pid, oidSet] of payments) {
    const detail = await paymentNet(account, pid);
    if (!detail.exact) derived++;
    const oids = [...oidSet];
    const weights = oids.map(id => Math.max(0, n(orderMap.get(id)?.paid_amount ?? orderMap.get(id)?.total_amount)));
    let denom = weights.reduce((a,b) => a + b, 0);
    if (denom <= 0) denom = oids.length || 1;
    for (let i = 0; i < oids.length; i++) {
      const weight = weights.reduce((a,b) => a + b, 0) > 0 ? weights[i] / denom : 1 / denom;
      const share = detail.net * weight;
      totalPending += share;
      totalHeld += share * retention.fraction(oids[i]);
      pendingOrderIds.add(oids[i]);
    }
    checked++;
    if (checked % 25 === 0) console.log(`[Financeiro ML] pagamentos: ${checked}/${payments.size}`);
  }

  totalPending = money(Math.max(0, totalPending));
  totalHeld = money(Math.max(0, Math.min(totalPending, totalHeld)));
  const receivable = money(totalPending - totalHeld);
  const syncedAt = new Date().toISOString();
  const common = {
    synced_at: syncedAt,
    seller_id: String(account.user_id || account.account_id),
    source_precision: derived ? "ml_billing+payment_net_mixed+claims" : "ml_billing+payment_net_exact+claims",
    candidate_orders: candidateIds.length,
    unreleased_payments: payments.size,
    open_claims: claims.length,
    derived_net_payments: derived,
    release_statuses_seen: [...releaseStatuses].sort(),
    return_money_statuses_seen: retention.statuses,
    pending_order_ids: [...pendingOrderIds]
  };

  await saveAsset("ml_receivable", "Mercado Livre — A receber", "Mercado Livre a receber", receivable, { ...common, component: "receivable" });
  await saveAsset("ml_claims_held", "Mercado Livre — Retido em reclamações", "Mercado Livre retido em reclamações", totalHeld, { ...common, component: "claims_held" });

  lastSyncAt = Date.now();
  lastResult = { a_receber: receivable, retido_reclamacoes: totalHeld, indisponivel_total: totalPending, pagamentos_nao_liberados: payments.size, reclamacoes_abertas: claims.length, atualizado_em: syncedAt };
  console.log("[Financeiro ML] sincronizado:", lastResult);
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
    console.error("[Financeiro ML] sincronização:", error.message);
    res.status(error.code === "ML_AUTH_REQUIRED" ? 428 : 502).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/api/finance/mercadolivre/status", async (req, res) => {
  try {
    const account = await getMercadoLivreAccount();
    const { data, error } = await supabase.from("financial_accounts")
      .select("id,name,current_balance,metadata,updated_at")
      .eq("source", "mercadolivre").eq("active", true);
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, mercadolivre_connected: Boolean(account), contas: data || [], ultima_sincronizacao: lastResult });
  } catch (error) { res.status(500).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => sync(false).catch(e => console.warn("[Financeiro ML] sync inicial:", e.message)), 7000);
startup.unref?.();
const interval = setInterval(() => sync(false).catch(e => console.warn("[Financeiro ML] sync periódico:", e.message)), AUTO_SYNC_MS);
interval.unref?.();

module.exports = router;
