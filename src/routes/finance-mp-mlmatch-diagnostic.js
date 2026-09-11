const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { getMercadoPagoAccount, mpRequest } = require("./finance-mp-release-report");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = v => Number(n(v).toFixed(2));
const SNAPSHOT_AT = new Date("2026-09-11T00:29:00.000Z"); // print 10/09 21:29 -03

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

async function searchByReleaseWindow(account, begin, end, status = null) {
  const limit = 100;
  const collectorId = String(account.user_id || account.account_id || "");
  let offset = 0;
  let total = null;
  const rows = [];

  while (offset < 5000) {
    const params = {
      sort: "money_release_date",
      criteria: "asc",
      range: "money_release_date",
      begin_date: begin.toISOString(),
      end_date: end.toISOString(),
      "collector.id": collectorId,
      limit: String(limit),
      offset: String(offset)
    };
    if (status) params.status = status;
    const q = new URLSearchParams(params);
    const { response, data } = await mpRequest(`/v1/payments/search?${q}`, account);
    if (!response.ok) throw new Error(`Payments HTTP ${response.status}: ${data?.message || data?.error || "erro"}`);
    const page = Array.isArray(data?.results) ? data.results : [];
    rows.push(...page);
    total = Number(data?.paging?.total ?? total);
    offset += page.length;
    if (!page.length || page.length < limit || (Number.isFinite(total) && offset >= total)) break;
    await sleep(180);
  }
  return rows;
}

async function futureReceivables(account) {
  const now = new Date();
  const end = new Date(now.getTime() + 180 * 86400000);
  const rows = await searchByReleaseWindow(account, now, end, "approved");
  return rows.filter(p => {
    const release = String(p?.money_release_status || "").toLowerCase();
    const ts = new Date(p?.money_release_date || 0).getTime();
    return release === "pending" && Number.isFinite(ts) && ts > now.getTime();
  });
}

async function snapshotReceivables(account) {
  const end = new Date(SNAPSHOT_AT.getTime() + 180 * 86400000);
  const rows = await searchByReleaseWindow(account, SNAPSHOT_AT, end, null);
  return rows.filter(p => {
    const status = String(p?.status || "").toLowerCase();
    const approvedAt = new Date(p?.date_approved || p?.date_created || 0).getTime();
    const releaseAt = new Date(p?.money_release_date || 0).getTime();
    return status === "approved" &&
      Number.isFinite(approvedAt) && approvedAt <= SNAPSHOT_AT.getTime() &&
      Number.isFinite(releaseAt) && releaseAt > SNAPSHOT_AT.getTime();
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

function summarize(rows) {
  return {
    count: rows.length,
    net: money(rows.reduce((sum, p) => sum + netValue(p), 0))
  };
}

async function audit() {
  const account = await getMercadoPagoAccount();
  if (!account?.access_token) throw new Error("Mercado Pago não conectado.");
  const [rows, snapshotRows] = await Promise.all([
    futureReceivables(account),
    snapshotReceivables(account)
  ]);
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
      status: p?.status || null,
      release_status: p?.money_release_status || null,
      operation: p?.operation_type || null,
      poi: p?.point_of_interaction?.type || p?.point_of_interaction?.business_info?.sub_unit || null,
      description: String(p?.description || "").slice(0, 100),
      external_reference: p?.external_reference || null,
      date_approved: p?.date_approved || null,
      release_date: p?.money_release_date || null
    };
    if (oid && found.has(oid)) matched.push(item);
    else unmatched.push(item);
  }

  const snapshotResult = summarize(snapshotRows);
  const snapshotReleasedSince = snapshotRows.filter(p =>
    new Date(p?.money_release_date || 0).getTime() <= Date.now()
  );
  const currentApprovedAfterSnapshot = rows.filter(p =>
    new Date(p?.date_approved || p?.date_created || 0).getTime() > SNAPSHOT_AT.getTime()
  );

  const result = {
    collector_id: String(account.user_id || account.account_id || ""),
    current: summarize(rows),
    snapshot_at: SNAPSHOT_AT.toISOString(),
    reconstructed_snapshot: snapshotResult,
    released_since_snapshot: summarize(snapshotReleasedSince),
    current_receivables_approved_after_snapshot: summarize(currentApprovedAfterSnapshot),
    matched_ml_orders: { count: matched.length, net: money(matched.reduce((s, x) => s + x.net, 0)) },
    unmatched: { count: unmatched.length, net: money(unmatched.reduce((s, x) => s + x.net, 0)) },
    unmatched_rows: unmatched
  };
  console.log("[Financeiro MP SNAPSHOT AUDIT]", JSON.stringify(result));
  return result;
}

router.get("/api/finance/mercadopago/ml-match-diagnostic", async (req, res) => {
  try { res.json({ sucesso: true, ...(await audit()) }); }
  catch (error) { res.status(502).json({ sucesso: false, mensagem: error.message }); }
});

const startup = setTimeout(() => audit().catch(error => console.warn("[Financeiro MP SNAPSHOT AUDIT] falhou:", error.message)), 18000);
startup.unref?.();

module.exports = router;
