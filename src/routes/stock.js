const crypto = require("crypto");
const router = require("express").Router();
const { supabase } = require("../db/supabase");
const { env } = require("../config/env");
const { nowIso } = require("../utils/common");
const {
  getStockBalance,
  previewStockTargets,
  createStockMovement,
  processStockForMarketplaceOrder
} = require("../services/stock");
const {
  importMercadoLivreKits,
  bootstrapMercadoLivreKits
} = require("../services/stock-ml-import");

const BLING_CLIENT_ID = env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = env.BLING_CLIENT_SECRET;
const BLING_REDIRECT_URI = env.BLING_REDIRECT_URI;

function actualCost(product) {
  const metadata = product?.metadata || {};
  for (const value of [metadata.actual_cost, metadata.manual_cost, metadata.last_cost, product?.average_cost]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

async function setActualCost(productId, value, source = "manual") {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Custo inválido.");
  const { data: product, error } = await supabase
    .from("inventory_products")
    .select("metadata")
    .eq("id", productId)
    .single();
  if (error) throw new Error(error.message);
  const metadata = {
    ...(product?.metadata || {}),
    actual_cost: Number(cost.toFixed(4)),
    cost_source: source,
    cost_updated_at: nowIso()
  };
  const result = await supabase
    .from("inventory_products")
    .update({ average_cost: Number(cost.toFixed(4)), metadata, updated_at: nowIso() })
    .eq("id", productId);
  if (result.error) throw new Error(result.error.message);
  return cost;
}

router.get("/stock/health", async (req, res) => {
  res.json({
    sucesso: true,
    modulo: "Stock Matrix",
    bling_configurado: Boolean(BLING_CLIENT_ID && BLING_CLIENT_SECRET && BLING_REDIRECT_URI),
    baixa_automatica_ml: false,
    modo_baixa: "manual_assistido"
  });
});

router.get("/stock/products", async (req, res) => {
  try {
    const { data: stockRows, error } = await supabase
      .from("inventory_stock")
      .select("*")
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);

    const ids = (stockRows || []).map(row => Number(row.product_id)).filter(Boolean);
    let productsById = new Map();
    if (ids.length) {
      const { data: productRows, error: productError } = await supabase
        .from("inventory_products")
        .select("id,product_type,average_cost,metadata")
        .in("id", ids);
      if (productError) throw new Error(productError.message);
      productsById = new Map((productRows || []).map(product => [Number(product.id), product]));
    }

    const produtos = (stockRows || []).map(row => {
      const product = productsById.get(Number(row.product_id)) || row;
      const cost = actualCost(product);
      const isKit = product.product_type === "kit" || row.product_type === "kit";
      return {
        ...row,
        actual_cost: cost,
        average_cost: cost,
        on_hand: isKit ? 0 : Number(row.on_hand || 0),
        reserved: isKit ? 0 : Number(row.reserved || 0),
        available: isKit ? 0 : Number(row.available || 0),
        stock_value: isKit ? 0 : Number((Number(row.on_hand || 0) * cost).toFixed(2)),
        below_minimum: isKit ? false : Boolean(row.below_minimum),
        patrimonial: !isKit
      };
    });
    res.json({ sucesso: true, produtos });
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
    const initialCost = Number(body.actual_cost ?? body.average_cost ?? 0);
    const metadata = {
      ...(body.metadata || {}),
      actual_cost: Number(initialCost.toFixed(4)),
      cost_source: "manual",
      cost_updated_at: nowIso()
    };
    const record = {
      sku: String(body.sku).trim(),
      name: String(body.name).trim(),
      description: body.description || null,
      category: body.category || null,
      product_type: body.product_type || "component",
      unit: body.unit || "UN",
      minimum_stock: Number(body.minimum_stock || 0),
      average_cost: initialCost,
      supplier_name: body.supplier_name || null,
      location_code: body.location_code || null,
      active: body.active !== false,
      metadata,
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

router.patch("/stock/products/:id/manual", async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const body = req.body || {};
    if (!productId) return res.status(400).json({ sucesso: false, mensagem: "Produto inválido." });

    const { data: product, error: productError } = await supabase
      .from("inventory_products")
      .select("id,sku,name,product_type,average_cost,metadata")
      .eq("id", productId)
      .single();
    if (productError) throw new Error(productError.message);
    if (product.product_type === "kit") {
      return res.status(400).json({ sucesso: false, mensagem: "Kit é composição virtual: ajuste quantidade e custo nas peças do kit." });
    }

    const balance = await getStockBalance(productId);
    const previousQuantity = Number(balance.on_hand || 0);
    const previousCost = actualCost(product);
    let quantityChanged = false;
    let costChanged = false;

    if (body.quantity != null) {
      const desiredQuantity = Number(body.quantity);
      if (!Number.isFinite(desiredQuantity)) throw new Error("Quantidade inválida.");
      const delta = Number((desiredQuantity - previousQuantity).toFixed(4));
      if (delta) {
        await createStockMovement({
          productId,
          quantity: delta,
          movementType: "adjustment",
          unitCost: body.actual_cost != null ? Number(body.actual_cost) : previousCost,
          referenceType: "manual_stock_edit",
          referenceId: crypto.randomUUID(),
          idempotencyKey: `manual-edit:${crypto.randomUUID()}`,
          notes: body.notes || "Ajuste manual direto na tela de estoque",
          metadata: { previous_quantity: previousQuantity, new_quantity: desiredQuantity, previous_cost: previousCost }
        });
        quantityChanged = true;
      }
    }

    if (body.actual_cost != null) {
      const newCost = Number(body.actual_cost);
      if (!Number.isFinite(newCost) || newCost < 0) throw new Error("Custo inválido.");
      if (Math.abs(newCost - previousCost) > 0.00001) {
        await setActualCost(productId, newCost, "manual");
        costChanged = true;
        if (!quantityChanged) {
          await createStockMovement({
            productId,
            quantity: 0,
            movementType: "adjustment",
            unitCost: newCost,
            referenceType: "manual_cost_edit",
            referenceId: crypto.randomUUID(),
            idempotencyKey: `manual-cost:${crypto.randomUUID()}`,
            notes: body.notes || "Ajuste manual do custo real",
            metadata: { previous_cost: previousCost, new_cost: newCost }
          });
        }
      }
    }

    const saldo = await getStockBalance(productId);
    res.json({ sucesso: true, alterado: quantityChanged || costChanged, saldo });
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

    const { data: product, error: productError } = await supabase
      .from("inventory_products")
      .select("product_type")
      .eq("id", body.product_id)
      .single();
    if (productError) throw new Error(productError.message);
    if (product?.product_type === "kit") {
      return res.status(400).json({ sucesso: false, mensagem: "Kit não possui estoque próprio. Movimente apenas os componentes." });
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
      await setActualCost(body.product_id, body.unit_cost, "stock_entry");
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

router.get("/stock/bom/:parentProductId", async (req, res) => {
  try {
    const parentProductId = Number(req.params.parentProductId);
    if (!parentProductId) return res.status(400).json({ sucesso: false, mensagem: "Kit inválido." });
    const { data: components, error: bomError } = await supabase.from("inventory_bom_components").select("id,parent_product_id,component_product_id,quantity,notes").eq("parent_product_id", parentProductId).order("id", { ascending: true });
    if (bomError) throw new Error(bomError.message);
    const componentRows = components || [];
    let substitutes = [];
    if (componentRows.length) {
      const componentIds = componentRows.map(row => Number(row.id));
      const result = await supabase.from("inventory_bom_substitutes").select("id,bom_component_id,substitute_product_id,priority,quantity_factor,notes,active").in("bom_component_id", componentIds).eq("active", true).order("priority", { ascending: true }).order("id", { ascending: true });
      if (result.error) throw new Error(result.error.message);
      substitutes = result.data || [];
    }
    const substitutesByComponent = new Map();
    for (const substitute of substitutes) {
      const key = Number(substitute.bom_component_id);
      if (!substitutesByComponent.has(key)) substitutesByComponent.set(key, []);
      substitutesByComponent.get(key).push(substitute);
    }
    res.json({ sucesso: true, parent_product_id: parentProductId, componentes: componentRows.map(component => ({ ...component, substitutes: substitutesByComponent.get(Number(component.id)) || [] })) });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.post("/stock/bom", async (req, res) => {
  try {
    const { parent_product_id, components } = req.body || {};
    const parentProductId = Number(parent_product_id);
    if (!parentProductId || !Array.isArray(components)) return res.status(400).json({ sucesso: false, mensagem: "parent_product_id e components são obrigatórios." });
    if (!components.length) return res.status(400).json({ sucesso: false, mensagem: "Kit precisa ter ao menos um componente físico." });

    const normalized = components.map((component, index) => {
      const componentProductId = Number(component?.component_product_id || 0);
      const quantity = Number(component?.quantity || 0);
      const rawSubstitutes = Array.isArray(component?.substitutes) ? component.substitutes : (component?.substitute_product_id ? [{ substitute_product_id: component.substitute_product_id }] : []);
      const substitutes = rawSubstitutes.map((substitute, substituteIndex) => ({
        substitute_product_id: Number(substitute?.substitute_product_id || substitute?.product_id || 0),
        priority: Number(substitute?.priority || substituteIndex + 1),
        quantity_factor: Number(substitute?.quantity_factor || 1),
        notes: substitute?.notes || null
      }));
      return { index, component_product_id: componentProductId, quantity, notes: component?.notes || null, substitutes };
    });

    const seenComponents = new Set();
    const allProductIds = new Set([parentProductId]);
    for (const component of normalized) {
      if (!component.component_product_id || !(component.quantity > 0)) return res.status(400).json({ sucesso: false, mensagem: "Todos os componentes precisam ter produto e quantidade maior que zero." });
      if (component.component_product_id === parentProductId) return res.status(400).json({ sucesso: false, mensagem: "O kit não pode ser componente dele mesmo." });
      if (seenComponents.has(component.component_product_id)) return res.status(400).json({ sucesso: false, mensagem: "O mesmo componente principal foi informado mais de uma vez." });
      seenComponents.add(component.component_product_id);
      allProductIds.add(component.component_product_id);
      const seenSubstitutes = new Set();
      for (const substitute of component.substitutes) {
        if (!substitute.substitute_product_id || !(substitute.quantity_factor > 0) || !(substitute.priority > 0)) return res.status(400).json({ sucesso: false, mensagem: "Substituto inválido na composição do kit." });
        if (substitute.substitute_product_id === component.component_product_id) return res.status(400).json({ sucesso: false, mensagem: "O substituto precisa ser diferente da peça principal." });
        if (substitute.substitute_product_id === parentProductId) return res.status(400).json({ sucesso: false, mensagem: "O próprio kit não pode ser usado como substituto." });
        if (seenSubstitutes.has(substitute.substitute_product_id)) return res.status(400).json({ sucesso: false, mensagem: "O mesmo substituto foi informado mais de uma vez para uma peça." });
        seenSubstitutes.add(substitute.substitute_product_id);
        allProductIds.add(substitute.substitute_product_id);
      }
    }

    const { data: existingProducts, error: productsError } = await supabase.from("inventory_products").select("id,product_type,active").in("id", [...allProductIds]);
    if (productsError) throw new Error(productsError.message);
    const existingIds = new Set((existingProducts || []).map(product => Number(product.id)));
    const missingIds = [...allProductIds].filter(id => !existingIds.has(Number(id)));
    if (missingIds.length) return res.status(400).json({ sucesso: false, mensagem: `Produtos inexistentes na composição: ${missingIds.join(", ")}.` });
    const parent = (existingProducts || []).find(product => Number(product.id) === parentProductId);
    if (parent?.product_type !== "kit") return res.status(400).json({ sucesso: false, mensagem: "O produto principal precisa ser do tipo Kit / PC." });

    const { error: deleteError } = await supabase.from("inventory_bom_components").delete().eq("parent_product_id", parentProductId);
    if (deleteError) throw new Error(deleteError.message);
    const componentRows = normalized.map(component => ({ parent_product_id: parentProductId, component_product_id: component.component_product_id, quantity: component.quantity, notes: component.notes }));
    const { data: savedComponents, error: insertError } = await supabase.from("inventory_bom_components").insert(componentRows).select("id,component_product_id");
    if (insertError) throw new Error(insertError.message);
    const savedByProductId = new Map((savedComponents || []).map(row => [Number(row.component_product_id), Number(row.id)]));
    const substituteRows = [];
    for (const component of normalized) {
      const bomComponentId = savedByProductId.get(component.component_product_id);
      for (const substitute of component.substitutes) substituteRows.push({ bom_component_id: bomComponentId, substitute_product_id: substitute.substitute_product_id, priority: substitute.priority, quantity_factor: substitute.quantity_factor, notes: substitute.notes, active: true, updated_at: nowIso() });
    }
    if (substituteRows.length) {
      const { error: substituteError } = await supabase.from("inventory_bom_substitutes").insert(substituteRows);
      if (substituteError) { await supabase.from("inventory_bom_components").delete().eq("parent_product_id", parentProductId); throw new Error(substituteError.message); }
    }
    res.json({ sucesso: true, componentes: normalized.length, substitutos: substituteRows.length });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.get("/stock/bom/:parentProductId/preview", async (req, res) => {
  try {
    const parentProductId = Number(req.params.parentProductId);
    const quantity = Number(req.query.quantity || 1);
    if (!parentProductId || !(quantity > 0)) return res.status(400).json({ sucesso: false, mensagem: "Kit ou quantidade inválida." });
    const preview = await previewStockTargets(parentProductId, quantity);
    res.json({ sucesso: true, preview });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.post("/stock/process-order/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await processStockForMarketplaceOrder(req.params.id, { confirmed: body.confirmed === true, decisions: Array.isArray(body.decisions) ? body.decisions : [] });
    res.json({ sucesso: true, resultado: result });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.get("/stock/low", async (req, res) => {
  try {
    const { data, error } = await supabase.from("inventory_stock").select("*").eq("below_minimum", true).order("available", { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ sucesso: true, produtos: (data || []).filter(row => row.product_type !== "kit") });
  } catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

router.post("/stock/import/mercadolivre-kits", async (req, res) => {
  try { const result = await importMercadoLivreKits(); res.json({ sucesso: true, resultado: result }); }
  catch (erro) { res.status(500).json({ sucesso: false, mensagem: erro.message }); }
});

setTimeout(() => {
  bootstrapMercadoLivreKits().then(result => console.log("[ESTOQUE ML] bootstrap:", result)).catch(error => console.error("[ESTOQUE ML] erro no bootstrap:", error));
}, 8000).unref?.();

module.exports = router;
