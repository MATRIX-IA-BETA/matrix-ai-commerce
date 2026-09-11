const router = require("express").Router();
const { supabase } = require("../db/supabase");

router.get("/stock/movements", async (req, res) => {
  try {
    const requested = Number(req.query.limit || 80);
    const limit = Math.max(1, Math.min(300, Number.isFinite(requested) ? requested : 80));
    const { data, error } = await supabase
      .from("inventory_movements")
      .select("id,product_id,quantity,movement_type,unit_cost,reference_type,reference_id,marketplace_order_id,notes,metadata,created_at,inventory_products!inventory_movements_product_id_fkey(sku,name)")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    const movimentos = (data || []).map(row => ({
      id: row.id, product_id: row.product_id,
      product_sku: row.inventory_products?.sku || null,
      product_name: row.inventory_products?.name || null,
      quantity: Number(row.quantity || 0), movement_type: row.movement_type,
      unit_cost: row.unit_cost == null ? null : Number(row.unit_cost),
      reference_type: row.reference_type, reference_id: row.reference_id,
      marketplace_order_id: row.marketplace_order_id, notes: row.notes,
      metadata: row.metadata || {}, created_at: row.created_at
    }));
    res.json({ sucesso: true, movimentos });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.use(require("./marketplace-sale-management").router);
router.use(require("./marketplace-sale-actions"));
router.use(require("./sales-center-list"));
router.use(require("./sic-sales-financials"));
router.use(require("./stock-sale-posting"));
module.exports = router;
