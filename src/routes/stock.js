const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");
const {
  getStockBalance,
  createStockMovement,
  processStockForMarketplaceOrder
} = require("../services/stock");

const BLING_CLIENT_ID = env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = env.BLING_REDIRECT_URI;

router.get("/stock/health", async (req, res) => {
  res.json({
    sucesso: true,
    modulo: "Stock Matrix",
    bling_configurado: Boolean(BLING_CLIENT_ID && BLING_CLIENT_SECRET && BLING_REDIRECT_URI)
  });
});

router.get("/stock/products", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("inventory_stock")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, produtos: data || [] });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/stock/products", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.sku || !body.name) {
      return res.status(400).json({ sucesso: false, mensagem: "SKU e nome são obrigatórios." });
    }

    const record = {
      sku: String(body.sku).trim(),
      name: String(body.name).trim(),
      description: body.description || null,
      category: body.category || null,
      product_type: body.product_type || "component",
      unit: body.unit || "UN",
      minimum_stock: Number(body.minimum_stock || 0),
      average_cost: Number(body.average_cost || 0),
      supplier_name: body.supplier_name || null,
      location_code: body.location_code || null,
      active: body.active !== false,
      metadata: body.metadata || {},
      updated_at: nowIso()
    };

    const { data, error } = await supabase
      .from("inventory_products")
      .upsert(record, { onConflict: "sku" })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    res.json({ sucesso: true, produto: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/stock/movements", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.product_id || body.quantity == null || !body.movement_type) {
      return res.status(400).json({ sucesso: false, mensagem: "product_id, quantity e movement_type são obrigatórios." });
    }

    const movement = await createStockMovement({
      productId: body.product_id,
      quantity: body.quantity,
      movementType: body.movement_type,
      unitCost: body.unit_cost,
      referenceType: body.reference_type,
      referenceId: body.reference_id,
      notes: body.notes,
      metadata: body.metadata || {},
      idempotencyKey: body.idempotency_key || `manual:${crypto.randomUUID()}`
    });

    if (Number(body.quantity) > 0 && body.unit_cost != null) {
      const balance = await getStockBalance(body.product_id);
      const incomingQty = Number(body.quantity);
      const incomingCost = Number(body.unit_cost);
      const previousQty = Math.max(0, Number(balance.on_hand || 0) - incomingQty);

      const { data: product } = await supabase
        .from("inventory_products")
        .select("average_cost")
        .eq("id", body.product_id)
        .single();

      const previousCost = Number(product?.average_cost || 0);
      const newCost = (previousQty + incomingQty) > 0
        ? ((previousQty * previousCost) + (incomingQty * incomingCost)) / (previousQty + incomingQty)
        : incomingCost;

      await supabase
        .from("inventory_products")
        .update({ average_cost: Number(newCost.toFixed(4)), updated_at: nowIso() })
        .eq("id", body.product_id);
    }

    const saldo = await getStockBalance(body.product_id);
    res.json({ sucesso: true, movimento: movement, saldo });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/stock/links/mercadolivre", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.product_id || !body.external_item_id) {
      return res.status(400).json({ sucesso: false, mensagem: "product_id e external_item_id são obrigatórios." });
    }

    const record = {
      product_id: body.product_id,
      marketplace: "mercadolivre",
      account_id: body.account_id || null,
      external_item_id: String(body.external_item_id),
      external_user_product_id: body.external_user_product_id ? String(body.external_user_product_id) : null,
      variation_id: body.variation_id != null ? String(body.variation_id) : null,
      seller_sku: body.seller_sku || null,
      sync_enabled: body.sync_enabled !== false,
      updated_at: nowIso()
    };

    const { data, error } = await supabase
      .from("inventory_marketplace_links")
      .upsert(record, { onConflict: "marketplace,external_item_id,variation_id" })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, vinculo: data });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/stock/bom", async (req, res) => {
  try {
    const { parent_product_id, components } = req.body || {};
    if (!parent_product_id || !Array.isArray(components)) {
      return res.status(400).json({ sucesso: false, mensagem: "parent_product_id e components são obrigatórios." });
    }

    await supabase.from("inventory_bom_components").delete().eq("parent_product_id", parent_product_id);

    if (components.length) {
      const rows = components.map(c => ({
        parent_product_id,
        component_product_id: c.component_product_id,
        quantity: Number(c.quantity || 0),
        notes: c.notes || null
      }));
      const { error } = await supabase.from("inventory_bom_components").insert(rows);
      if (error) throw new Error(error.message);
    }

    res.json({ sucesso: true, componentes: components.length });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.post("/stock/process-order/:id", async (req, res) => {
  try {
    const result = await processStockForMarketplaceOrder(req.params.id);
    res.json({ sucesso: true, resultado: result });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});

router.get("/stock/low", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("inventory_stock")
      .select("*")
      .eq("below_minimum", true)
      .order("available", { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, produtos: data || [] });
  } catch (erro) {
    res.status(500).json({ sucesso: false, mensagem: erro.message });
  }
});


module.exports = router;
