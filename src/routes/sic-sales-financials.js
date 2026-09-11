const router = require("express").Router();
const { supabase } = require("../db/supabase");

const money = value => Number((Number(value) || 0).toFixed(2));

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function actualCost(product) {
  const metadata = product?.metadata || {};
  for (const value of [metadata.actual_cost, metadata.manual_cost, metadata.last_cost, product?.average_cost]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

router.get("/erp/sales/:legacy/items", async (req, res) => {
  try {
    const [{ data: sale, error: saleError }, { data: items, error: itemError }] = await Promise.all([
      supabase.from("erp_sales_summary").select("*").eq("legacy_control", req.params.legacy).single(),
      supabase
        .from("erp_sale_items")
        .select("*,inventory_products(id,sku,name,product_type,average_cost,metadata)")
        .eq("sale_legacy_control", req.params.legacy)
        .order("legacy_control")
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

    const currentCost = money(detailedItems.reduce((sum, item) => sum + Number(item.actual_cost_total || 0), 0));
    const sicNet = finite(sale.net_amount);
    const sicProfit = finite(sale.profit_amount);

    // O SIC já traz o valor líquido realmente recebido. Essa é a fonte principal.
    // Se um registro antigo vier sem líquido, recuperamos pela identidade:
    // recebido = lucro SIC + custo.
    const net = sicNet != null
      ? money(sicNet)
      : sicProfit != null
        ? money(sicProfit + currentCost)
        : null;

    // O lucro mostrado como real usa o custo atual/cadastrado na Matrix.
    // Assim, para registros com líquido SIC: lucro real = recebido - custo real.
    const realProfit = net == null ? null : money(net - currentCost);
    const margin = net != null && net > 0
      ? Number(((realProfit / net) * 100).toFixed(2))
      : null;

    res.json({
      sucesso: true,
      venda: sale,
      itens: detailedItems,
      resumo_financeiro: {
        note_total: money(sale.gross_amount),
        real_net_received: net,
        total_cost: currentCost,
        total_profit: realProfit,
        margin_percent: margin,
        reconciliation_status: net == null ? "pending" : "reconciled",
        reconciliation_source: sicNet != null ? "sic.net_amount" : sicProfit != null ? "sic.profit_amount_plus_cost" : null,
        marketplace_order_id: sale.order_number ? String(sale.order_number) : null,
        sic_profit_amount: sicProfit == null ? null : money(sicProfit)
      }
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

router.get("/erp/sale-financials", async (req, res) => {
  try {
    const legacy = [...new Set(
      String(req.query.legacy_controls || "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean)
    )].slice(0, 300);

    if (!legacy.length) return res.json({ sucesso: true, vendas: [] });

    const { data: sales, error: salesError } = await supabase
      .from("erp_sales_summary")
      .select("legacy_control,order_number,net_amount,profit_amount")
      .in("legacy_control", legacy);
    if (salesError) throw salesError;

    const orderIds = [...new Set((sales || []).map(sale => sale.order_number).filter(Boolean).map(String))];
    let docs = [];
    if (orderIds.length) {
      const result = await supabase
        .from("fiscal_documents")
        .select("marketplace_order_id,fiscal_amount,nfe_number,nfe_access_key,status")
        .in("marketplace_order_id", orderIds);
      if (result.error) throw result.error;
      docs = result.data || [];
    }

    const docsByOrder = new Map(docs.map(doc => [String(doc.marketplace_order_id), doc]));

    const vendas = (sales || []).map(sale => {
      const orderId = sale.order_number ? String(sale.order_number) : null;
      const doc = orderId ? docsByOrder.get(orderId) : null;
      const net = finite(sale.net_amount);
      const profit = finite(sale.profit_amount);
      const cost = net != null && profit != null ? money(net - profit) : null;
      const margin = net != null && net > 0 && profit != null
        ? Number(((profit / net) * 100).toFixed(2))
        : null;

      return {
        legacy_control: sale.legacy_control,
        marketplace_order_id: orderId,
        stock_status: "sic_imported",
        nfe_amount: doc?.fiscal_amount != null ? money(doc.fiscal_amount) : null,
        actual_net_received: net == null ? null : money(net),
        total_cost: cost,
        total_profit: profit == null ? null : money(profit),
        margin_percent: margin,
        reconciliation_status: net == null ? "pending" : "reconciled",
        reconciliation_source: net == null ? null : "sic.net_amount"
      };
    });

    res.json({ sucesso: true, vendas });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: error.message });
  }
});

module.exports = router;
