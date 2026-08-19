const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");

async function getStockBalance(productId) {
  const { data, error } = await supabase
    .from("inventory_stock")
    .select("*")
    .eq("product_id", productId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro consultando saldo: ${error.message}`);
  }

  return data || {
    product_id: productId,
    on_hand: 0,
    reserved: 0,
    available: 0
  };
}

async function resolveStockTargets(productId, multiplier = 1) {
  const { data: product, error: productError } = await supabase
    .from("inventory_products")
    .select("id,sku,name,product_type,average_cost")
    .eq("id", productId)
    .single();

  if (productError) {
    throw new Error(`Produto de estoque não encontrado: ${productError.message}`);
  }

  if (product.product_type !== "kit") {
    return [{
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      quantity: Number(multiplier),
      unit_cost: Number(product.average_cost || 0)
    }];
  }

  const { data: components, error: bomError } = await supabase
    .from("inventory_bom_components")
    .select("component_product_id,quantity,inventory_products!inventory_bom_components_component_product_id_fkey(sku,name,average_cost)")
    .eq("parent_product_id", productId);

  if (bomError) {
    throw new Error(`Erro lendo composição do kit: ${bomError.message}`);
  }

  if (!components || components.length === 0) {
    return [{
      product_id: product.id,
      sku: product.sku,
      name: product.name,
      quantity: Number(multiplier),
      unit_cost: Number(product.average_cost || 0)
    }];
  }

  return components.map(component => ({
    product_id: component.component_product_id,
    sku: component.inventory_products?.sku || null,
    name: component.inventory_products?.name || null,
    quantity: Number(component.quantity || 0) * Number(multiplier),
    unit_cost: Number(component.inventory_products?.average_cost || 0)
  }));
}

async function createStockMovement({
  productId,
  quantity,
  movementType,
  unitCost = null,
  referenceType = null,
  referenceId = null,
  marketplaceOrderId = null,
  idempotencyKey = null,
  notes = null,
  metadata = {}
}) {
  const record = {
    product_id: productId,
    quantity: Number(quantity),
    movement_type: movementType,
    unit_cost: unitCost == null ? null : Number(unitCost),
    reference_type: referenceType,
    reference_id: referenceId == null ? null : String(referenceId),
    marketplace_order_id: marketplaceOrderId == null ? null : String(marketplaceOrderId),
    idempotency_key: idempotencyKey,
    notes,
    metadata,
    created_at: nowIso()
  };

  const { data, error } = await supabase
    .from("inventory_movements")
    .upsert(record, {
      onConflict: "idempotency_key",
      ignoreDuplicates: true
    })
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Erro gravando movimento de estoque: ${error.message}`);
  }

  return data;
}

async function findInventoryLink(itemId, variationId = null) {
  let query = supabase
    .from("inventory_marketplace_links")
    .select("id,product_id,external_item_id,variation_id,seller_sku,sync_enabled")
    .eq("marketplace", "mercadolivre")
    .eq("external_item_id", String(itemId))
    .eq("sync_enabled", true);

  if (variationId != null) {
    query = query.eq("variation_id", String(variationId));
  }

  let { data, error } = await query.limit(1).maybeSingle();

  if (error) {
    throw new Error(`Erro buscando vínculo de estoque: ${error.message}`);
  }

  if (!data && variationId != null) {
    const fallback = await supabase
      .from("inventory_marketplace_links")
      .select("id,product_id,external_item_id,variation_id,seller_sku,sync_enabled")
      .eq("marketplace", "mercadolivre")
      .eq("external_item_id", String(itemId))
      .is("variation_id", null)
      .eq("sync_enabled", true)
      .limit(1)
      .maybeSingle();

    if (fallback.error) {
      throw new Error(`Erro buscando vínculo fallback: ${fallback.error.message}`);
    }

    data = fallback.data;
  }

  return data;
}

async function processStockForMarketplaceOrder(marketplaceOrderId) {
  const { data: order, error: orderError } = await supabase
    .from("marketplace_orders")
    .select("id,marketplace_order_id,status,raw_data")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(marketplaceOrderId))
    .maybeSingle();

  if (orderError) {
    throw new Error(`Erro lendo pedido para estoque: ${orderError.message}`);
  }

  if (!order) {
    return { processed: false, reason: "order_not_found", movements: [] };
  }

  const items = Array.isArray(order.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];

  const movements = [];
  const missingLinks = [];

  for (let index = 0; index < items.length; index++) {
    const orderItem = items[index];
    const itemId = orderItem?.item?.id;
    const variationId = orderItem?.item?.variation_id ?? null;
    const soldQuantity = Number(orderItem?.quantity || 0);

    if (!itemId || soldQuantity <= 0) continue;

    const link = await findInventoryLink(itemId, variationId);

    if (!link) {
      missingLinks.push({ item_id: itemId, variation_id: variationId });
      continue;
    }

    const targets = await resolveStockTargets(link.product_id, soldQuantity);

    for (const target of targets) {
      const baseKey = `ml:${marketplaceOrderId}:${itemId}:${variationId || 0}:${index}:${target.product_id}`;

      if (order.status === "paid") {
        await createStockMovement({
          productId: target.product_id,
          quantity: -Math.abs(target.quantity),
          movementType: "sale",
          unitCost: target.unit_cost,
          referenceType: "mercadolivre_order",
          referenceId: marketplaceOrderId,
          marketplaceOrderId,
          idempotencyKey: `${baseKey}:sale`,
          notes: `Baixa automática venda Mercado Livre ${marketplaceOrderId}`,
          metadata: { item_id: itemId, variation_id: variationId }
        });

        movements.push({ sku: target.sku, quantity: -Math.abs(target.quantity), type: "sale" });
      }

      if (order.status === "cancelled") {
        const { data: saleMovement } = await supabase
          .from("inventory_movements")
          .select("id")
          .eq("idempotency_key", `${baseKey}:sale`)
          .maybeSingle();

        if (saleMovement) {
          await createStockMovement({
            productId: target.product_id,
            quantity: Math.abs(target.quantity),
            movementType: "cancellation_return",
            unitCost: target.unit_cost,
            referenceType: "mercadolivre_order",
            referenceId: marketplaceOrderId,
            marketplaceOrderId,
            idempotencyKey: `${baseKey}:cancel-return`,
            notes: `Estorno automático de estoque por cancelamento ML ${marketplaceOrderId}`,
            metadata: { item_id: itemId, variation_id: variationId }
          });

          movements.push({ sku: target.sku, quantity: Math.abs(target.quantity), type: "cancellation_return" });
        }
      }
    }
  }

  return {
    processed: true,
    order_id: marketplaceOrderId,
    status: order.status,
    movements,
    missing_links: missingLinks
  };
}


module.exports = {
  getStockBalance,
  resolveStockTargets,
  createStockMovement,
  findInventoryLink,
  processStockForMarketplaceOrder
};
