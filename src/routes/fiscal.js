const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");
const { getFiscalSettings, calculateFiscalPreview } = require("../services/fiscal");

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
      require_manual_confirmation: body.require_manual_confirmation !== false,
      updated_at: nowIso()
    };

    const { data, error } = await supabase
      .from("fiscal_settings")
      .upsert(record, { onConflict: "id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, configuracao: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/fiscal/preview/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId);
    const { data: order, error } = await supabase
      .from("marketplace_orders")
      .select("*")
      .eq("marketplace", "mercadolivre")
      .eq("marketplace_order_id", orderId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return res.status(404).json({ sucesso: false, mensagem: "Pedido não encontrado." });

    const settings = await getFiscalSettings();
    const payments = Array.isArray(order.raw_data?.payments) ? order.raw_data.payments : [];
    const commission = payments.reduce((sum, p) => sum + Math.abs(Number(p?.marketplace_fee || 0)), 0);
    const gross = Number(order.paid_amount ?? order.total_amount ?? 0);
    const freight = Number(req.body?.freight_amount || 0);

    let discount = req.body?.discount_percent;
    if (discount == null) {
      if (settings.suggest_ml_commission_as_discount && gross > 0 && commission > 0) {
        discount = (commission / gross) * 100;
      } else {
        discount = settings.default_discount_percent || 0;
      }
    }

    const preview = calculateFiscalPreview({
      grossAmount: gross,
      commissionAmount: commission,
      freightAmount: freight,
      discountPercent: discount
    });

    const { data: doc, error: docError } = await supabase
      .from("fiscal_documents")
      .upsert({
        marketplace_order_id: orderId,
        gross_amount: preview.gross_amount,
        commission_amount: preview.commission_amount,
        freight_amount: preview.freight_amount,
        operational_net_amount: preview.operational_net_amount,
        discount_percent: preview.discount_percent,
        fiscal_amount: preview.fiscal_amount,
        status: "preview",
        updated_at: nowIso()
      }, { onConflict: "marketplace_order_id" })
      .select("*")
      .single();
    if (docError) throw new Error(docError.message);

    res.json({ sucesso: true, fiscal: doc });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

// ----- Bling OAuth -----

module.exports = router;
