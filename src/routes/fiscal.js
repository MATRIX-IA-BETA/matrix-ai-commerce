const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");

function summarizeOrder(order, doc, settings) {
  const raw = order.raw_data || {};
  const items = Array.isArray(raw.order_items) ? raw.order_items : [];
  const payments = Array.isArray(raw.payments) ? raw.payments : [];
  const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
  const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
  const buyer = raw.buyer || {};
  const buyerName = [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim() || buyer.nickname || "Cliente Mercado Livre";
  const productTitle = items.length ? items.map(i => i?.item?.title || "Produto").join(" + ") : "Produto Mercado Livre";
  const quantity = items.reduce((sum, i) => sum + Number(i?.quantity || 0), 0);

  let suggestedValue = Number(settings?.default_discount_percent || 0);
  if (settings?.suggest_ml_commission_as_discount && gross > 0 && commission > 0) {
    suggestedValue = Number(((commission / gross) * 100).toFixed(4));
  }

  return {
    marketplace_order_id: String(order.marketplace_order_id),
    date_created: order.date_created,
    marketplace_status: order.status || raw.status || null,
    buyer_name: String(buyerName),
    product_title: productTitle,
    quantity,
    gross_amount: Number(gross.toFixed(2)),
    commission_amount: Number(commission.toFixed(2)),
    suggested_discount_type: "percent",
    suggested_discount_value: suggestedValue,
    fiscal: doc || null
  };
}

router.get("/fiscal/health", (req, res) => {
  res.json({ sucesso: true, modulo: "fiscal", painel: "/fiscal-nfe.html" });
});

router.get("/fiscal/settings", async (req, res) => {
  try {
    res.json({ sucesso: true, configuracao: await getFiscalSettings() });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.put("/fiscal/settings", async (req, res) => {
  try {
    const body = req.body || {};
    const record = {
      id: 1,
      default_discount_percent: Number(body.default_discount_percent || 0),
      suggest_ml_commission_as_discount: body.suggest_ml_commission_as_discount !== false,
      require_manual_confirmation: false,
      updated_at: nowIso()
    };
    const { data, error } = await supabase.from("fiscal_settings").upsert(record, { onConflict: "id" }).select("*").single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, configuracao: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/fiscal/queue", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const { data: orders, error: ordersError } = await supabase
      .from("marketplace_orders")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .order("date_created", { ascending: false })
      .limit(limit);
    if (ordersError) throw new Error(ordersError.message);

    const ids = (orders || []).map(o => String(o.marketplace_order_id));
    let docs = [];
    if (ids.length) {
      const { data, error } = await supabase.from("fiscal_documents").select("*").in("marketplace_order_id", ids);
      if (error) throw new Error(error.message);
      docs = data || [];
    }

    const byOrder = new Map(docs.map(d => [String(d.marketplace_order_id), d]));
    const settings = await getFiscalSettings();
    const queue = (orders || []).map(order => summarizeOrder(order, byOrder.get(String(order.marketplace_order_id)) || null, settings));
    res.json({ sucesso: true, total: queue.length, pedidos: queue });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/fiscal/preview/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const { data: order, error } = await supabase.from("marketplace_orders").select("*").eq("marketplace", "mercadolivre").eq("marketplace_order_id", orderId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return res.status(404).json({ sucesso: false, mensagem: "Pedido não encontrado." });

    const settings = await getFiscalSettings();
    const payments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];
    const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
    const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
    const freight = Number(req.body?.freight_amount || 0);

    let discountType = req.body?.discount_type;
    let discountValue = req.body?.discount_value;
    const legacyDiscountPercent = req.body?.discount_percent;
    if (discountType == null && discountValue == null && legacyDiscountPercent == null) {
      discountType = "percent";
      discountValue = settings.suggest_ml_commission_as_discount && gross > 0 && commission > 0
        ? (commission / gross) * 100
        : Number(settings.default_discount_percent || 0);
    }

    const preview = calculateFiscalPreview({
      grossAmount: gross,
      commissionAmount: commission,
      freightAmount: freight,
      discountType,
      discountValue,
      discountPercent: legacyDiscountPercent
    });

    const record = {
      marketplace_order_id: orderId,
      gross_amount: preview.gross_amount,
      commission_amount: preview.commission_amount,
      freight_amount: preview.freight_amount,
      operational_net_amount: preview.operational_net_amount,
      discount_type: preview.discount_type,
      discount_value: preview.discount_value,
      discount_amount: preview.discount_amount,
      discount_percent: preview.discount_percent,
      fiscal_amount: preview.fiscal_amount,
      status: "preview",
      updated_at: nowIso()
    };

    const { data: doc, error: docError } = await supabase.from("fiscal_documents").upsert(record, { onConflict: "marketplace_order_id" }).select("*").single();
    if (docError) throw new Error(docError.message);
    res.json({ sucesso: true, fiscal: doc });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

module.exports = router;
