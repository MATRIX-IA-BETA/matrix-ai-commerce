const { supabase } = require("../db/supabase");
const { nowIso } = require("../utils/common");

async function upsertCustomerFromMarketplaceOrder(marketplaceOrderId, overrides = {}) {
  const { data: order, error } = await supabase
    .from("marketplace_orders")
    .select("marketplace_order_id,buyer_id,buyer_nickname,raw_data")
    .eq("marketplace", "mercadolivre")
    .eq("marketplace_order_id", String(marketplaceOrderId))
    .maybeSingle();

  if (error) {
    throw new Error(`Erro lendo pedido para cliente: ${error.message}`);
  }

  if (!order) {
    throw new Error("Pedido não encontrado.");
  }

  const buyer = order.raw_data?.buyer || {};
  const shipping = order.raw_data?.shipping || {};
  const receiver = shipping?.receiver_address || {};

  const customer = {
    source: "mercadolivre",
    marketplace_buyer_id: String(order.buyer_id || buyer.id || "") || null,
    marketplace_nickname: order.buyer_nickname || buyer.nickname || null,
    name: overrides.name || buyer.first_name || buyer.nickname || order.buyer_nickname || "Cliente Mercado Livre",
    email: overrides.email || buyer.email || null,
    phone: overrides.phone || buyer.phone?.number || null,
    document_type: overrides.document_type || null,
    document_number: overrides.document_number || null,
    address_line: overrides.address_line || receiver.address_line || receiver.street_name || null,
    address_number: overrides.address_number || receiver.street_number || null,
    neighborhood: overrides.neighborhood || receiver.neighborhood?.name || null,
    city: overrides.city || receiver.city?.name || null,
    state: overrides.state || receiver.state?.id || receiver.state?.name || null,
    zip_code: overrides.zip_code || receiver.zip_code || null,
    country: overrides.country || "BR",
    raw_data: { buyer, shipping, overrides },
    updated_at: nowIso()
  };

  let existing = null;

  if (customer.document_number) {
    const found = await supabase
      .from("customers")
      .select("id")
      .eq("document_number", customer.document_number)
      .limit(1)
      .maybeSingle();
    existing = found.data;
  }

  if (!existing && customer.marketplace_buyer_id) {
    const found = await supabase
      .from("customers")
      .select("id")
      .eq("marketplace_buyer_id", customer.marketplace_buyer_id)
      .limit(1)
      .maybeSingle();
    existing = found.data;
  }

  if (existing) {
    const { data, error: updateError } = await supabase
      .from("customers")
      .update(customer)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (updateError) throw new Error(`Erro atualizando cliente: ${updateError.message}`);
    return data;
  }

  const { data, error: insertError } = await supabase
    .from("customers")
    .insert(customer)
    .select("*")
    .single();

  if (insertError) throw new Error(`Erro criando cliente: ${insertError.message}`);
  return data;
}


module.exports = { upsertCustomerFromMarketplaceOrder };
