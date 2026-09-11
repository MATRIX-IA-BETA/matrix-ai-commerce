const express = require("express");
const router = express.Router();
const { supabase } = require("../db/supabase");
const { registerSicPackage, runSicImportPhase, phases } = require("../services/sic-import");
const { getMercadoLivreAccount, mercadoLivreFetch } = require("../services/mercadolivre");

const limitOf = (v, fallback = 100, max = 500) => Math.min(max, Math.max(1, Number(v) || fallback));
const offsetOf = v => Math.max(0, Number(v) || 0);
const money = v => Number((Number(v) || 0).toFixed(2));

function actualCost(product) {
  const metadata = product?.metadata || {};
  const candidates = [metadata.actual_cost, metadata.manual_cost, metadata.last_cost, product?.average_cost];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

async function fetchMpPaymentNet(account, paymentId) {
  const { response } = await mercadoLivreFetch(
    `https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(paymentId))}`,
    account
  );
  const data = await readJson(response);
  if (!response.ok) throw new Error(`Pagamento MP ${paymentId}: HTTP ${response.status}`);
  const exact = Number(data?.transaction_details?.net_received_amount);
  return Number.isFinite(exact) ? exact : null;
}

async function reconcileSaleNet(sale) {
  const orderId = sale?.order_number ? String(sale.order_number) : null;
  if (!orderId) return { net_received_amount: null, status: "unmatched", source: null, order_id: null };

  let rawOrder = null;
  const { data: localOrder, error: localError } = await supabase
    .from("marketplace_orders")
    .select("marketplace_order_id,raw_data")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", orderId)
    .limit(1)
    .maybeSingle();
  if (localError) throw localError;
  rawOrder = localOrder?.raw_data || null;

  let account = null;
  if (!rawOrder) {
    try {
      account = await getMercadoLivreAccount();
      const { response } = await mercadoLivreFetch(`/orders/${encodeURIComponent(orderId)}`, account);
      if (response.ok) rawOrder = await readJson(response);
    } catch (_) {}
  }

  const payments = Array.isArray(rawOrder?.payments) ? rawOrder.payments : [];
  const paymentIds = [...new Set(payments.map(p => p?.id).filter(Boolean).map(String))];
  if (!paymentIds.length) {
    return { net_received_amount: null, status: "pending", source: null, order_id: orderId };
  }

  try {
    account = account || await getMercadoLivreAccount();
    let total = 0;
    let resolved = 0;
    for (const paymentId of paymentIds) {
      const net = await fetchMpPaymentNet(account, paymentId);
      if (net != null) { total += net; resolved += 1; }
    }
    if (resolved !== paymentIds.length) {
      return { net_received_amount: null, status: "pending", source: null, order_id: orderId };
    }
    return {
      net_received_amount: money(total),
      status: "reconciled",
      source: "mercadopago.transaction_details.net_received_amount",
      order_id: orderId,
      payment_ids: paymentIds
    };
  } catch (_) {
    return { net_received_amount: null, status: "pending", source: null, order_id: orderId };
  }
}

router.get("/erp/health", (req, res) => res.json({ sucesso: true, modulo: "Matrix ERP / SIC", baixa_automatica_ml: false }));

router.get("/erp/summary", async (req, res) => {
  try {
    const [{ data: summary, error }, { data: lastRun, error: runError }] = await Promise.all([
      supabase.from("erp_dashboard_summary").select("*").single(),
      supabase.from("erp_sic_import_runs").select("source_file,backup_observed_at,status,summary,finished_at").order("id", { ascending: false }).limit(1).maybeSingle()
    ]);
    if (error) throw error;
    if (runError) throw runError;
    res.json({ sucesso: true, resumo: summary, ultima_importacao: lastRun || null });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/sales", async (req, res) => {
  try {
    const limit = limitOf(req.query.limit, 100, 300), offset = offsetOf(req.query.offset);
    let q = supabase.from("erp_sales_summary").select("*", { count: "exact" }).order("sale_date", { ascending: false }).order("legacy_control", { ascending: false }).range(offset, offset + limit - 1);
    if (req.query.date_from) q = q.gte("sale_date", req.query.date_from);
    if (req.query.date_to) q = q.lte("sale_date", req.query.date_to);
    if (req.query.channel) q = q.ilike("sales_channel_name", `%${String(req.query.channel).slice(0, 80)}%`);
    if (req.query.q) {
      const term = String(req.query.q).slice(0, 100).replace(/[%(),]/g, "");
      if (term) q = q.or(`customer_name.ilike.%${term}%,notes.ilike.%${term}%`);
    }
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ sucesso: true, vendas: data || [], total: count || 0, limit, offset });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/sales/:legacy/items", async (req, res) => {
  try {
    const [{ data: sale, error: saleError }, { data: items, error: itemError }] = await Promise.all([
      supabase.from("erp_sales_summary").select("*").eq("legacy_control", req.params.legacy).single(),
      supabase.from("erp_sale_items").select("*,inventory_products(id,sku,name,product_type,average_cost,metadata)").eq("sale_legacy_control", req.params.legacy).order("legacy_control")
    ]);
    if (saleError) throw saleError;
    if (itemError) throw itemError;

    const detailedItems = (items || []).map(item => {
      const unitCost = actualCost(item.inventory_products);
      return {
        ...item,
        actual_unit_cost: money(unitCost),
        actual_cost_total: money(unitCost * Number(item.quantity || 0))
      };
    });
    const totalCost = money(detailedItems.reduce((sum, item) => sum + Number(item.actual_cost_total || 0), 0));
    const reconciliation = await reconcileSaleNet(sale);
    const net = reconciliation.net_received_amount;
    const profit = net == null ? null : money(net - totalCost);
    const margin = net && net > 0 ? Number(((profit / net) * 100).toFixed(2)) : null;

    res.json({
      sucesso: true,
      venda: sale,
      itens: detailedItems,
      resumo_financeiro: {
        note_total: money(sale.gross_amount),
        real_net_received: net,
        total_cost: totalCost,
        total_profit: profit,
        margin_percent: margin,
        reconciliation_status: reconciliation.status,
        reconciliation_source: reconciliation.source,
        marketplace_order_id: reconciliation.order_id
      }
    });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/customers", async (req, res) => {
  try {
    const limit = limitOf(req.query.limit, 100, 300), offset = offsetOf(req.query.offset);
    let q = supabase.from("erp_sic_customers_stage").select("sic_control,sic_code,name,document_number,document_type,phone,mobile,email,city,state,registered_at,credit_limit,blocked,erp_sic_customer_map(customer_id,match_method)", { count: "exact" }).order("name").range(offset, offset + limit - 1);
    if (req.query.q) {
      const term = String(req.query.q).slice(0, 100).replace(/[%(),]/g, "");
      if (term) q = q.or(`name.ilike.%${term}%,document_number.ilike.%${term}%,sic_code.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,mobile.ilike.%${term}%`);
    }
    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ sucesso: true, clientes: data || [], total: count || 0, limit, offset });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/suppliers", async (req, res) => {
  try {
    const { data, error } = await supabase.from("erp_suppliers").select("*").order("name");
    if (error) throw error;
    res.json({ sucesso: true, fornecedores: data || [] });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/purchases", async (req, res) => {
  try {
    const limit = limitOf(req.query.limit, 100, 300), offset = offsetOf(req.query.offset);
    const { data, error, count } = await supabase.from("erp_purchase_entries").select("*,erp_suppliers(name)", { count: "exact" }).order("entry_date", { ascending: false }).order("legacy_control", { ascending: false }).range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ sucesso: true, entradas: data || [], total: count || 0, limit, offset });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/purchases/:legacy/items", async (req, res) => {
  try {
    const { data, error } = await supabase.from("erp_purchase_items").select("*,inventory_products(sku,name)").eq("purchase_legacy_control", req.params.legacy).order("legacy_control");
    if (error) throw error;
    res.json({ sucesso: true, itens: data || [] });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/quotes", async (req, res) => {
  try {
    const { data, error } = await supabase.from("erp_quotes").select("*").order("quote_date", { ascending: false });
    if (error) throw error;
    res.json({ sucesso: true, orcamentos: data || [] });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/quotes/:legacy/items", async (req, res) => {
  try {
    const { data, error } = await supabase.from("erp_quote_items").select("*,inventory_products(sku,name)").eq("quote_legacy_control", req.params.legacy).order("legacy_control");
    if (error) throw error;
    res.json({ sucesso: true, itens: data || [] });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.get("/erp/sic/import/status", async (req, res) => {
  try {
    const { data, error } = await supabase.from("erp_sic_import_runs").select("source_file,backup_sha256,backup_observed_at,status,summary,finished_at").order("id", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    res.json({ sucesso: true, importacao: data || null, fases: phases });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

router.post("/erp/sic/import/upload", express.raw({ type: ["application/gzip", "application/x-gzip", "application/octet-stream"], limit: "5mb" }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ sucesso: false, mensagem: "Envie o pacote SIC .json.gz validado." });
    const result = registerSicPackage(req.body);
    res.json({ sucesso: true, ...result, fases: phases });
  } catch (e) { res.status(400).json({ sucesso: false, mensagem: e.message }); }
});

router.post("/erp/sic/import/:session/:phase", async (req, res) => {
  try {
    const result = await runSicImportPhase(req.params.session, req.params.phase);
    res.json({ sucesso: true, ...result });
  } catch (e) { res.status(500).json({ sucesso: false, mensagem: e.message }); }
});

module.exports = router;
