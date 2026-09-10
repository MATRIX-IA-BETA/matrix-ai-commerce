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

async function getProduct(productId) {
  const { data, error } = await supabase
    .from("inventory_products")
    .select("id,sku,name,product_type,average_cost,active")
    .eq("id", productId)
    .single();

  if (error) {
    throw new Error(`Produto de estoque não encontrado: ${error.message}`);
  }

  return data;
}

async function getProductsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const { data, error } = await supabase
    .from("inventory_products")
    .select("id,sku,name,product_type,average_cost,active")
    .in("id", uniqueIds);

  if (error) {
    throw new Error(`Erro lendo produtos do kit: ${error.message}`);
  }

  return new Map((data || []).map(row => [Number(row.id), row]));
}

async function getBalancesByIds(ids) {
  const uniqueIds = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  const { data, error } = await supabase
    .from("inventory_stock")
    .select("product_id,on_hand,reserved,available")
    .in("product_id", uniqueIds);

  if (error) {
    throw new Error(`Erro consultando saldos do kit: ${error.message}`);
  }

  return new Map((data || []).map(row => [Number(row.product_id), row]));
}

async function readBomDefinition(parentProductId) {
  const { data: components, error: bomError } = await supabase
    .from("inventory_bom_components")
    .select("id,parent_product_id,component_product_id,quantity,notes")
    .eq("parent_product_id", parentProductId)
    .order("id", { ascending: true });

  if (bomError) {
    throw new Error(`Erro lendo composição do kit: ${bomError.message}`);
  }

  const componentRows = components || [];
  if (!componentRows.length) {
    return { components: [], substitutes: [] };
  }

  const componentIds = componentRows.map(row => Number(row.id));
  const { data: substitutes, error: substitutesError } = await supabase
    .from("inventory_bom_substitutes")
    .select("id,bom_component_id,substitute_product_id,priority,quantity_factor,notes,active")
    .in("bom_component_id", componentIds)
    .eq("active", true)
    .order("priority", { ascending: true })
    .order("id", { ascending: true });

  if (substitutesError) {
    throw new Error(`Erro lendo substitutos do kit: ${substitutesError.message}`);
  }

  return {
    components: componentRows,
    substitutes: substitutes || []
  };
}

async function previewStockTargets(productId, multiplier = 1) {
  const product = await getProduct(productId);
  const factor = Number(multiplier || 0);

  if (!(factor > 0)) {
    throw new Error("A quantidade do kit precisa ser maior que zero.");
  }

  if (product.product_type !== "kit") {
    const balance = await getStockBalance(product.id);
    const required = factor;
    const available = Number(balance.available || 0);

    return {
      product,
      multiplier: factor,
      lines: [{
        decision_key: `product:${product.id}`,
        bom_component_id: null,
        primary: {
          product_id: Number(product.id),
          sku: product.sku,
          name: product.name,
          unit_cost: Number(product.average_cost || 0),
          available
        },
        required_quantity: required,
        shortage: available < required,
        substitutes: []
      }],
      requires_decision: available < required
    };
  }

  const bom = await readBomDefinition(product.id);

  // Enquanto um kit ainda não tiver composição, ele é tratado como uma unidade
  // própria. Isso preserva o comportamento existente sem inventar componentes.
  if (!bom.components.length) {
    const balance = await getStockBalance(product.id);
    const required = factor;
    const available = Number(balance.available || 0);

    return {
      product,
      multiplier: factor,
      lines: [{
        decision_key: `product:${product.id}`,
        bom_component_id: null,
        primary: {
          product_id: Number(product.id),
          sku: product.sku,
          name: product.name,
          unit_cost: Number(product.average_cost || 0),
          available
        },
        required_quantity: required,
        shortage: available < required,
        substitutes: []
      }],
      requires_decision: available < required
    };
  }

  const substituteIds = bom.substitutes.map(row => Number(row.substitute_product_id));
  const primaryIds = bom.components.map(row => Number(row.component_product_id));
  const productsById = await getProductsByIds([...primaryIds, ...substituteIds]);
  const balancesById = await getBalancesByIds([...primaryIds, ...substituteIds]);
  const substitutesByComponent = new Map();

  for (const substitute of bom.substitutes) {
    const key = Number(substitute.bom_component_id);
    if (!substitutesByComponent.has(key)) substitutesByComponent.set(key, []);
    substitutesByComponent.get(key).push(substitute);
  }

  const lines = bom.components.map(component => {
    const primaryId = Number(component.component_product_id);
    const primaryProduct = productsById.get(primaryId) || {};
    const primaryBalance = balancesById.get(primaryId) || {};
    const required = Number(component.quantity || 0) * factor;
    const primaryAvailable = Number(primaryBalance.available || 0);

    const substitutes = (substitutesByComponent.get(Number(component.id)) || []).map(row => {
      const substituteId = Number(row.substitute_product_id);
      const substituteProduct = productsById.get(substituteId) || {};
      const substituteBalance = balancesById.get(substituteId) || {};
      const quantityFactor = Number(row.quantity_factor || 1);
      const substituteRequired = required * quantityFactor;
      const substituteAvailable = Number(substituteBalance.available || 0);

      return {
        substitute_id: Number(row.id),
        product_id: substituteId,
        sku: substituteProduct.sku || null,
        name: substituteProduct.name || null,
        unit_cost: Number(substituteProduct.average_cost || 0),
        priority: Number(row.priority || 1),
        quantity_factor: quantityFactor,
        required_quantity: substituteRequired,
        available: substituteAvailable,
        can_cover: substituteAvailable >= substituteRequired
      };
    });

    return {
      decision_key: `bom:${component.id}`,
      bom_component_id: Number(component.id),
      primary: {
        product_id: primaryId,
        sku: primaryProduct.sku || null,
        name: primaryProduct.name || null,
        unit_cost: Number(primaryProduct.average_cost || 0),
        available: primaryAvailable
      },
      required_quantity: required,
      shortage: primaryAvailable < required,
      substitutes,
      suggested_substitute_product_id: substitutes.find(item => item.can_cover)?.product_id || null
    };
  });

  return {
    product,
    multiplier: factor,
    lines,
    requires_decision: lines.some(line => line.shortage)
  };
}

async function resolveStockTargets(productId, multiplier = 1) {
  const preview = await previewStockTargets(productId, multiplier);
  return preview.lines.map(line => ({
    product_id: line.primary.product_id,
    sku: line.primary.sku,
    name: line.primary.name,
    quantity: Number(line.required_quantity),
    unit_cost: Number(line.primary.unit_cost || 0)
  }));
}

function resolvePreviewWithDecisions(preview, decisions = [], itemIndex = 0) {
  const targets = [];
  const unresolved = [];

  for (const line of preview.lines) {
    const orderDecisionKey = `item:${itemIndex}:${line.decision_key}`;

    if (!line.shortage) {
      targets.push({
        decision_key: orderDecisionKey,
        product_id: line.primary.product_id,
        sku: line.primary.sku,
        name: line.primary.name,
        quantity: Number(line.required_quantity),
        unit_cost: Number(line.primary.unit_cost || 0),
        action: "primary",
        substituted_from_product_id: null
      });
      continue;
    }

    const decision = (decisions || []).find(candidate =>
      String(candidate?.decision_key || "") === orderDecisionKey
    );

    if (!decision) {
      unresolved.push({
        ...line,
        decision_key: orderDecisionKey,
        allowed_actions: line.substitutes.some(item => item.can_cover)
          ? ["substitute", "negative"]
          : ["negative"]
      });
      continue;
    }

    if (decision.action === "negative") {
      targets.push({
        decision_key: orderDecisionKey,
        product_id: line.primary.product_id,
        sku: line.primary.sku,
        name: line.primary.name,
        quantity: Number(line.required_quantity),
        unit_cost: Number(line.primary.unit_cost || 0),
        action: "negative",
        substituted_from_product_id: null
      });
      continue;
    }

    if (decision.action === "substitute") {
      const substituteProductId = Number(decision.substitute_product_id || 0);
      const substitute = line.substitutes.find(item =>
        Number(item.product_id) === substituteProductId
      );

      if (!substitute) {
        unresolved.push({
          ...line,
          decision_key: orderDecisionKey,
          error: "Substituto escolhido não pertence à composição deste kit."
        });
        continue;
      }

      if (!substitute.can_cover) {
        unresolved.push({
          ...line,
          decision_key: orderDecisionKey,
          error: "O substituto escolhido também não possui saldo suficiente."
        });
        continue;
      }

      targets.push({
        decision_key: orderDecisionKey,
        product_id: substitute.product_id,
        sku: substitute.sku,
        name: substitute.name,
        quantity: Number(substitute.required_quantity),
        unit_cost: Number(substitute.unit_cost || 0),
        action: "substitute",
        substituted_from_product_id: line.primary.product_id
      });
      continue;
    }

    unresolved.push({
      ...line,
      decision_key: orderDecisionKey,
      error: "Escolha usar o substituto ou permitir estoque negativo."
    });
  }

  return { targets, unresolved };
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

async function returnCancelledOrderStock(marketplaceOrderId, confirmed) {
  const { data: sales, error } = await supabase
    .from("inventory_movements")
    .select("id,product_id,quantity,unit_cost,metadata")
    .eq("marketplace_order_id", String(marketplaceOrderId))
    .eq("movement_type", "sale")
    .order("id", { ascending: true });

  if (error) {
    throw new Error(`Erro lendo baixas anteriores do pedido: ${error.message}`);
  }

  if (!confirmed) {
    return {
      processed: false,
      reason: "manual_confirmation_required",
      order_id: marketplaceOrderId,
      status: "cancelled",
      action: "return_cancelled_sale",
      sale_movements_to_reverse: sales || []
    };
  }

  const movements = [];
  for (const sale of sales || []) {
    const quantity = Math.abs(Number(sale.quantity || 0));
    if (!quantity) continue;

    await createStockMovement({
      productId: sale.product_id,
      quantity,
      movementType: "cancellation_return",
      unitCost: sale.unit_cost,
      referenceType: "mercadolivre_order",
      referenceId: marketplaceOrderId,
      marketplaceOrderId,
      idempotencyKey: `ml:${marketplaceOrderId}:movement:${sale.id}:cancel-return`,
      notes: `Estorno manual de estoque por cancelamento ML ${marketplaceOrderId}`,
      metadata: {
        original_sale_movement_id: sale.id,
        ...(sale.metadata || {})
      }
    });

    movements.push({
      product_id: sale.product_id,
      quantity,
      type: "cancellation_return"
    });
  }

  return {
    processed: true,
    order_id: marketplaceOrderId,
    status: "cancelled",
    movements,
    missing_links: []
  };
}

async function processStockForMarketplaceOrder(marketplaceOrderId, options = {}) {
  const confirmed = options.confirmed === true;
  const decisions = Array.isArray(options.decisions) ? options.decisions : [];

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

  if (order.status === "cancelled") {
    return returnCancelledOrderStock(marketplaceOrderId, confirmed);
  }

  if (order.status !== "paid") {
    return {
      processed: false,
      reason: "order_status_not_eligible",
      order_id: marketplaceOrderId,
      status: order.status,
      movements: []
    };
  }

  const items = Array.isArray(order.raw_data?.order_items)
    ? order.raw_data.order_items
    : [];

  const missingLinks = [];
  const itemPlans = [];

  for (let index = 0; index < items.length; index++) {
    const orderItem = items[index];
    const itemId = orderItem?.item?.id;
    const variationId = orderItem?.item?.variation_id ?? null;
    const soldQuantity = Number(orderItem?.quantity || 0);

    if (!itemId || soldQuantity <= 0) continue;

    const link = await findInventoryLink(itemId, variationId);

    if (!link) {
      missingLinks.push({
        item_index: index,
        item_id: itemId,
        variation_id: variationId
      });
      continue;
    }

    const preview = await previewStockTargets(link.product_id, soldQuantity);
    const contextualLines = preview.lines.map(line => ({
      ...line,
      decision_key: `item:${index}:${line.decision_key}`,
      item_index: index,
      item_id: itemId,
      variation_id: variationId,
      sold_quantity: soldQuantity
    }));

    itemPlans.push({
      item_index: index,
      item_id: itemId,
      variation_id: variationId,
      sold_quantity: soldQuantity,
      linked_product_id: link.product_id,
      product: preview.product,
      lines: contextualLines
    });
  }

  const preview = {
    order_id: marketplaceOrderId,
    status: order.status,
    items: itemPlans,
    missing_links: missingLinks,
    requires_stock_decision: itemPlans.some(plan => plan.lines.some(line => line.shortage))
  };

  // Regra de segurança da fase atual: nunca baixa um pedido apenas porque a rota
  // foi chamada. Primeiro devolve a prévia; uma segunda chamada precisa trazer
  // confirmed=true e as decisões para cada falta de estoque.
  if (!confirmed) {
    return {
      processed: false,
      reason: "manual_confirmation_required",
      preview,
      movements: []
    };
  }

  if (missingLinks.length) {
    return {
      processed: false,
      reason: "missing_inventory_links",
      preview,
      movements: []
    };
  }

  const targetsByItem = [];
  const unresolved = [];

  for (const plan of itemPlans) {
    // resolvePreviewWithDecisions cria a mesma chave de contexto usada na prévia.
    const rawPreview = {
      product: plan.product,
      multiplier: plan.sold_quantity,
      lines: plan.lines.map(line => ({
        ...line,
        decision_key: String(line.decision_key).replace(`item:${plan.item_index}:`, "")
      }))
    };

    const resolved = resolvePreviewWithDecisions(
      rawPreview,
      decisions,
      plan.item_index
    );

    unresolved.push(...resolved.unresolved.map(line => ({
      ...line,
      item_id: plan.item_id,
      variation_id: plan.variation_id
    })));

    targetsByItem.push({
      ...plan,
      targets: resolved.targets
    });
  }

  if (unresolved.length) {
    return {
      processed: false,
      reason: "stock_decision_required",
      preview,
      decisions_required: unresolved,
      movements: []
    };
  }

  const movements = [];

  for (const plan of targetsByItem) {
    for (const target of plan.targets) {
      // A chave usa o componente primário, não o produto substituto escolhido.
      // Assim a mesma linha do pedido não pode ser baixada duas vezes mudando
      // apenas a decisão de substituição em uma nova tentativa.
      const primaryId = target.substituted_from_product_id || target.product_id;
      const baseKey = `ml:${marketplaceOrderId}:${plan.item_id}:${plan.variation_id || 0}:${plan.item_index}:component:${primaryId}`;

      await createStockMovement({
        productId: target.product_id,
        quantity: -Math.abs(target.quantity),
        movementType: "sale",
        unitCost: target.unit_cost,
        referenceType: "mercadolivre_order",
        referenceId: marketplaceOrderId,
        marketplaceOrderId,
        idempotencyKey: `${baseKey}:sale`,
        notes: `Baixa manual venda Mercado Livre ${marketplaceOrderId}`,
        metadata: {
          item_id: plan.item_id,
          variation_id: plan.variation_id,
          decision_key: target.decision_key,
          stock_decision: target.action,
          substituted_from_product_id: target.substituted_from_product_id
        }
      });

      movements.push({
        sku: target.sku,
        product_id: target.product_id,
        quantity: -Math.abs(target.quantity),
        type: "sale",
        stock_decision: target.action,
        substituted_from_product_id: target.substituted_from_product_id
      });
    }
  }

  return {
    processed: true,
    order_id: marketplaceOrderId,
    status: order.status,
    movements,
    missing_links: []
  };
}

module.exports = {
  getStockBalance,
  previewStockTargets,
  resolveStockTargets,
  createStockMovement,
  findInventoryLink,
  processStockForMarketplaceOrder
};
