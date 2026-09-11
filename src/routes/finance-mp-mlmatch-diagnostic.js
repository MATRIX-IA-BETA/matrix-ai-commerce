const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));

function netValue(p) {
  const exact = Number(p?.transaction_details?.net_received_amount);
  if (Number.isFinite(exact)) return money(Math.max(0, exact));
  const gross = Math.max(0, n(p?.transaction_amount));
  const refunded = Math.max(0, n(p?.transaction_amount_refunded));
  const fees = (Array.isArray(p?.fee_details) ? p.fee_details : [])
    .filter(f => !f?.fee_payer || String(f.fee_payer).toLowerCase() === "collector")
    .reduce((sum, f) => sum + Math.abs(n(f?.amount)), 0);
  return money(Math.max(0, gross - refunded - fees));
}

async function futureReceivables(account) {
  const now = new Date();
  const end = new Date(now.getTime() + 180 * 86400000);
  const limit = 100;
  const collectorId = String(account.user_id || account.account_id || "");
  let offset = 0;
  let total = null;
  const rows = [];

  while (offset < 5000) {
    const q = new URLSearchParams({
      sort: "money_release_date",
      criteria: "asc",
      range: "money_release_date",
      begin_date: now.toISOString(),
      end_date: end.toISOString(),
      status: "approved",
      "collector.id": collectorId,
      limit: String(limit),
      offset: String(offset)
    });
    const { response, data } = await mpRequest(`/v1/payments/search?${q}`, account);
    if (!response.ok) throw new Error(`Payments HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < limit || (Number.isFinite(total) && offset >= total)) break;
    await sleep(180);
  }

  return rows.filter(p => {
    const release = String(p?.money_release_status || "").toLowerCase();
    const ts = new Date(p?.money_release_date || 0).getTime();
    return release === "pending" && Number.isFinite(ts) && ts > now.getTime();
  });
}

function orderIdOf(p) {
  const raw = p?.order?.id ?? p?.order_id ?? p?.external_reference ?? null;
  return raw == null ? null : String(raw);
}

async function matrixOrderIds(ids) {
  const found = new Set();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase
      .from("marketplace_orders")
      .select("marketplace_order_id")
      .eq("marketplace", "mercadolivre")
      .in("marketplace_order_id", unique.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const row of data || []) found.add(String(row.marketplace_order_id));
  }
  return found;
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");
  const rows = await futureReceivables(account);
  const ids = rows.map(orderIdOf).filter(Boolean);
  const found = await matrixOrderIds(ids);

  const matched = [];
  const unmatched = [];
  for (const p of rows) {
    const oid = orderIdOf(p);
    const item = {
      id: p?.id,
      order_id: oid,
      net: netValue(p),
      gross: money(p?.transaction_amount),
      operation: p?.operation_type || null,
      poi: p?.point_of_interaction?.type || p?.point_of_interaction?.business_info?.sub_unit || null,
      description: String(p?.description || "").slice(0, 100),
      external_reference: p?.external_reference || null,
      release_date: p?.money_release_date || null
    };
    if (oid && found.has(oid)) matched.push(item);
    else unmatched.push(item);
  }

  const sum = arr => money(arr.reduce((s, x) => s + n(x.net), 0));
  const prefix = {};
  for (const x of unmatched) {
    const key = x.order_id ? String(x.order_id).slice(0, 4) : "none";
    if (!prefix[key]) prefix[key] = { count: 0, net: 0 };
    prefix[key].count++;
    prefix[key].net += x.net;
  }
  for (const v of Object.values(prefix)) v.net = money(v.net);

  const result = {
    collector_id: String(account.user_id || account.account_id || ""),
    total: { count: rows.length, net: sum(rows.map(p => ({ net: netValue(p) }))) },
    matched_ml_orders: { count: matched.length, net: sum(matched) },
    unmatched: { count: unmatched.length, net: sum(unmatched) },
    unmatched_order_prefix: prefix,
    unmatched_rows: unmatched
  };
  console.log("[Financeiro MP ML-MATCH COLLECTOR]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro MP ML-MATCH COLLECTOR] falhou:", error.message)), 18000);
startup.unref?.();

module.exports = router;
