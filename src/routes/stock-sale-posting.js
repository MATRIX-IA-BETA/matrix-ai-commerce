const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { processStockForMarketplaceOrder } = require("../services/stock");
const { getSellerProceeds } = require("../services/ml-sale-proceeds");
const { blingFetch } = require("../services/bling");

const money = value => Number((Number(value) || 0).toFixed(2));
const roi = (profit, cost) => {
  const p = Number(profit);
  const c = Number(cost);
  return Number.isFinite(p) && Number.isFinite(c) && c > 0
    ? Number(((p / c) * 100).toFixed(2))
    : null;
};

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function fetchNfeAmount(orderId) {
  const { data: doc, error } = await supabase
    .from("fiscal_documents")
    .select("marketplace_order_id,fiscal_amount,nfe_number,nfe_access_key,bling_nfe_id,status")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();
  if (error) throw error;
  if (!doc) return { amount: null, number: null, key: null, source: null };

  let amount = Number.isFinite(Number(doc.fiscal_amount)) ? Number(doc.fiscal_amount) : null;
  let source = amount != null ? "fiscal_documents.fiscal_amount" : null;

  if (doc.bling_nfe_id) {
    try {
      const response = await blingFetch(`/nfe/${encodeURIComponent(String(doc.bling_nfe_id))}`, { method: "GET" });
      const payload = await readJson(response);
      if (response.ok) {
        const d = payload?.data || payload || {};
        const totals = d?.totais || d?.total || {};
        const exact = firstNumber(
          d?.valorNota,
          d?.valorTotal,
          d?.totalNota,
          typeof d?.total === "number" ? d.total : null,
          totals?.valorNota,
          totals?.valorTotal,
          totals?.totalNota,
          totals?.total
        );
        if (exact != null) {
          amount = money(exact);
          source = "bling.nfe.valor_total";
          await supabase
            .from("fiscal_documents")
            .update({ fiscal_amount: amount, updated_at: nowIso() })
            .eq("marketplace_order_id", String(orderId));
        }
      }
    } catch (_) {}
  }

  return {
    amount: amount == null ? null : money(amount),
    number: doc.nfe_number || null,
    key: doc.nfe_access_key || null,
    source
  };
}

async function movementCost(orderId) {
  const { data, error } = await supabase
    .from("inventory_movements")
    .select("quantity,unit_cost")
    .eq("marketplace_order_id", String(orderId))
    .eq("movement_type", "sale");
  if (error) throw error;
  return money((data || []).reduce(
    (sum, row) => sum + Math.abs(Number(row.quantity || 0)) * Number(row.unit_cost || 0),
    0
  ));
}

async function existingFinancial(orderId) {
  const { data, error } = await supabase
    .from("marketplace_sale_financials")
    .select("*")
    .eq("marketplace_order_id", String(orderId))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function postOne(orderId) {
  const id = String(orderId);
  const before = await existingFinancial(id);

  const stock = await processStockForMarketplaceOrder(id, {
    confirmed: true,
    decisions: []
  });

  if (!stock.processed) {
    const message = stock.reason === "stock_decision_required"
      ? "Estoque insuficiente ou substituição pendente."
      : stock.reason === "missing_inventory_links"
        ? "Produto da venda sem vínculo com o estoque."
        : stock.reason === "order_not_found"
          ? "Pedido não encontrado na Matrix."
          : `Venda não lançada no estoque: ${stock.reason || "motivo desconhecido"}.`;
    throw new Error(message);
  }

  const [freshCost, proceeds, nfe] = await Promise.all([
    movementCost(id),
    getSellerProceeds(id),
    fetchNfeAmount(id)
  ]);

  // Se a venda já havia sido processada e o custo foi corrigido manualmente
  // depois, não recalculamos por movimentos históricos antigos.
  const cost = before?.stock_status === "posted" && before?.total_cost != null
    ? money(before.total_cost)
    : freshCost;

  // A MESMA fonte usada pelo botão Atualizar é a fonte principal do lançamento
  // feito pela tela Fiscal. Se o ML não trouxer o detalhamento completo, o valor
  // anterior é preservado em vez de ser substituído por um número duvidoso.
  const actualNet = proceeds.net != null
    ? money(proceeds.net)
    : (before?.actual_net_received != null ? money(before.actual_net_received) : null);

  const profit = actualNet == null ? null : money(actualNet - cost);
  const margin = roi(profit, cost);
  const cancelled = String(stock.status || "").toLowerCase() === "cancelled";

  const metadata = {
    ...(before?.metadata || {}),
    nfe_source: nfe.source || before?.metadata?.nfe_source || null,
    stock_result: stock,
    financial_breakdown: proceeds.breakdown || before?.metadata?.financial_breakdown || null,
    financial_source_unified_at: nowIso()
  };

  const record = {
    marketplace_order_id: id,
    marketplace: "mercadolivre",
    stock_status: cancelled ? "reversed" : "posted",
    stock_posted_at: before?.stock_posted_at || nowIso(),
    actual_net_received: actualNet,
    total_cost: cost,
    total_profit: profit,
    margin_percent: margin,
    nfe_amount: nfe.amount ?? before?.nfe_amount ?? null,
    nfe_number: nfe.number ?? before?.nfe_number ?? null,
    nfe_access_key: nfe.key ?? before?.nfe_access_key ?? null,
    reconciliation_status: proceeds.net != null
      ? proceeds.status
      : (before?.reconciliation_status || "pending"),
    reconciliation_source: proceeds.net != null
      ? proceeds.source
      : (before?.reconciliation_source || null),
    payment_ids: proceeds.paymentIds?.length
      ? proceeds.paymentIds
      : (before?.payment_ids || []),
    metadata,
    updated_at: nowIso()
  };

  const { data, error } = await supabase
    .from("marketplace_sale_financials")
    .upsert(record, { onConflict: "marketplace_order_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

router.post("/stock/post-sales", async (req, res) => {
  try {
    const ids = [...new Set(
      (Array.isArray(req.body?.order_ids) ? req.body.order_ids : [])
        .map(String)
        .filter(Boolean)
    )].slice(0, 300);

    if (!ids.length) {
      return res.status(400).json({
        sucesso: false,
        mensagem: "Selecione ao menos uma venda."
      });
    }

    const results = [];
    for (const orderId of ids) {
      try {
        const data = await postOne(orderId);
        results.push({ order_id: orderId, sucesso: true, data });
      } catch (error) {
        results.push({ order_id: orderId, sucesso: false, mensagem: error.message });
      }
    }

    const ok = results.filter(r => r.sucesso).length;
    res.json({
      sucesso: true,
      processadas: ok,
      erros: results.length - ok,
      resultados: results
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/stock/sale-posting-status", async (req, res) => {
  try {
    const ids = [...new Set(
      String(req.query.order_ids || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    )].slice(0, 300);

    if (!ids.length) return res.json({ sucesso: true, vendas: [] });

    const { data, error } = await supabase
      .from("marketplace_sale_financials")
      .select("*")
      .in("marketplace_order_id", ids);
    if (error) throw error;

    res.json({ sucesso: true, vendas: data || [] });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/erp/sale-financials", async (req, res) => {
  try {
    const legacy = [...new Set(
      String(req.query.legacy_controls || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    )].slice(0, 300);

    if (!legacy.length) return res.json({ sucesso: true, vendas: [] });

    const { data: sales, error: salesError } = await supabase
      .from("erp_sales_summary")
      .select("legacy_control,order_number")
      .in("legacy_control", legacy);
    if (salesError) throw salesError;

    const orderIds = [...new Set(
      (sales || []).map(s => s.order_number).filter(Boolean).map(String)
    )];

    let financials = [];
    let docs = [];
    if (orderIds.length) {
      const [f, d] = await Promise.all([
        supabase
          .from("marketplace_sale_financials")
          .select("*")
          .in("marketplace_order_id", orderIds),
        supabase
          .from("fiscal_documents")
          .select("marketplace_order_id,fiscal_amount,nfe_number,nfe_access_key,status")
          .in("marketplace_order_id", orderIds)
      ]);
      if (f.error) throw f.error;
      if (d.error) throw d.error;
      financials = f.data || [];
      docs = d.data || [];
    }

    const fMap = new Map(financials.map(x => [String(x.marketplace_order_id), x]));
    const dMap = new Map(docs.map(x => [String(x.marketplace_order_id), x]));

    const vendas = (sales || []).map(s => {
      const orderId = s.order_number ? String(s.order_number) : null;
      const f = orderId ? fMap.get(orderId) : null;
      const d = orderId ? dMap.get(orderId) : null;
      return {
        legacy_control: s.legacy_control,
        marketplace_order_id: orderId,
        stock_status: f?.stock_status || "pending",
        nfe_amount: f?.nfe_amount ?? (d?.fiscal_amount != null ? money(d.fiscal_amount) : null),
        actual_net_received: f?.actual_net_received ?? null,
        total_cost: f?.total_cost ?? null,
        total_profit: f?.total_profit ?? null,
        margin_percent: f?.margin_percent ?? null
      };
    });

    res.json({ sucesso: true, vendas });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
